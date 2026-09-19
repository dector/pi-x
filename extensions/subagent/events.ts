import type { Message } from "@earendil-works/pi-ai";
import type { RpcStreamEvent, SingleResult, UsageStats } from "./types.ts";

export interface RpcStreamState {
	liveText: string;
	settled: boolean;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function recordMessage(result: SingleResult, message: Message): void {
	result.messages.push(message);
	if (message.role !== "assistant") return;
	result.usage.turns++;
	const usage = message.usage;
	if (usage) {
		result.usage.input += usage.input || 0;
		result.usage.output += usage.output || 0;
		result.usage.cacheRead += usage.cacheRead || 0;
		result.usage.cacheWrite += usage.cacheWrite || 0;
		result.usage.cost += usage.cost?.total || 0;
		result.usage.contextTokens = usage.totalTokens || 0;
	}
	if (!result.model && message.model) result.model = message.model;
	if (message.stopReason) result.stopReason = message.stopReason;
	if (message.errorMessage) result.errorMessage = message.errorMessage;
}

export function applyRpcStreamEvent(result: SingleResult, state: RpcStreamState, event: RpcStreamEvent): boolean {
	switch (event.type) {
		case "agent_start":
			result.state = "running";
			return true;
		case "message_update": {
			const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
			if (update?.type !== "text_delta" || typeof update.delta !== "string") return false;
			state.liveText += update.delta;
			result.liveText = state.liveText;
			return true;
		}
		case "message_end":
			if (!event.message || typeof event.message !== "object") return false;
			recordMessage(result, event.message as Message);
			state.liveText = "";
			result.liveText = undefined;
			return true;
		case "tool_execution_start":
		case "tool_execution_update":
			result.activeTool = typeof event.toolName === "string" ? event.toolName : undefined;
			return true;
		case "tool_execution_end":
			result.activeTool = undefined;
			return true;
		case "agent_settled":
			state.settled = true;
			result.state = "settled";
			return true;
		case "agent_end":
			if (event.willRetry === true) return false;
			state.settled = true;
			result.state = "settled";
			return true;
		case "extension_error": {
			const error = typeof event.error === "string" ? event.error : "Unknown extension error";
			const diagnostics = (result.diagnostics ??= []);
			if (diagnostics.length < 20) diagnostics.push(error);
			return true;
		}
		default:
			return false;
	}
}
