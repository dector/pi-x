/**
 * Shared formatting helpers for subagent tool calls, usage, and timing.
 *
 * Extracted from `index.ts` so the tool result renderer and the live attach
 * transcript render identical tool/usage strings instead of drifting apart.
 * Kept free of TUI component classes so it is trivial to unit test.
 */

import * as os from "node:os";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isFailedResult } from "./result-output.ts";
import { formatSubagentTiming } from "./timing.ts";
import type { SingleResult, ToolRunStatus } from "./types.ts";

/** Theme foreground callback shared by the tool result and attach renderers. */
export type ThemeFg = (color: any, text: string) => string;

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatResultTiming(result: SingleResult): string | undefined {
	if (result.exitCode === -1 || !result.timing) return undefined;
	const cancelled = result.stopReason === "aborted" || /abort/i.test(result.errorMessage ?? "");
	const outcome = cancelled ? "cancelled" : isFailedResult(result) ? "failed" : "finished";
	return formatSubagentTiming(result.timing, outcome);
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
	thinkingLevel?: ThinkingLevel,
	contextWindow?: number,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0 && contextWindow && contextWindow > 0) {
		parts.push(`ctx:${Math.round((usage.contextTokens / contextWindow) * 100)}%`);
	}
	if (model) parts.push(thinkingLevel ? `${model} (${thinkingLevel})` : model);
	return parts.join(" ");
}

export function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: ThemeFg): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

/** Styled outcome label for a tool run status, shared by both renderers. */
export function formatToolStatus(status: ToolRunStatus, themeFg: ThemeFg): string {
	switch (status) {
		case "completed":
			return themeFg("success", "✓ completed");
		case "blocked":
			return themeFg("warning", "⊘ blocked");
		case "failed":
			return themeFg("error", "✗ failed");
		case "interrupted":
			return themeFg("error", "⚠ interrupted");
		case "waiting-approval":
			return themeFg("warning", "⏸ waiting approval");
		case "approved":
			return themeFg("success", "✓ approved, running");
		default:
			return themeFg("warning", "⏳ running");
	}
}
