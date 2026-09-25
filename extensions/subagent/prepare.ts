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
 *   - restricted-agent permission approval;
 *   - dispatch/run ID allocation (all items, including later chain steps);
 *   - model/thinking/cwd/safe-mode/network-policy snapshot.
 *
 * Failures return a canonical tool result with empty results, so nothing is
 * persisted as a started run and no child is spawned. IDs and the parent
 * snapshots (safe mode, configured network policy) are only resolved after
 * validation and permission succeed.
 *
 * All external effects are injected (`PreparationDependencies`) so the path can
 * be unit tested without the Pi runtime. This module intentionally imports only
 * pure helpers, keeping it loadable from `bun test`.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentConfig, AgentDiscoveryResult, AgentScope } from "./agents.ts";
import type { NetworkPolicySetting } from "./network-policy.ts";
import { collectRestrictedAgentNames, suggestUnrestrictedAgents } from "./restricted-agent-policy.ts";
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
	SubagentRewireConfig,
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

/**
 * A single approval request covering every restricted agent name in one
 * dispatch (single, parallel, or chain). The caller renders the prompt/result
 * from this without re-deriving policy.
 */
export interface RestrictedAgentApprovalRequest {
	mode: SubagentMode;
	/** Requested names that matched a restricted pattern, deduped in input order. */
	restrictedAgents: string[];
	/** The restricted patterns in effect for this dispatch. */
	patterns: string[];
	/**
	 * Deduped unrestricted alternatives across every restricted name, in a stable
	 * merge order: each name's same-family options come first, then its others.
	 */
	alternatives: string[];
}

/**
 * Ask for approval of the restricted agents in a dispatch. Returns `true` only
 * when the user approved; anything else aborts the whole dispatch.
 */
export type RestrictedAgentApprovalCallback = (
	request: RestrictedAgentApprovalRequest,
) => Promise<boolean>;

/** Parent context snapshotted into the prepared dispatch. */
export interface PreparationContext {
	/** Working directory of the parent session. */
	cwd: string;
	/** Resolved parent model as `provider/id`. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Enabled session-only override for every subagent profile. */
	rewire?: SubagentRewireConfig;
}

export interface PreparationDependencies {
	discoverAgents: (cwd: string, scope: AgentScope) => AgentDiscoveryResult;
	/** Ask the hub for a project-agent decision; anything but `"allow"` is denial. */
	requestPermission: (what: string, data: Record<string, unknown>) => Promise<string | undefined>;
	/**
	 * Glob patterns whose matching agent names require extra approval. Omitted or
	 * empty disables the gate, preserving the historical behavior.
	 */
	restrictedAgentPatterns?: readonly string[];
	/**
	 * Ask for approval of restricted agent names. Called at most once per
	 * dispatch, and only when a restricted name is requested. A missing callback
	 * counts as denial so the gate fails closed.
	 */
	requestRestrictedAgentApproval?: RestrictedAgentApprovalCallback;
	snapshotSafeMode: () => Promise<SafeModeSnapshot | undefined>;
	/**
	 * Snapshot the parent's configured network policy so the child can inherit
	 * it. Resolves `undefined` when permissions-core is absent or cannot answer
	 * within the bounded query; the flag is then omitted and the child keeps its
	 * own Auto default. Never allows a policy that was not observed.
	 */
	snapshotNetworkPolicy?: () => Promise<NetworkPolicySetting | undefined>;
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
 * Merge per-name unrestricted alternatives into one list. Each name's
 * `suggestUnrestrictedAgents` result already dedupes and ranks same-family
 * options first; concatenating them in requested order and dropping repeats
 * keeps that order stable across a multi-agent dispatch.
 */
function mergeRestrictedAlternatives(
	restrictedAgents: readonly string[],
	agents: readonly { name: string }[],
	patterns: readonly string[],
): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const name of restrictedAgents) {
		for (const alternative of suggestUnrestrictedAgents(name, agents, patterns)) {
			if (seen.has(alternative)) continue;
			seen.add(alternative);
			merged.push(alternative);
		}
	}
	return merged;
}

/** Model-visible abort text for a denied restricted dispatch. */
function restrictedAgentsNotApprovedText(
	restrictedAgents: readonly string[],
	alternatives: readonly string[],
): string {
	const allowed = alternatives.length > 0 ? alternatives.join(", ") : "none";
	return `Restricted agents not approved: ${restrictedAgents.join(", ")}. Allowed alternatives: ${allowed}. No agents were started.`;
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

	const requestedNames = [...new Set(resolvedItems.map((item) => item.agent))];

	const confirmProjectAgents = request.confirmProjectAgents ?? true;
	if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents) {
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

	// Restricted-agent approval runs after project approval and before Herdr
	// preflight, ID allocation, or any snapshot. One prompt covers the whole
	// dispatch; a missing or non-true answer aborts everything without
	// substituting a different agent.
	const restrictedPatterns = deps.restrictedAgentPatterns ?? [];
	const restrictedAgents = collectRestrictedAgentNames(requestedNames, restrictedPatterns);
	if (restrictedAgents.length > 0) {
		const alternatives = mergeRestrictedAlternatives(restrictedAgents, agents, restrictedPatterns);
		const approvalRequest: RestrictedAgentApprovalRequest = {
			mode,
			restrictedAgents,
			patterns: [...restrictedPatterns],
			alternatives,
		};
		const approved = deps.requestRestrictedAgentApproval
			? await deps.requestRestrictedAgentApproval(approvalRequest)
			: false;
		if (!approved) {
			return fail(restrictedAgentsNotApprovedText(restrictedAgents, alternatives), mode, "aborted");
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
	// Both parent snapshots are independent bounded queries, so they run
	// concurrently: a missing provider costs one timeout, not two.
	const [safeModeSnapshot, networkPolicy] = await Promise.all([
		deps.snapshotSafeMode(),
		deps.snapshotNetworkPolicy?.(),
	]);

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
			...(deps.context.rewire ? { rewire: { ...deps.context.rewire } } : {}),
			cwd: deps.context.cwd,
			safeModeSnapshot,
			...(networkPolicy ? { networkPolicy } : {}),
			items,
			...(backend ? { backend } : {}),
			...(herdrRetention ? { herdrRetention } : {}),
		},
	};
}
