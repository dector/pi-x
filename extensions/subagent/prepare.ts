/**
 * Stage 2 preparation path.
 *
 * One validated path builds a `PreparedSubagentDispatch` for every request,
 * blocking or (later) async. Everything predictable is resolved here, before a
 * child can start:
 *
 *   - mode validation (exactly one of single/parallel/chain);
 *   - parallel task-count limit;
 *   - agent discovery and unknown-agent rejection;
 *   - project-agent permission approval;
 *   - dispatch/run ID allocation (all items, including later chain steps);
 *   - model/thinking/cwd/safe-mode snapshot.
 *
 * Failures return a canonical tool result with empty results, so nothing is
 * persisted as a started run and no child is spawned. IDs and the safe-mode
 * snapshot are only resolved after validation and permission succeed.
 *
 * All external effects are injected (`PreparationDependencies`) so the path can
 * be unit tested without the Pi runtime. This module intentionally has no
 * runtime imports, keeping it loadable from `bun test`.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentConfig, AgentDiscoveryResult, AgentScope } from "./agents.ts";
import type { SafeModeSnapshot } from "./safe-mode.ts";
import type {
	HerdrRetention,
	PreparedDispatchItem,
	PreparedSubagentDispatch,
	SubagentBackendKind,
	SubagentDetails,
	SubagentDispatchStatus,
	SubagentExecution,
	SubagentMode,
} from "./types.ts";

/** Maximum number of parallel tasks accepted at preparation time. */
export const MAX_PARALLEL_TASKS = 8;

/** Hub `what` value for the project-agent permission request. */
export const PERMISSION_AGENT_WHAT = "perm:agent";

export interface SubagentTaskInput {
	agent: string;
	task: string;
	cwd?: string;
}

/** Explicit Herdr opt-in. Presence of the object selects the Herdr backend. */
export interface HerdrRequest {
	/** Defaults to `"failed"`: recycle success, keep failed/aborted panes. */
	retain?: HerdrRetention;
}

/** Raw tool arguments. Mirrors the tool's TypeBox schema. */
export interface SubagentRequest {
	agent?: string;
	task?: string;
	cwd?: string;
	tasks?: SubagentTaskInput[];
	chain?: SubagentTaskInput[];
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	/** Omitted means `"async"`; only an explicit `"blocking"` opts into awaiting. */
	execution?: SubagentExecution;
	/** Present means run behind the Herdr pane bridge instead of a direct child. */
	herdr?: HerdrRequest;
}

/** Result of the injected Herdr preflight: a backend choice or a clear failure. */
export type HerdrPreflightOutcome =
	| { ok: true; retention: HerdrRetention }
	| { ok: false; error: string };

/** Parent context snapshotted into the prepared dispatch. */
export interface PreparationContext {
	/** Working directory of the parent session. */
	cwd: string;
	/** Resolved parent model as `provider/id`. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface PreparationDependencies {
	discoverAgents: (cwd: string, scope: AgentScope) => AgentDiscoveryResult;
	/** Ask the hub for a project-agent decision; anything but `"allow"` is denial. */
	requestPermission: (what: string, data: Record<string, unknown>) => Promise<string | undefined>;
	snapshotSafeMode: () => Promise<SafeModeSnapshot | undefined>;
	/**
	 * Validate Herdr and prepare the parent tab before a dispatch is accepted.
	 * Only called when the request carries `herdr`.
	 */
	preflightHerdr?: (request: HerdrRequest) => Promise<HerdrPreflightOutcome>;
	nextDispatchId: () => string;
	nextRunId: () => string;
	context: PreparationContext;
}

export type PreparationResult =
	| { ok: true; dispatch: PreparedSubagentDispatch }
	| { ok: false; result: AgentToolResult<SubagentDetails> };

interface ResolvedItem {
	agent: string;
	task: string;
	cwd?: string;
	step?: number;
}

const HERDR_REQUEST_KEYS = new Set(["retain"]);

/**
 * Validate the public `herdr` object. Returns the resolved retention intent, or
 * a model-visible error for a non-object, unknown option, or invalid `retain`.
 */
export function parseHerdrRequest(
	value: unknown,
): { ok: true; request: HerdrRequest; retention: HerdrRetention } | { ok: false; error: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: 'Subagent "herdr" must be an object such as {} or { retain: "always" }.' };
	}
	const record = value as Record<string, unknown>;
	const unknown = Object.keys(record).filter((key) => !HERDR_REQUEST_KEYS.has(key));
	if (unknown.length > 0) {
		return { ok: false, error: `Unknown herdr option(s): ${unknown.join(", ")}. Supported: retain.` };
	}
	const retain = record.retain;
	if (retain !== undefined && retain !== "failed" && retain !== "always") {
		return {
			ok: false,
			error: `Invalid herdr retention ${JSON.stringify(retain)}. Use "failed" or "always".`,
		};
	}
	const resolved: HerdrRetention = retain ?? "failed";
	return { ok: true, request: retain !== undefined ? { retain } : {}, retention: resolved };
}

/**
 * Validate a request and produce a fully-allocated prepared dispatch, or a
 * canonical failure result. The caller must not create runtime state, allocate
 * IDs, or start a child before this resolves.
 */
export async function prepareSubagentDispatch(
	request: SubagentRequest,
	deps: PreparationDependencies,
): Promise<PreparationResult> {
	const agentScope: AgentScope = request.agentScope ?? "user";
	// Async is the default for every capability, including editing agents.
	const execution: SubagentExecution = request.execution === "blocking" ? "blocking" : "async";
	const discovery = deps.discoverAgents(deps.context.cwd, agentScope);
	const agents = discovery.agents;
	const availableAgents = agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";

	const fail = (
		text: string,
		failureMode: SubagentMode,
		status: SubagentDispatchStatus,
		isError = false,
	): PreparationResult => ({
		ok: false,
		result: {
			content: [{ type: "text", text }],
			details: {
				mode: failureMode,
				execution,
				dispatchStatus: status,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				results: [],
			},
			...(isError ? { isError: true as const } : {}),
		},
	});

	const hasChain = (request.chain?.length ?? 0) > 0;
	const hasTasks = (request.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(request.agent && request.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
	const mode: SubagentMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";

	if (modeCount !== 1) {
		return fail(
			`Invalid parameters. Provide exactly one mode.\nAvailable agents: ${availableAgents}`,
			"single",
			"failed",
		);
	}

	if (hasTasks && request.tasks && request.tasks.length > MAX_PARALLEL_TASKS) {
		return fail(
			`Too many parallel tasks (${request.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
			"parallel",
			"failed",
		);
	}

	// Validate the explicit Herdr opt-in shape early so a bad request never
	// reaches permission prompts or preflight. The object's presence alone is
	// what selects the backend.
	const herdrIntent = request.herdr === undefined ? undefined : parseHerdrRequest(request.herdr);
	if (herdrIntent && !herdrIntent.ok) {
		return fail(herdrIntent.error, mode, "failed", true);
	}
	let backend: SubagentBackendKind | undefined;
	let herdrRetention: HerdrRetention | undefined;

	const resolvedItems: ResolvedItem[] = hasChain
		? (request.chain ?? []).map((step, index) => ({
				agent: step.agent,
				task: step.task,
				cwd: step.cwd,
				step: index + 1,
			}))
		: hasTasks
			? (request.tasks ?? []).map((task) => ({ agent: task.agent, task: task.task, cwd: task.cwd }))
			: [{ agent: request.agent as string, task: request.task as string, cwd: request.cwd }];

	const unknownAgents: string[] = [];
	for (const item of resolvedItems) {
		if (unknownAgents.includes(item.agent)) continue;
		if (!agents.some((agent) => agent.name === item.agent)) unknownAgents.push(item.agent);
	}
	if (unknownAgents.length > 0) {
		const label =
			unknownAgents.length === 1
				? `Unknown agent: ${JSON.stringify(unknownAgents[0])}`
				: `Unknown agents: ${unknownAgents.map((name) => JSON.stringify(name)).join(", ")}`;
		return fail(`${label}. Available agents: ${availableAgents}.`, mode, "failed", true);
	}

	const confirmProjectAgents = request.confirmProjectAgents ?? true;
	if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents) {
		const requestedNames = [...new Set(resolvedItems.map((item) => item.agent))];
		const projectAgentsRequested = requestedNames
			.map((name) => agents.find((agent) => agent.name === name))
			.filter((agent): agent is AgentConfig => agent?.source === "project");

		if (projectAgentsRequested.length > 0) {
			const decision = await deps.requestPermission(PERMISSION_AGENT_WHAT, {
				agents: projectAgentsRequested.map((agent) => agent.name).join(", "),
				source: discovery.projectAgentsDir ?? "(unknown)",
				cwd: deps.context.cwd,
			});
			if (decision !== "allow") {
				return fail("Canceled: project-local agents not approved.", mode, "aborted");
			}
		}
	}

	// Herdr preflight runs after permission and before any ID is allocated or
	// child is started, so an unavailable server/pane fails before acceptance.
	if (herdrIntent?.ok) {
		if (!deps.preflightHerdr) {
			return fail("Herdr was requested, but the Herdr backend is not available in this session.", mode, "failed", true);
		}
		const preflight = await deps.preflightHerdr(herdrIntent.request);
		if (!preflight.ok) return fail(preflight.error, mode, "failed", true);
		backend = "herdr";
		herdrRetention = preflight.retention;
	}

	const items: PreparedDispatchItem[] = resolvedItems.map((item) => ({
		runId: deps.nextRunId(),
		agent: item.agent,
		task: item.task,
		...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
		...(item.step !== undefined ? { step: item.step } : {}),
	}));

	const dispatchId = deps.nextDispatchId();
	const safeModeSnapshot = await deps.snapshotSafeMode();

	return {
		ok: true,
		dispatch: {
			dispatchId,
			execution,
			mode,
			agentScope,
			projectAgentsDir: discovery.projectAgentsDir,
			agents,
			dispatchDefaults: {
				model: deps.context.model,
				thinkingLevel: deps.context.thinkingLevel,
			},
			cwd: deps.context.cwd,
			safeModeSnapshot,
			items,
			...(backend ? { backend } : {}),
			...(herdrRetention ? { herdrRetention } : {}),
		},
	};
}
