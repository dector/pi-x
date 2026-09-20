/**
 * Stage 1 tests for the canonical dispatch-completion helpers.
 *
 * Covers backward-compatible metadata defaults, terminal status derivation,
 * byte-safe per-task truncation, the moved parallel formatting, and the async
 * acknowledgement text.
 */

import { describe, expect, test } from "bun:test";
import {
	PER_TASK_OUTPUT_CAP,
	aggregateDispatchStatus,
	formatAsyncAcknowledgement,
	formatParallelAggregate,
	formatTaskStatus,
	isTerminalDispatchStatus,
	normalizeDispatchMetadata,
	normalizeSubagentDetails,
	truncateTaskOutput,
} from "./completion.ts";
import type { SingleResult } from "./types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function assistant(text: string) {
	return { role: "assistant", content: [{ type: "text", text }], usage, stopReason: "end" };
}

function singleResult(agent: string, output: string | undefined, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent,
		agentSource: "user",
		task: "",
		exitCode: 0,
		messages: output === undefined ? [] : [assistant(output)],
		stderr: "",
		usage,
		...overrides,
	};
}

describe("dispatch status compatibility", () => {
	test("started is non-terminal; settled statuses are terminal", () => {
		expect(isTerminalDispatchStatus("started")).toBe(false);
		expect(isTerminalDispatchStatus("completed")).toBe(true);
		expect(isTerminalDispatchStatus("failed")).toBe(true);
		expect(isTerminalDispatchStatus("aborted")).toBe(true);
		expect(isTerminalDispatchStatus(undefined)).toBe(false);
		expect(isTerminalDispatchStatus("bogus")).toBe(false);
	});

	test("normalizeDispatchMetadata defaults old records to blocking/completed", () => {
		expect(normalizeDispatchMetadata(undefined)).toEqual({ execution: "blocking", dispatchStatus: "completed" });
		expect(normalizeDispatchMetadata({})).toEqual({ execution: "blocking", dispatchStatus: "completed" });
		expect(normalizeDispatchMetadata({ execution: "weird", dispatchStatus: "weird" })).toEqual({
			execution: "blocking",
			dispatchStatus: "completed",
		});
	});

	test("normalizeDispatchMetadata preserves async start and terminal statuses", () => {
		expect(normalizeDispatchMetadata({ execution: "async", dispatchStatus: "started" })).toEqual({
			execution: "async",
			dispatchStatus: "started",
		});
		expect(normalizeDispatchMetadata({ execution: "async", dispatchStatus: "aborted" })).toEqual({
			execution: "async",
			dispatchStatus: "aborted",
		});
	});

	test("normalizeSubagentDetails accepts legacy records and rejects non-dispatches", () => {
		const legacy = normalizeSubagentDetails({ mode: "parallel", results: [] });
		expect(legacy).toEqual({
			mode: "parallel",
			agentScope: "user",
			projectAgentsDir: null,
			execution: "blocking",
			dispatchId: undefined,
			dispatchStatus: "completed",
			results: [],
		});

		expect(normalizeSubagentDetails(undefined)).toBeUndefined();
		expect(normalizeSubagentDetails({ mode: "banana", results: [] })).toBeUndefined();
		expect(normalizeSubagentDetails({ mode: "single", results: "nope" })).toBeUndefined();
	});

	test("normalizeSubagentDetails keeps dispatch metadata when present", () => {
		const details = normalizeSubagentDetails({
			mode: "single",
			agentScope: "both",
			projectAgentsDir: "/tmp/agents",
			execution: "async",
			dispatchId: "d-1",
			dispatchStatus: "started",
			results: [],
		});
		expect(details).toMatchObject({
			mode: "single",
			agentScope: "both",
			projectAgentsDir: "/tmp/agents",
			execution: "async",
			dispatchId: "d-1",
			dispatchStatus: "started",
		});
	});
});

describe("aggregateDispatchStatus", () => {
	test("is completed for an empty or mixed result set", () => {
		expect(aggregateDispatchStatus([])).toBe("completed");
		expect(aggregateDispatchStatus([singleResult("a", "ok")])).toBe("completed");
		expect(
			aggregateDispatchStatus([
				singleResult("a", "ok"),
				singleResult("b", undefined, { exitCode: 1, stderr: "boom" }),
			]),
		).toBe("completed");
	});

	test("is failed when every result failed or an aggregate error is set", () => {
		expect(
			aggregateDispatchStatus([
				singleResult("a", undefined, { exitCode: 1, stderr: "x" }),
				singleResult("b", undefined, { exitCode: 1, stderr: "y" }),
			]),
		).toBe("failed");
		expect(aggregateDispatchStatus([singleResult("a", "ok")], { error: true })).toBe("failed");
	});

	test("aborted wins over an aggregate error", () => {
		expect(aggregateDispatchStatus([singleResult("a", "ok")], { error: true, aborted: true })).toBe("aborted");
	});
});

describe("truncateTaskOutput", () => {
	test("returns output at or under the cap unchanged", () => {
		const atCap = "a".repeat(PER_TASK_OUTPUT_CAP);
		expect(truncateTaskOutput(atCap)).toBe(atCap);
		expect(truncateTaskOutput("short")).toBe("short");
	});

	test("truncates ASCII by byte count and preserves the exact suffix", () => {
		const output = "a".repeat(PER_TASK_OUTPUT_CAP + 8800);
		const truncated = truncateTaskOutput(output);
		expect(truncated).toBe(
			`${"a".repeat(PER_TASK_OUTPUT_CAP)}\n\n[Output truncated: 8800 bytes omitted. Full output preserved in tool details.]`,
		);
	});

	test("counts bytes, not characters, for multibyte output", () => {
		const output = "é".repeat(PER_TASK_OUTPUT_CAP);
		const truncated = truncateTaskOutput(output);
		expect(truncated).toBe(
			`${"é".repeat(PER_TASK_OUTPUT_CAP / 2)}\n\n[Output truncated: ${PER_TASK_OUTPUT_CAP} bytes omitted. Full output preserved in tool details.]`,
		);
	});

	test("never splits a surrogate pair at the cap boundary", () => {
		// 9 ASCII bytes + a 4-byte emoji = 13 bytes. A 12-byte cap cannot fit the
		// emoji, so the whole code point is dropped (not half a surrogate).
		const output = `${"a".repeat(9)}😀`;
		const truncated = truncateTaskOutput(output, 12);
		expect(truncated).toBe("aaaaaaaaa\n\n[Output truncated: 4 bytes omitted. Full output preserved in tool details.]");
	});

	test("keeps a whole emoji when it fits exactly at the cap", () => {
		const output = `${"a".repeat(9)}😀`;
		expect(truncateTaskOutput(output, 13)).toBe(output);
	});

	test("reports true omitted bytes for a smaller custom cap", () => {
		const output = "abcdefghij";
		expect(truncateTaskOutput(output, 4)).toBe(
			"abcd\n\n[Output truncated: 6 bytes omitted. Full output preserved in tool details.]",
		);
	});
});

describe("parallel aggregate formatting", () => {
	test("matches the historical heading, status, and separator layout", () => {
		const results = [
			singleResult("a", "a-out"),
			singleResult("b", undefined, { exitCode: 1, stopReason: "error", errorMessage: "boom" }),
			singleResult("c", "c-out"),
		];
		expect(formatParallelAggregate(results)).toBe(
			[
				"Parallel: 2/3 succeeded",
				"",
				"### [a] completed",
				"",
				"a-out",
				"",
				"---",
				"",
				"### [b] failed (error)",
				"",
				"boom",
				"",
				"---",
				"",
				"### [c] completed",
				"",
				"c-out",
			].join("\n"),
		);
	});

	test("formats an empty aggregate like the historical empty join", () => {
		expect(formatParallelAggregate([])).toBe("Parallel: 0/0 succeeded\n\n");
	});

	test("formatTaskStatus suppresses a terminal end reason and keeps others", () => {
		expect(formatTaskStatus(singleResult("a", "ok"))).toBe("completed");
		expect(formatTaskStatus(singleResult("b", undefined, { exitCode: 1, stopReason: "end" }))).toBe("failed");
		expect(formatTaskStatus(singleResult("c", undefined, { exitCode: 1, stopReason: "aborted" }))).toBe(
			"failed (aborted)",
		);
	});
});

describe("formatAsyncAcknowledgement", () => {
	test("announces the dispatch, lists runs, and tells the parent not to poll", () => {
		const text = formatAsyncAcknowledgement({
			dispatchId: "dispatch-1",
			mode: "parallel",
			items: [
				{ agent: "scout", runId: "sa-1", task: "find code", cwd: "/tmp/repo" },
				{ agent: "worker", runId: "sa-2", task: "apply fix" },
			],
		});
		expect(text).toContain("dispatch-1");
		expect(text).toContain("background");
		expect(text).toContain("scout [sa-1] (cwd: /tmp/repo): find code");
		expect(text).toContain("worker [sa-2]: apply fix");
		expect(text).toContain("Do not poll or wait");
		expect(text).toContain("arrive automatically");
		expect(text).toContain("re-read affected files");
	});
});
