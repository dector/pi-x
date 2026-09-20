import type { RpcStreamEvent } from "./types.ts";

export interface SubagentTiming {
	wallMs: number;
	apiMs: number;
	toolsMs: number;
	overheadMs: number;
}

/**
 * Classifies elapsed wall time from the RPC event stream.
 *
 * Tool intervals are unioned, so parallel tools are not double-counted. Tool
 * time takes precedence over API time if malformed or future event streams
 * overlap the two phases. This keeps every millisecond in exactly one bucket.
 */
export class SubagentTimingTracker {
	private readonly startedAt: number;
	private lastAt: number;
	private apiActive = false;
	private readonly activeTools = new Set<string>();
	private anonymousToolCount = 0;
	private apiMs = 0;
	private toolsMs = 0;
	private overheadMs = 0;

	constructor(now = performance.now()) {
		this.startedAt = now;
		this.lastAt = now;
	}

	record(event: RpcStreamEvent, now = performance.now()): void {
		this.advance(now);
		switch (event.type) {
			case "turn_start":
				this.apiActive = true;
				break;
			case "message_end":
				if (isAssistantMessage(event.message)) this.apiActive = false;
				break;
			case "tool_execution_start":
				if (typeof event.toolCallId === "string") this.activeTools.add(event.toolCallId);
				else this.anonymousToolCount++;
				break;
			case "tool_execution_end":
				if (typeof event.toolCallId === "string") this.activeTools.delete(event.toolCallId);
				else this.anonymousToolCount = Math.max(0, this.anonymousToolCount - 1);
				break;
		}
	}

	finish(now = performance.now()): SubagentTiming {
		this.advance(now);
		return {
			wallMs: Math.max(0, now - this.startedAt),
			apiMs: this.apiMs,
			toolsMs: this.toolsMs,
			overheadMs: this.overheadMs,
		};
	}

	private advance(now: number): void {
		const elapsed = Math.max(0, now - this.lastAt);
		if (this.activeTools.size > 0 || this.anonymousToolCount > 0) this.toolsMs += elapsed;
		else if (this.apiActive) this.apiMs += elapsed;
		else this.overheadMs += elapsed;
		this.lastAt = Math.max(this.lastAt, now);
	}
}

function isAssistantMessage(value: unknown): boolean {
	return typeof value === "object" && value !== null && (value as { role?: unknown }).role === "assistant";
}

export function formatDuration(milliseconds: number): string {
	const ms = Math.max(0, milliseconds);
	if (ms < 100) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return seconds === 60 ? `${minutes + 1}m` : `${minutes}m ${seconds}s`;
}

export function formatSubagentTiming(
	timing: SubagentTiming,
	outcome: "finished" | "failed" | "cancelled" = "finished",
): string {
	const lead = outcome === "finished" ? "Finished in" : outcome === "failed" ? "Failed after" : "Cancelled after";
	return `${lead} ${formatDuration(timing.wallMs)} — API ${formatDuration(timing.apiMs)}, tools ${formatDuration(timing.toolsMs)}, overhead ${formatDuration(timing.overheadMs)}`;
}
