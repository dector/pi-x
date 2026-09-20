import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig, AgentScope } from "./agents.ts";
import type { SafeMode, SafeModeSnapshot } from "./safe-mode.ts";
import type { SubagentTiming } from "./timing.ts";

/** A child approval request and how the user answered it. */
export interface ResolvedApproval {
	requestId: string;
	method: string;
	title?: string;
	state: "approved" | "denied";
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type SubagentRunState =
	| "starting"
	| "running"
	| "pause-requested"
	| "paused"
	| "waiting-approval"
	| "resuming"
	| "settled"
	| "aborting"
	| "failed";

export type ToolRunStatus = "running" | "waiting-approval" | "approved" | "completed" | "blocked" | "failed" | "interrupted";

export interface ToolRunRecord {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	status: ToolRunStatus;
	summary?: string;
}

export type SubagentExecution = "async" | "blocking";
export type SubagentDispatchStatus = "started" | "completed" | "failed" | "aborted";
export type SubagentMode = "single" | "parallel" | "chain";

/** Model/thinking defaults snapshotted for a dispatch when it is prepared. */
export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/** One fully-allocated task in a prepared dispatch. */
export interface PreparedDispatchItem {
	runId: string;
	agent: string;
	task: string;
	cwd?: string;
	step?: number;
}

/**
 * A validated dispatch with all run IDs allocated, ready for either blocking
 * execution or detaching into the background (Stage 2+).
 *
 * `cwd`, `dispatchDefaults`, and `safeModeSnapshot` are the configuration
 * values snapshotted at preparation time. Reusing them for every item keeps one
 * dispatch internally consistent and stops later parent context changes (or a
 * second safe-mode query) from leaking into an accepted dispatch.
 */
export interface PreparedSubagentDispatch {
	dispatchId: string;
	execution: SubagentExecution;
	mode: SubagentMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	agents: AgentConfig[];
	dispatchDefaults: DispatchDefaults;
	cwd: string;
	safeModeSnapshot?: SafeModeSnapshot;
	items: PreparedDispatchItem[];
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	/** Working directory the child ran in; carried into completion details. */
	cwd?: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	runId?: string;
	state?: SubagentRunState;
	inheritedMode?: SafeMode;
	effectiveMode?: SafeMode;
	outerAccess?: boolean;
	diagnostics?: string[];
	liveText?: string;
	activeTool?: string;
	toolRuns?: ToolRunRecord[];
	pendingApproval?: { requestId: string; method: string; title?: string };
	/**
	 * Approvals already answered during this run, oldest first. Kept separate
	 * from `pendingApproval` so the attach transcript can show that an approval
	 * happened after the dialog closes. Bounded by the UI request cap.
	 */
	resolvedApprovals?: ResolvedApproval[];
	timing?: SubagentTiming;
}

export type SubagentControlAction = "stop" | "steer";

/**
 * Metadata attached to a tool result that performed a control operation
 * (stop/steer) instead of starting a dispatch. `results` stays empty so a
 * control call never appears as completed history in `/px:agent:log`.
 */
export interface SubagentControlDetails {
	action: SubagentControlAction;
	targetKind: "dispatch" | "run";
	targetId: string;
	/** Runs the action was applied to (steered, or successfully aborted). */
	runIds: string[];
	/** Per-run failures when a partial operation could not reach every run. */
	failures: Array<{ runId: string; error: string }>;
}

/**
 * Persisted/rendered dispatch record.
 *
 * `execution`, `dispatchId`, and `dispatchStatus` are optional so records
 * persisted before the async work keep parsing. Readers normalize missing
 * metadata to the historical blocking/completed meaning; see
 * `completion.ts:normalizeSubagentDetails()`.
 */
export interface SubagentDetails {
	mode: SubagentMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	execution?: SubagentExecution;
	dispatchId?: string;
	dispatchStatus?: SubagentDispatchStatus;
	/** Set only on tool results that performed a stop/steer control call. */
	control?: SubagentControlDetails;
	/**
	 * Every item the dispatch was planned to run, including chain steps that
	 * never started. Optional so records persisted before this field keep
	 * parsing; readers fall back to `results` when it is absent.
	 */
	plannedItems?: PreparedDispatchItem[];
	/** Parent working directory, used to fill in missing per-result cwd. */
	cwd?: string;
	results: SingleResult[];
}

/** `SubagentDetails` with compatibility metadata resolved to concrete values. */
export interface NormalizedSubagentDetails extends SubagentDetails {
	execution: SubagentExecution;
	dispatchStatus: SubagentDispatchStatus;
}

/**
 * Canonical settled-dispatch payload: model-visible text plus the full
 * `SubagentDetails`. Blocking tool results, async completion messages, and
 * persisted log extraction all derive from this shape.
 */
export interface SubagentAggregateResult {
	text: string;
	details: SubagentDetails;
	isError?: boolean;
}

export interface RpcCommand {
	id?: string;
	type: string;
	[key: string]: unknown;
}

export type RpcResponse =
	| { id?: string; type: "response"; command: string; success: true; data?: unknown }
	| { id?: string; type: "response"; command: string; success: false; error: string };

export interface RpcStreamEvent {
	type: string;
	[key: string]: unknown;
}

export interface RpcExtensionUiRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
	[key: string]: unknown;
}

export type RpcExtensionUiResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };
