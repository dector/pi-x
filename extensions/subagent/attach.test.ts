import { describe, expect, test } from "bun:test";
import { buildTranscript, TranscriptViewport, type TranscriptBlock } from "./attach.ts";
import type { SingleResult } from "./types.ts";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		agentSource: "user",
		task: "Implement validation",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		state: "running",
		...overrides,
	};
}

function assistant(parts: unknown[]): unknown {
	return { role: "assistant", content: parts };
}

function toolResult(toolCallId: string, text: string, isError = false): unknown {
	return { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }], isError };
}

function types(blocks: TranscriptBlock[]): string[] {
	return blocks.map((block) => block.type);
}

describe("buildTranscript", () => {
	test("emits the task first and assistant text in order", () => {
		const result = makeResult({
			messages: [assistant([{ type: "text", text: "I will inspect." }])] as never,
		});
		const blocks = buildTranscript(result);
		expect(types(blocks)).toEqual(["task", "assistant"]);
		expect(blocks[0]).toEqual({ type: "task", text: "Implement validation" });
		expect(blocks[1]).toEqual({ type: "assistant", text: "I will inspect." });
	});

	test("appends live text as a streaming assistant block", () => {
		const result = makeResult({
			messages: [assistant([{ type: "text", text: "Working on" }])] as never,
			liveText: " the validation module",
		});
		const blocks = buildTranscript(result);
		expect(types(blocks)).toEqual(["task", "assistant", "assistant"]);
		expect(blocks[2]).toEqual({ type: "assistant", text: " the validation module", streaming: true });
	});

	test("does not duplicate live text already present in the last assistant block", () => {
		const result = makeResult({
			messages: [assistant([{ type: "text", text: "The issue is caused by a race." }])] as never,
			liveText: "a race.",
		});
		expect(types(buildTranscript(result))).toEqual(["task", "assistant"]);
	});

	test("includes thinking parts", () => {
		const result = makeResult({
			messages: [assistant([{ type: "thinking", thinking: "Check the callers." }])] as never,
		});
		expect(buildTranscript(result)[1]).toEqual({ type: "thinking", text: "Check the callers." });
	});

	test("pairs tool calls with results in message order", () => {
		const result = makeResult({
			messages: [
				assistant([{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }]),
				toolResult("t1", "file contents"),
			] as never,
			toolRuns: [{ toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, status: "completed" }],
		});
		const blocks = buildTranscript(result);
		expect(types(blocks)).toEqual(["task", "tool-call", "tool-result"]);
		expect(blocks[1]).toMatchObject({ type: "tool-call", name: "read", status: "completed", toolCallId: "t1" });
		expect(blocks[2]).toMatchObject({ type: "tool-result", text: "file contents", toolCallId: "t1", isError: false });
	});

	test("reflects running, blocked, failed, and interrupted tool states", () => {
		const statuses = ["running", "blocked", "failed", "interrupted"] as const;
		for (const status of statuses) {
			const result = makeResult({
				messages: [assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "x" } }])] as never,
				toolRuns: [{ toolCallId: "t1", toolName: "bash", args: { command: "x" }, status }],
			});
			const block = buildTranscript(result)[1];
			expect(block).toMatchObject({ type: "tool-call", status });
		}
	});

	test("includes approval, diagnostics, and a terminal error status", () => {
		const result = makeResult({
			pendingApproval: { requestId: "r1", method: "confirm", title: "Run command?" },
			diagnostics: ["Malformed child control status"],
			errorMessage: "Child exited before settling",
		});
		expect(types(buildTranscript(result))).toEqual(["task", "approval", "diagnostic", "status"]);
	});

	test("emits resolved approvals in order before a pending approval", () => {
		const result = makeResult({
			resolvedApprovals: [
				{ requestId: "r1", method: "confirm", title: "Write file?", state: "approved" },
				{ requestId: "r2", method: "select", title: "Run command?", state: "denied" },
			],
			pendingApproval: { requestId: "r3", method: "input", title: "Commit message?" },
		});
		const blocks = buildTranscript(result);
		expect(types(blocks)).toEqual(["task", "approval", "approval", "approval"]);
		expect(blocks.slice(1)).toMatchObject([
			{ type: "approval", title: "Write file?", state: "approved", method: "confirm" },
			{ type: "approval", title: "Run command?", state: "denied", method: "select" },
			{ type: "approval", title: "Commit message?", state: "pending", method: "input" },
		]);
	});

	test("falls back to the method for missing resolved approval titles and skips malformed entries", () => {
		const result = makeResult({
			resolvedApprovals: [
				null,
				"nope",
				{ requestId: "r1", method: "confirm", state: "approved" },
				{ requestId: "r2", method: "", title: "", state: "nonsense" },
			] as never,
		});
		const approvals = buildTranscript(result).filter((block) => block.type === "approval");
		expect(approvals).toMatchObject([
			{ title: "confirm", state: "approved", method: "confirm" },
			{ title: "approval", state: "approved", method: "approval" },
		]);
	});

	test("tolerates malformed messages and content", () => {
		const result = makeResult({
			messages: [null, {}, { role: "assistant" }, { role: "assistant", content: "nope" }, { role: "toolResult" }] as never,
		});
		expect(() => buildTranscript(result)).not.toThrow();
		expect(types(buildTranscript(result))).toEqual(["task"]);
	});

	test("can omit the task block", () => {
		expect(types(buildTranscript(makeResult(), { includeTask: false }))).toEqual([]);
	});
});

describe("TranscriptViewport", () => {
	test("starts following the tail and pins to new content", () => {
		const viewport = new TranscriptViewport(10);
		viewport.update(100);
		expect(viewport.isFollowing).toBe(true);
		expect(viewport.scrollOffset).toBe(90);
		viewport.update(120);
		expect(viewport.scrollOffset).toBe(110);
	});

	test("scrolling up disables tail-follow and new content does not move the offset", () => {
		const viewport = new TranscriptViewport(10);
		viewport.update(100);
		viewport.lineUp();
		expect(viewport.isFollowing).toBe(false);
		expect(viewport.scrollOffset).toBe(89);
		viewport.update(140);
		expect(viewport.scrollOffset).toBe(89);
	});

	test("returning to the bottom resumes tail-follow", () => {
		const viewport = new TranscriptViewport(10);
		viewport.update(100);
		viewport.pageUp();
		expect(viewport.isFollowing).toBe(false);
		viewport.scrollToBottom();
		expect(viewport.isFollowing).toBe(true);
		expect(viewport.scrollOffset).toBe(90);
	});

	test("page scrolling is bounded and never goes negative", () => {
		const viewport = new TranscriptViewport(10);
		viewport.update(25);
		viewport.pageUp();
		viewport.pageUp();
		viewport.pageUp();
		expect(viewport.scrollOffset).toBe(0);
		expect(viewport.isFollowing).toBe(false);
		viewport.scrollToTop();
		viewport.pageDown();
		expect(viewport.scrollOffset).toBe(10);
	});

	test("window returns the visible slice and pads nothing beyond content", () => {
		const viewport = new TranscriptViewport(3);
		const lines = ["a", "b", "c", "d", "e"];
		viewport.update(lines.length);
		expect(viewport.window(lines)).toEqual(["c", "d", "e"]);
		viewport.scrollToTop();
		expect(viewport.window(lines)).toEqual(["a", "b", "c"]);
	});

	test("shrinking the viewport reclamps the offset", () => {
		const viewport = new TranscriptViewport(10);
		viewport.update(100);
		viewport.scrollToTop();
		viewport.setViewportHeight(5);
		expect(viewport.scrollOffset).toBe(0);
		viewport.scrollToBottom();
		expect(viewport.scrollOffset).toBe(95);
	});

	test("half-page scrolling moves by half the viewport and disables tail-follow", () => {
		const viewport = new TranscriptViewport(10);
		viewport.update(100);
		viewport.halfPageUp();
		expect(viewport.scrollOffset).toBe(85);
		expect(viewport.isFollowing).toBe(false);
		viewport.halfPageDown();
		expect(viewport.scrollOffset).toBe(90);
		expect(viewport.isFollowing).toBe(true);
	});

	test("half-page scrolling clamps at the top and keeps a one-line minimum", () => {
		const viewport = new TranscriptViewport(1);
		viewport.update(100);
		viewport.halfPageUp();
		expect(viewport.scrollOffset).toBe(98);
		viewport.halfPageUp();
		viewport.halfPageUp();
		expect(viewport.scrollOffset).toBe(96);
	});
});
