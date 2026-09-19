import type { Message } from "@earendil-works/pi-ai";
import type { RpcStreamEvent, SingleResult, ToolRunRecord, UsageStats } from "./types.ts";

export interface RpcStreamState {
	liveText: string;
	settled: boolean;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function summarizeToolResult(value: unknown): string | undefined {
	if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, 300) || undefined;
	if (!value || typeof value !== "object") return undefined;
	const record = value as { content?: unknown; message?: unknown; error?: unknown };
	if (Array.isArray(record.content)) {
		const text = record.content
			.map((part) => (typeof part === "object" && part && (part as { type?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined))
			.filter((part): part is string => typeof part === "string")
			.join(" ");
		if (text.trim()) return text.replace(/\s+/g, " ").trim().slice(0, 300);
	}
	return summarizeToolResult(record.error) ?? summarizeToolResult(record.message);
}

function looksBlocked(summary: string | undefined): boolean {
	return !!summary && /\b(blocked|denied|not approved|approval required|permission)\b/i.test(summary);
}

function findToolRun(result: SingleResult, toolCallId: string): ToolRunRecord | undefined {
	return result.toolRuns?.find((run) => run.toolCallId === toolCallId);
}

function recordMessage(result: SingleResult, message: Message): void {
	result.messages.push(message);
	if (message.role === "toolResult") {
		const run = findToolRun(result, message.toolCallId);
		if (run) {
			const summary = summarizeToolResult(message);
			run.summary = summary ?? run.summary;
			if (message.isError) run.status = run.status === "blocked" || looksBlocked(summary) ? "blocked" : "failed";
			else run.status = "completed";
		}
		return;
	}
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

export function setLatestToolApprovalState(result: SingleResult, state: "waiting" | "approved" | "denied"): void {
	const run = [...(result.toolRuns ?? [])].reverse().find((item) => item.status === "running" || item.status === "waiting-approval" || item.status === "approved");
	if (!run) return;
	if (state === "waiting") run.status = "waiting-approval";
	else if (state === "approved") run.status = "approved";
	else {
		run.status = "blocked";
		run.summary = "Approval denied";
	}
}

export function interruptActiveTools(result: SingleResult, summary = "Interrupted before completion"): void {
	for (const run of result.toolRuns ?? []) {
		if (run.status === "running" || run.status === "waiting-approval" || run.status === "approved") {
			run.status = "interrupted";
			run.summary = summary;
		}
	}
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
		case "tool_execution_start": {
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : `unknown-${Date.now()}`;
			const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
			const existing = findToolRun(result, toolCallId);
			if (existing) {
				existing.status = "running";
				existing.args = typeof event.args === "object" && event.args ? event.args as Record<string, unknown> : {};
			} else {
				(result.toolRuns ??= []).push({
					toolCallId,
					toolName,
					args: typeof event.args === "object" && event.args ? event.args as Record<string, unknown> : {},
					status: "running",
				});
			}
			result.activeTool = toolName;
			return true;
		}
		case "tool_execution_update":
			result.activeTool = typeof event.toolName === "string" ? event.toolName : result.activeTool;
			return true;
		case "tool_execution_end": {
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
			const run = findToolRun(result, toolCallId);
			if (run) {
				const summary = summarizeToolResult(event.result);
				run.summary = summary ?? run.summary;
				if (event.isError === true) run.status = run.status === "blocked" || looksBlocked(summary) ? "blocked" : "failed";
				else run.status = "completed";
			}
			result.activeTool = undefined;
			return true;
		}
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
