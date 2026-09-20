/**
 * Pure transcript model for the live subagent attach view.
 *
 * `buildTranscript()` turns a live `SingleResult` into an ordered list of
 * display blocks. It is intentionally independent of the TUI so the ordering,
 * pairing, and streaming rules can be unit tested without a terminal.
 *
 * `TranscriptViewport` is the matching pure scroll state machine: it follows
 * the tail by default, stops following when the user scrolls up, and resumes
 * when they return to the bottom.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult, ToolRunStatus } from "./types.ts";

export type TranscriptBlock =
	| { type: "task"; text: string }
	| { type: "assistant"; text: string; streaming?: boolean }
	| { type: "thinking"; text: string; streaming?: boolean }
	| { type: "tool-call"; name: string; args: Record<string, unknown>; status: ToolRunStatus; summary?: string; toolCallId?: string }
	| { type: "tool-result"; text: string; isError?: boolean; toolCallId?: string; name?: string }
	| { type: "approval"; title: string; state: string; method?: string }
	| { type: "diagnostic"; text: string }
	| { type: "status"; text: string };

export interface BuildTranscriptOptions {
	/** Include the leading task block. Defaults to true. */
	includeTask?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Extract concatenated text from a message content string or content array. */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("");
}

function toolRunFor(result: SingleResult, toolCallId: string): { status: ToolRunStatus; summary?: string } | undefined {
	const run = result.toolRuns?.find((item) => item.toolCallId === toolCallId);
	if (!run) return undefined;
	return { status: run.status, summary: run.summary };
}

/**
 * Build the ordered transcript for one run.
 *
 * Assistant text/thinking/tool-call parts are emitted in message order. Tool
 * results are emitted as their own blocks immediately after the message that
 * produced them, paired with the tool call id when available. Answered
 * approvals, a pending approval, diagnostics, a terminal error, and finally the
 * in-progress `liveText` are appended so the transcript stays useful
 * mid-stream.
 */
export function buildTranscript(result: SingleResult, options: BuildTranscriptOptions = {}): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	if (options.includeTask !== false && typeof result.task === "string" && result.task.length > 0) {
		blocks.push({ type: "task", text: result.task });
	}

	const messages: unknown = result.messages;
	if (Array.isArray(messages)) {
		for (const message of messages) {
			if (!isRecord(message)) continue;
			if (message.role === "assistant") {
				const content = message.content;
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (!isRecord(part)) continue;
					if (part.type === "text" && typeof part.text === "string") {
						blocks.push({ type: "assistant", text: part.text });
					} else if (part.type === "thinking" && typeof part.thinking === "string") {
						blocks.push({ type: "thinking", text: part.thinking });
					} else if (part.type === "toolCall" && typeof part.name === "string") {
						const toolCallId = typeof part.id === "string" ? part.id : undefined;
						const run = toolCallId ? toolRunFor(result, toolCallId) : undefined;
						blocks.push({
							type: "tool-call",
							name: part.name,
							args: isRecord(part.arguments) ? part.arguments : {},
							status: run?.status ?? "running",
							summary: run?.summary,
							toolCallId,
						});
					}
				}
				continue;
			}
			if (message.role === "toolResult") {
				const text = extractText(message.content);
				if (text.length === 0 && message.isError !== true) continue;
				blocks.push({
					type: "tool-result",
					text,
					isError: message.isError === true,
					toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
					name: typeof message.toolName === "string" ? message.toolName : undefined,
				});
			}
		}
	}

	for (const approval of result.resolvedApprovals ?? []) {
		if (!isRecord(approval)) continue;
		const method = typeof approval.method === "string" && approval.method.length > 0 ? approval.method : "approval";
		const title = typeof approval.title === "string" && approval.title.length > 0 ? approval.title : method;
		blocks.push({
			type: "approval",
			title,
			state: approval.state === "denied" ? "denied" : "approved",
			method,
		});
	}

	if (result.pendingApproval) {
		blocks.push({
			type: "approval",
			title: result.pendingApproval.title ?? result.pendingApproval.method,
			state: "pending",
			method: result.pendingApproval.method,
		});
	}

	for (const diagnostic of result.diagnostics ?? []) {
		if (typeof diagnostic === "string" && diagnostic.length > 0) blocks.push({ type: "diagnostic", text: diagnostic });
	}

	if (typeof result.errorMessage === "string" && result.errorMessage.length > 0) {
		blocks.push({ type: "status", text: `Error: ${result.errorMessage}` });
	} else if (result.stopReason === "aborted") {
		blocks.push({ type: "status", text: "Run aborted" });
	}

	appendLiveText(blocks, result.liveText);
	return blocks;
}

/**
 * Append the in-progress assistant text without duplicating a finalized
 * message. `liveText` is normally cleared when a message settles, so this is a
 * defensive check for a race where both are present.
 */
function appendLiveText(blocks: TranscriptBlock[], liveText: unknown): void {
	if (typeof liveText !== "string" || liveText.length === 0) return;
	const last = blocks[blocks.length - 1];
	if (last?.type === "assistant" && (last.text === liveText || last.text.endsWith(liveText))) return;
	blocks.push({ type: "assistant", text: liveText, streaming: true });
}

/**
 * Pure scroll window for a fixed-height transcript.
 *
 * The viewport follows the end by default. Any upward scroll turns following
 * off; scrolling back to the bottom (or an explicit `scrollToBottom`) turns it
 * back on. `update()` is called with the current total line count each render
 * so new content keeps the tail pinned while following.
 */
export class TranscriptViewport {
	private offset = 0;
	private following = true;
	private totalLines = 0;
	private height = 10;

	constructor(height = 10) {
		this.height = Math.max(1, height);
	}

	get isFollowing(): boolean {
		return this.following;
	}

	get scrollOffset(): number {
		return this.offset;
	}

	get viewportHeight(): number {
		return this.height;
	}

	get contentHeight(): number {
		return this.totalLines;
	}

	get maxOffset(): number {
		return Math.max(0, this.totalLines - this.height);
	}

	setViewportHeight(height: number): void {
		this.height = Math.max(1, Math.floor(height));
		this.reclamp();
	}

	/** Refresh the total line count; keeps the tail pinned while following. */
	update(totalLines: number): void {
		this.totalLines = Math.max(0, Math.floor(totalLines));
		if (this.following) this.offset = this.maxOffset;
		else this.reclamp();
	}

	scrollBy(lines: number): void {
		this.offset = clamp(this.offset + Math.trunc(lines), 0, this.maxOffset);
		this.following = this.offset >= this.maxOffset;
	}

	lineUp(): void {
		this.scrollBy(-1);
	}

	lineDown(): void {
		this.scrollBy(1);
	}

	pageUp(): void {
		this.scrollBy(-this.height);
	}

	pageDown(): void {
		this.scrollBy(this.height);
	}

	halfPageUp(): void {
		this.scrollBy(-Math.max(1, Math.floor(this.height / 2)));
	}

	halfPageDown(): void {
		this.scrollBy(Math.max(1, Math.floor(this.height / 2)));
	}

	scrollToTop(): void {
		this.offset = 0;
		this.following = false;
	}

	scrollToBottom(): void {
		this.offset = this.maxOffset;
		this.following = true;
	}

	/** Return the visible slice for the current offset and viewport height. */
	window(lines: readonly string[]): string[] {
		const total = lines.length;
		if (total !== this.totalLines) {
			this.totalLines = total;
			if (this.following) this.offset = this.maxOffset;
			else this.reclamp();
		}
		const start = clamp(this.offset, 0, this.maxOffset);
		return lines.slice(start, start + this.height);
	}

	private reclamp(): void {
		this.offset = clamp(this.offset, 0, this.maxOffset);
		if (this.following) this.offset = this.maxOffset;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
