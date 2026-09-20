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
	PreparedDispatchItem,
	PreparedSubagentDispatch,
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
}

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
		},
	};
}
