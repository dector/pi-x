/**
 * Tests for the shared per-run finished line: the live TUI entry and the
 * expanded dispatch list must read identically, so both are driven from here.
 */

import { describe, expect, test } from "bun:test";
import {
	buildRunFinishedEntry,
	contextPercentOf,
	formatCost,
	formatRunLine,
	formatRunLineDetail,
	formatRunLinePlain,
	normalizeRunFinishedEntry,
	runLinePartsFromEntry,
	runOutcomeFromResult,
	SUBAGENT_RUN_FINISHED_CUSTOM_TYPE,
	type RunLineParts,
	type RunLineStyles,
} from "./run-line.ts";

/** Identity styles with markers, so each segment's styling is observable. */
const MARKED: RunLineStyles = {
	success: (text) => `<s>${text}</s>`,
	warning: (text) => `<w>${text}</w>`,
	error: (text) => `<e>${text}</e>`,
	muted: (text) => `<m>${text}</m>`,
	italic: (text) => `<i>${text}</i>`,
};

describe("formatCost", () => {
	test("uses cents precision for normal costs", () => {
		expect(formatCost(0.02)).toBe("$0.02");
		expect(formatCost(1.5)).toBe("$1.50");
	});

	test("keeps four decimals when cents would hide a real cost", () => {
		expect(formatCost(0.0039)).toBe("$0.0039");
		expect(formatCost(0.0001)).toBe("$0.0001");
	});

	test("renders zero and invalid costs as $0", () => {
		expect(formatCost(0)).toBe("$0");
		expect(formatCost(-1)).toBe("$0");
		expect(formatCost(Number.NaN)).toBe("$0");
	});
});

describe("formatRunLineDetail", () => {
	test("joins outcome, duration, turns, context, and cost", () => {
		expect(
			formatRunLineDetail({ outcome: "finished", durationMs: 72_000, turns: 4, contextPercent: 10, cost: 0.02 }),
		).toBe("finished in 1m 12s, 4 turns, ctx:10%, $0.02");
	});

	test("singularizes one turn", () => {
		expect(formatRunLineDetail({ outcome: "finished", durationMs: 500, turns: 1 })).toBe("finished in 0.5s, 1 turn");
	});

	test("omits unknown metrics instead of printing zeros", () => {
		expect(formatRunLineDetail({ outcome: "finished" })).toBe("finished");
		expect(formatRunLineDetail({ outcome: "finished", durationMs: 1000, turns: 0, cost: 0 })).toBe(
			"finished in 1.0s",
		);
	});

	test("failed and aborted use 'after', not 'in'", () => {
		expect(formatRunLineDetail({ outcome: "failed", durationMs: 30_000 })).toBe("failed after 30.0s");
		expect(formatRunLineDetail({ outcome: "aborted", durationMs: 30_000 })).toBe("aborted after 30.0s");
	});

	test("a not-run chain step carries no metrics", () => {
		expect(formatRunLineDetail({ outcome: "notRun", durationMs: 5000, turns: 3, cost: 1 })).toBe("not run");
	});

	test("rounds the context percentage", () => {
		expect(formatRunLineDetail({ outcome: "finished", contextPercent: 10.4 })).toBe("finished, ctx:10%");
		expect(formatRunLineDetail({ outcome: "finished", contextPercent: 9.6 })).toBe("finished, ctx:10%");
	});
});

describe("formatRunLine", () => {
	test("colors the glyph, keeps the run id upright, italicizes the detail", () => {
		const parts: RunLineParts = {
			outcome: "finished",
			runId: "brave-vole-2997usfagf",
			detail: "finished in 1m 12s, 4 turns, ctx:10%, $0.02",
		};
		expect(formatRunLine(parts, MARKED)).toBe(
			"<s>✓</s> <m>brave-vole-2997usfagf</m> <i><m>finished in 1m 12s, 4 turns, ctx:10%, $0.02</m></i>",
		);
	});

	test("uses the error color for a failed run and warning for aborted", () => {
		const failed: RunLineParts = { outcome: "failed", runId: "r1", detail: "failed after 1.0s" };
		const aborted: RunLineParts = { outcome: "aborted", runId: "r2", detail: "aborted after 1.0s" };
		expect(formatRunLine(failed, MARKED)).toStartWith("<e>✗</e>");
		expect(formatRunLine(aborted, MARKED)).toStartWith("<w>⊘</w>");
	});

	test("plain rendering drops styling but keeps the same text", () => {
		const parts: RunLineParts = { outcome: "finished", runId: "r1", detail: "finished in 1.0s" };
		expect(formatRunLinePlain(parts)).toBe("✓ r1 finished in 1.0s");
	});
});

describe("runOutcomeFromResult", () => {
	test("classifies success, failure, and abort", () => {
		expect(runOutcomeFromResult({ exitCode: 0 })).toBe("finished");
		expect(runOutcomeFromResult({ exitCode: 1 })).toBe("failed");
		expect(runOutcomeFromResult({ exitCode: 1, stopReason: "aborted" })).toBe("aborted");
	});

	test("aborted wins over failed because it also reads as failed", () => {
		const aborted = { exitCode: 1, stopReason: "aborted" };
		expect(runOutcomeFromResult(aborted)).toBe("aborted");
	});
});

describe("contextPercentOf", () => {
	test("computes a rounded percentage", () => {
		expect(contextPercentOf(50_000, 200_000)).toBe(25);
	});

	test("returns undefined when either side is missing or zero", () => {
		expect(contextPercentOf(undefined, 200_000)).toBeUndefined();
		expect(contextPercentOf(50_000, undefined)).toBeUndefined();
		expect(contextPercentOf(0, 200_000)).toBeUndefined();
		expect(contextPercentOf(50_000, 0)).toBeUndefined();
	});
});

describe("buildRunFinishedEntry", () => {
	test("captures outcome, duration, and usage metrics", () => {
		const entry = buildRunFinishedEntry(
			"brave-vole-2997usfagf",
			{
				agent: "planner-fast",
				task: "do the thing",
				model: "claude-sonnet-4",
				exitCode: 0,
				timing: { wallMs: 72_000, apiMs: 60_000, toolsMs: 10_000, overheadMs: 2000 },
				usage: { turns: 4, cost: 0.02, contextTokens: 50_000 },
			},
			200_000,
		);
		expect(entry).toEqual({
			runId: "brave-vole-2997usfagf",
			agent: "planner-fast",
			task: "do the thing",
			model: "claude-sonnet-4",
			outcome: "finished",
			durationMs: 72_000,
			turns: 4,
			cost: 0.02,
			contextPercent: 25,
		});
		expect(formatRunLinePlain(runLinePartsFromEntry(entry))).toBe(
			"✓ brave-vole-2997usfagf finished in 1m 12s, 4 turns, ctx:25%, $0.02",
		);
	});

	test("omits metrics that were never recorded", () => {
		const entry = buildRunFinishedEntry("r1", { exitCode: 1, stopReason: "error" });
		expect(entry).toEqual({ runId: "r1", outcome: "failed" });
		expect(formatRunLinePlain(runLinePartsFromEntry(entry))).toBe("✗ r1 failed");
	});

	test("omits the context percentage when the window is unknown", () => {
		const entry = buildRunFinishedEntry("r1", {
			exitCode: 0,
			usage: { turns: 2, cost: 0.01, contextTokens: 50_000 },
		});
		expect(entry.contextPercent).toBeUndefined();
	});
});

describe("normalizeRunFinishedEntry", () => {
	test("round-trips a valid entry", () => {
		const entry = {
			runId: "r1",
			agent: "scout",
			outcome: "finished" as const,
			durationMs: 1000,
			turns: 2,
			cost: 0.01,
			contextPercent: 10,
		};
		expect(normalizeRunFinishedEntry(entry)).toEqual(entry);
	});

	test("rejects data without a usable run id or outcome", () => {
		expect(normalizeRunFinishedEntry(undefined)).toBeUndefined();
		expect(normalizeRunFinishedEntry(null)).toBeUndefined();
		expect(normalizeRunFinishedEntry("r1")).toBeUndefined();
		expect(normalizeRunFinishedEntry({ outcome: "finished" })).toBeUndefined();
		expect(normalizeRunFinishedEntry({ runId: "r1" })).toBeUndefined();
		expect(normalizeRunFinishedEntry({ runId: "r1", outcome: "banana" })).toBeUndefined();
	});

	test("drops malformed numeric and text fields instead of rendering NaN", () => {
		const normalized = normalizeRunFinishedEntry({
			runId: "r1",
			outcome: "finished",
			durationMs: Number.NaN,
			turns: "4",
			cost: Number.POSITIVE_INFINITY,
			agent: "",
		});
		expect(normalized).toEqual({ runId: "r1", outcome: "finished" });
	});
});

describe("entry type", () => {
	test("uses a stable custom type id", () => {
		expect(SUBAGENT_RUN_FINISHED_CUSTOM_TYPE).toBe("subagent-run-finished");
	});
});
