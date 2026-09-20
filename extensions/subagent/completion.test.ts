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
	buildAsyncStartResult,
	buildCompletionRenderBlocks,
	buildCompletionRenderData,
	coerceTerminalCompletionDetails,
	collectCompletionSections,
	formatAsyncAcknowledgement,
	formatAsyncCompletion,
	formatCompletionCounts,
	formatCompletionRenderText,
	formatParallelAggregate,
	formatTaskStatus,
	isTerminalDispatchStatus,
	normalizeDispatchMetadata,
	normalizeSubagentDetails,
	SUBAGENT_COMPLETION_CUSTOM_TYPE,
	truncateTaskOutput,
} from "./completion.ts";
import type { PreparedSubagentDispatch, SingleResult } from "./types.ts";

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
			execution: "async",
			mode: "parallel",
			items: [
				{ agent: "scout", runId: "sa-1", task: "find code", cwd: "/tmp/repo" },
				{ agent: "worker", runId: "sa-2", task: "apply fix" },
			],
		});
		expect(text).toContain("dispatch-1");
		expect(text).toContain("background");
		expect(text).toContain("async");
		expect(text).toContain("scout [sa-1] (cwd: /tmp/repo): find code");
		expect(text).toContain("worker [sa-2]: apply fix");
		expect(text).toContain("Do not poll or wait");
		expect(text).toContain("arrive automatically");
		expect(text).toContain("re-read affected files");
	});
});

function preparedDispatch(overrides: Partial<PreparedSubagentDispatch> = {}): PreparedSubagentDispatch {
	return {
		dispatchId: "dispatch-1",
		execution: "async",
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		agents: [],
		dispatchDefaults: {},
		cwd: "/tmp/parent",
		items: [{ runId: "sa-1", agent: "worker", task: "do it" }],
		...overrides,
	};
}

describe("buildAsyncStartResult", () => {
	test("returns a non-terminal started acknowledgement with the dispatch cwd", () => {
		const dispatch = preparedDispatch({ items: [{ runId: "sa-1", agent: "worker", task: "do it" }] });
		const result = buildAsyncStartResult(dispatch);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("dispatch-1");
		expect(text).toContain("worker [sa-1] (cwd: /tmp/parent): do it");
		expect(text).toContain("async");
		expect(result.details).toMatchObject({
			mode: "single",
			execution: "async",
			dispatchId: "dispatch-1",
			dispatchStatus: "started",
			results: [],
		});
	});
});

describe("formatAsyncCompletion", () => {
	test("summarizes every prepared run with status, task, and output", () => {
		const dispatch = preparedDispatch({
			mode: "parallel",
			dispatchId: "dispatch-9",
			items: [
				{ runId: "sa-1", agent: "a", task: "one" },
				{ runId: "sa-2", agent: "b", task: "two" },
			],
		});
		const text = formatAsyncCompletion(dispatch, {
			content: [{ type: "text", text: "ignored" }],
			details: {
				mode: "parallel",
				execution: "async",
				dispatchId: "dispatch-9",
				dispatchStatus: "completed",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					singleResult("a", "a-out", { runId: "sa-1" }),
					singleResult("b", undefined, {
						runId: "sa-2",
						exitCode: 1,
						stopReason: "error",
						errorMessage: "boom",
					}),
				],
			},
		});

		expect(text).toContain("dispatch-9 completed");
		expect(text).toContain("### [a] [sa-1] completed");
		expect(text).toContain("Task: one");
		expect(text).toContain("Output: a-out");
		expect(text).toContain("### [b] [sa-2] failed (error)");
		expect(text).toContain("Failure: boom");
		expect(text).toContain("Summary: 1/2 succeeded.");
	});

	test("includes the child working directory from results and prepared items", () => {
		const dispatch = preparedDispatch({
			mode: "parallel",
			items: [
				{ runId: "sa-1", agent: "a", task: "one", cwd: "/work/a" },
				{ runId: "sa-2", agent: "b", task: "two" },
			],
		});
		const text = formatAsyncCompletion(dispatch, {
			content: [{ type: "text", text: "ignored" }],
			details: {
				mode: "parallel",
				execution: "async",
				dispatchId: dispatch.dispatchId,
				dispatchStatus: "completed",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					singleResult("a", "a-out", { runId: "sa-1", cwd: "/work/a" }),
					singleResult("b", "b-out", { runId: "sa-2", cwd: "/work/b" }),
				],
			},
		});

		expect(text).toContain("Directory: /work/a");
		expect(text).toContain("Directory: /work/b");
	});

	test("falls back to the dispatch cwd when a result has none", () => {
		const dispatch = preparedDispatch({ cwd: "/parent", items: [{ runId: "sa-1", agent: "a", task: "one" }] });
		const text = formatAsyncCompletion(dispatch, {
			content: [{ type: "text", text: "ignored" }],
			details: {
				mode: "single",
				execution: "async",
				dispatchId: dispatch.dispatchId,
				dispatchStatus: "completed",
				agentScope: "user",
				projectAgentsDir: null,
				results: [singleResult("a", "a-out", { runId: "sa-1" })],
			},
		});

		expect(text).toContain("Directory: /parent");
	});

	test("prefers a prepared item cwd over the dispatch fallback", () => {
		const dispatch = preparedDispatch({
			cwd: "/parent",
			items: [{ runId: "sa-1", agent: "a", task: "one", cwd: "/item" }],
		});
		const text = formatAsyncCompletion(dispatch, {
			content: [{ type: "text", text: "ignored" }],
			details: {
				mode: "single",
				execution: "async",
				dispatchId: dispatch.dispatchId,
				dispatchStatus: "completed",
				agentScope: "user",
				projectAgentsDir: null,
				results: [singleResult("a", "a-out", { runId: "sa-1" })],
			},
		});

		expect(text).toContain("Directory: /item");
		expect(text).not.toContain("Directory: /parent");
	});

	test("uses the requested item count as the summary denominator for a stopped chain", () => {
		const dispatch = preparedDispatch({
			mode: "chain",
			dispatchId: "chain-1",
			items: [
				{ runId: "sa-1", agent: "a", task: "one", step: 1 },
				{ runId: "sa-2", agent: "b", task: "two", step: 2 },
				{ runId: "sa-3", agent: "c", task: "three", step: 3 },
			],
		});
		const text = formatAsyncCompletion(dispatch, {
			content: [{ type: "text", text: "ignored" }],
			details: {
				mode: "chain",
				execution: "async",
				dispatchId: "chain-1",
				dispatchStatus: "aborted",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					singleResult("a", "a-out", { runId: "sa-1", step: 1 }),
					singleResult("b", undefined, {
						runId: "sa-2",
						step: 2,
						exitCode: 1,
						stopReason: "aborted",
						errorMessage: "stopped",
					}),
				],
			},
		});

		expect(text).toContain("### [c] [sa-3] not run");
		expect(text).toContain("Not run: the chain stopped before this step.");
		expect(text).toContain("Summary: 1/3 succeeded, 1 not run.");
		expect(text).not.toContain("### [c] [sa-3] failed");
	});
});

describe("subagent-completion renderer", () => {
	const details = {
		mode: "parallel",
		execution: "async",
		dispatchId: "dispatch-7",
		dispatchStatus: "completed",
		agentScope: "user",
		projectAgentsDir: null,
		results: [
			singleResult("scout", "found it", { runId: "sa-1", task: "find auth code", cwd: "/repo" }),
			singleResult("worker", undefined, {
				runId: "sa-2",
				task: "apply fix",
				exitCode: 1,
				stopReason: "error",
				errorMessage: "boom",
			}),
		],
	};

	test("collapsed renders one aggregate status line without task output", () => {
		const text = formatCompletionRenderText(details, { expanded: false });
		expect(text).toContain("dispatch-7");
		expect(text).toContain("completed");
		expect(text).toContain("parallel");
		expect(text).toContain("async");
		expect(text).toContain("1/2 succeeded");
		expect(text).not.toContain("found it");
		expect(text).not.toContain("boom");
	});

	test("expanded renders every task, run id, directory, output, and error", () => {
		const text = formatCompletionRenderText(details, { expanded: true }) ?? "";
		expect(text).toContain("### [scout] [sa-1] completed");
		expect(text).toContain("Task: find auth code");
		expect(text).toContain("Directory: /repo");
		expect(text).toContain("Output: found it");
		expect(text).toContain("### [worker] [sa-2] failed (error)");
		expect(text).toContain("Task: apply fix");
		expect(text).toContain("Failure: boom");
		expect(text).toContain("Summary: 1/2 succeeded.");
	});

	test("builds a structured model for the indexed renderer", () => {
		const data = buildCompletionRenderData(details);
		expect(data?.sections.map((section) => [section.agent, section.runId, section.failed])).toEqual([
			["scout", "sa-1", false],
			["worker", "sa-2", true],
		]);
		expect(data).toMatchObject({
			dispatchId: "dispatch-7",
			execution: "async",
			dispatchStatus: "completed",
			succeeded: 1,
			failed: 1,
			total: 2,
		});
	});

	test("returns undefined for non-dispatch details", () => {
		expect(formatCompletionRenderText(undefined)).toBeUndefined();
		expect(formatCompletionRenderText({ mode: "banana", results: [] })).toBeUndefined();
		expect(buildCompletionRenderData(null)).toBeUndefined();
	});

	test("exposes the shared custom-type constant", () => {
		expect(SUBAGENT_COMPLETION_CUSTOM_TYPE).toBe("subagent-completion");
	});
});

describe("stopped-chain completion details", () => {
	const plannedItems = [
		{ runId: "sa-1", agent: "a", task: "one", step: 1 },
		{ runId: "sa-2", agent: "b", task: "two", step: 2 },
		{ runId: "sa-3", agent: "c", task: "three", step: 3 },
	];
	const stoppedChainDetails = {
		mode: "chain",
		execution: "async",
		dispatchId: "chain-1",
		dispatchStatus: "failed",
		agentScope: "user",
		projectAgentsDir: null,
		cwd: "/parent",
		plannedItems,
		results: [
			singleResult("a", "a-out", { runId: "sa-1", task: "one", step: 1 }),
			singleResult("b", undefined, {
				runId: "sa-2",
				task: "two",
				step: 2,
				exitCode: 1,
				stopReason: "error",
				errorMessage: "stopped",
			}),
		],
	};

	test("renders planned totals and includes not-run steps in the expanded view", () => {
		const data = buildCompletionRenderData(stoppedChainDetails);
		expect(data).toMatchObject({ succeeded: 1, failed: 1, notRun: 1, total: 3 });
		expect(data?.title).toContain("1/3 succeeded, 1 not run");
		expect(data?.summary).toBe("Summary: 1/3 succeeded, 1 not run.");
		expect(data?.sections.map((section) => [section.runId, section.status, section.notRun])).toEqual([
			["sa-1", "completed", false],
			["sa-2", "failed (error)", false],
			["sa-3", "not run", true],
		]);

		const collapsed = formatCompletionRenderText(stoppedChainDetails, { expanded: false });
		expect(collapsed).toContain("1/3 succeeded, 1 not run");

		const expanded = formatCompletionRenderText(stoppedChainDetails, { expanded: true }) ?? "";
		expect(expanded).toContain("### [c] [sa-3] step 3 not run");
		expect(expanded).toContain("Task: three");
		expect(expanded).toContain("Not run: the chain stopped before this step.");
		expect(expanded).toContain("Summary: 1/3 succeeded, 1 not run.");
	});

	test("block model keeps the planned order and labels", () => {
		const data = buildCompletionRenderData(stoppedChainDetails);
		if (!data) throw new Error("expected render data");
		const blocks = buildCompletionRenderBlocks(data);
		expect(blocks.map((block) => block.kind)).toEqual([
			"title",
			"summary",
			"header",
			"task",
			"directory",
			"output",
			"header",
			"task",
			"directory",
			"output",
			"header",
			"task",
			"directory",
			"output",
		]);
		const outputLabels = blocks.filter((block) => block.kind === "output").map((block) => block.label);
		expect(outputLabels).toEqual(["Output", "Failure", "Not run"]);
	});

	test("still renders every result when planned items are absent (old records)", () => {
		const legacy = { ...stoppedChainDetails, plannedItems: undefined };
		const data = buildCompletionRenderData(legacy);
		expect(data).toMatchObject({ succeeded: 1, failed: 1, notRun: 0, total: 2 });
		expect(data?.sections.map((section) => section.runId)).toEqual(["sa-1", "sa-2"]);
	});

	test("accepts a planned fallback and appends unexpected extra results", () => {
		const data = buildCompletionRenderData(
			{
				mode: "chain",
				execution: "async",
				dispatchId: "chain-2",
				dispatchStatus: "completed",
				results: [
					singleResult("a", "a-out", { runId: "sa-1" }),
					singleResult("extra", "extra-out", { runId: "sa-x" }),
				],
			},
			plannedItems,
		);
		expect(data?.sections.map((section) => section.runId)).toEqual(["sa-1", "sa-2", "sa-3", "sa-x"]);
		expect(data?.notRun).toBe(2);
	});

	test("collectCompletionSections is stable for empty input", () => {
		expect(collectCompletionSections([], [], "parallel")).toEqual([]);
		expect(formatCompletionCounts(0, 0, 0)).toBe("0/0 succeeded");
	});

	test("drops malformed planned items and keeps valid ones", () => {
		const details = normalizeSubagentDetails({
			mode: "chain",
			results: [],
			plannedItems: [
				{ runId: "sa-1", agent: "a", task: "one", step: 1 },
				{ agent: "missing-run-id", task: "two" },
				{ runId: "sa-3", agent: "c", task: 42 },
				null,
			],
		});
		expect(details?.plannedItems).toEqual([{ runId: "sa-1", agent: "a", task: "one", step: 1 }]);
	});
});

describe("coerceTerminalCompletionDetails", () => {
	const dispatch = preparedDispatch({
		mode: "chain",
		dispatchId: "d-1",
		cwd: "/dispatch-cwd",
		items: [
			{ runId: "sa-1", agent: "a", task: "one", step: 1 },
			{ runId: "sa-2", agent: "b", task: "two", step: 2 },
		],
	});

	test("replaces a started status with a terminal one derived from the results", () => {
		const details = coerceTerminalCompletionDetails(dispatch, {
			mode: "chain",
			execution: "async",
			dispatchId: "d-1",
			dispatchStatus: "started",
			results: [singleResult("a", "ok", { runId: "sa-1" })],
		});
		expect(details.dispatchStatus).toBe("completed");
		expect(details.plannedItems).toHaveLength(2);
		expect(details.cwd).toBe("/dispatch-cwd");
	});

	test("an explicit aborted option wins for a non-terminal record", () => {
		const details = coerceTerminalCompletionDetails(
			dispatch,
			{ dispatchStatus: "started", results: [singleResult("a", "ok", { runId: "sa-1" })] },
			{ aborted: true },
		);
		expect(details.dispatchStatus).toBe("aborted");
	});

	test("an isError option marks an empty non-terminal record failed", () => {
		const details = coerceTerminalCompletionDetails(dispatch, { dispatchStatus: "started", results: [] }, { isError: true });
		expect(details.dispatchStatus).toBe("failed");
	});

	test("keeps a terminal status and existing metadata", () => {
		const details = coerceTerminalCompletionDetails(dispatch, {
			mode: "chain",
			agentScope: "both",
			projectAgentsDir: "/agents",
			dispatchStatus: "aborted",
			dispatchId: "other",
			results: [],
		});
		expect(details).toMatchObject({
			dispatchStatus: "aborted",
			dispatchId: "d-1",
			agentScope: "both",
			projectAgentsDir: "/agents",
		});
	});

	test("produces a terminal record from missing details", () => {
		const details = coerceTerminalCompletionDetails(dispatch, undefined);
		expect(details.dispatchStatus).toBe("completed");
		expect(details.results).toEqual([]);
		expect(details.plannedItems).toHaveLength(2);
	});
});

describe("backend and Herdr metadata", () => {
	test("acknowledgement names the Herdr transport but stays default for process", () => {
		const base = {
			dispatchId: "dispatch-1",
			execution: "async" as const,
			mode: "single" as const,
			items: [{ agent: "worker", runId: "sa-1", task: "do it" }],
		};
		expect(formatAsyncAcknowledgement(base)).not.toContain("herdr");
		expect(formatAsyncAcknowledgement({ ...base, backend: "herdr" })).toContain("single, async, herdr");
	});

	test("buildAsyncStartResult carries backend and retention without changing process shape", () => {
		const processDispatch = preparedDispatch();
		const processDetails = buildAsyncStartResult(processDispatch).details;
		expect(processDetails?.backend).toBeUndefined();
		expect(processDetails?.herdrRetention).toBeUndefined();

		const herdrDispatch = preparedDispatch({ backend: "herdr", herdrRetention: "always" });
		const result = buildAsyncStartResult(herdrDispatch);
		expect(result.details).toMatchObject({ backend: "herdr", herdrRetention: "always" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("herdr");
	});

	test("normalizeSubagentDetails keeps only known backend/retention values", () => {
		const normalized = normalizeSubagentDetails({
			mode: "single",
			results: [],
			backend: "herdr",
			herdrRetention: "always",
		});
		expect(normalized).toMatchObject({ backend: "herdr", herdrRetention: "always" });

		const unknown = normalizeSubagentDetails({
			mode: "single",
			results: [],
			backend: "carrier-pigeon",
			herdrRetention: "sometimes",
		});
		expect(unknown?.backend).toBeUndefined();
		expect(unknown?.herdrRetention).toBeUndefined();
	});

	test("coerceTerminalCompletionDetails falls back to the dispatch backend", () => {
		const dispatch = preparedDispatch({ backend: "herdr", herdrRetention: "failed" });
		const details = coerceTerminalCompletionDetails(dispatch, undefined);
		expect(details.backend).toBe("herdr");
		expect(details.herdrRetention).toBe("failed");
		expect(isTerminalDispatchStatus(details.dispatchStatus)).toBe(true);
	});
});
