import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope } from "./agents.ts";
import type { SafeMode } from "./safe-mode.ts";
import type { SubagentTiming } from "./timing.ts";

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

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
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
	timing?: SubagentTiming;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
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
