import { describe, expect, test } from "bun:test";
import { formatResultTiming, formatTokens, formatToolCall, formatToolStatus, formatUsageStats } from "./format.ts";
import type { SingleResult } from "./types.ts";

/** Identity theme so assertions read the raw text. */
const themeFg = (_color: string, text: string) => text;

describe("formatToolCall", () => {
	test("formats common file tools", () => {
		expect(formatToolCall("read", { file_path: "/tmp/x.ts" }, themeFg)).toBe("read /tmp/x.ts");
		expect(formatToolCall("read", { path: "a.ts", offset: 10, limit: 5 }, themeFg)).toBe("read a.ts:10-14");
		expect(formatToolCall("write", { path: "a.ts", content: "a\nb" }, themeFg)).toBe("write a.ts (2 lines)");
		expect(formatToolCall("edit", { path: "a.ts" }, themeFg)).toBe("edit a.ts");
		expect(formatToolCall("grep", { pattern: "foo", path: "." }, themeFg)).toBe("grep /foo/ in .");
	});

	test("falls back to a bounded JSON preview for unknown tools", () => {
		const line = formatToolCall("custom", { a: 1 }, themeFg);
		expect(line).toBe('custom {"a":1}');
	});
});

describe("formatToolStatus", () => {
	test("labels every tool run status", () => {
		expect(formatToolStatus("completed", themeFg)).toContain("completed");
		expect(formatToolStatus("blocked", themeFg)).toContain("blocked");
		expect(formatToolStatus("failed", themeFg)).toContain("failed");
		expect(formatToolStatus("interrupted", themeFg)).toContain("interrupted");
		expect(formatToolStatus("waiting-approval", themeFg)).toContain("waiting approval");
		expect(formatToolStatus("approved", themeFg)).toContain("approved");
		expect(formatToolStatus("running", themeFg)).toContain("running");
	});
});

describe("usage and timing formatting", () => {
	test("formats token counts", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(12345)).toBe("12k");
		expect(formatTokens(2_500_000)).toBe("2.5M");
	});

	test("formats usage stats with context as a percentage", () => {
		const line = formatUsageStats(
			{ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.0123, contextTokens: 5000, turns: 2 },
			"claude",
			"medium",
			20000,
		);
		expect(line).toContain("2 turns");
		expect(line).toContain("↑1.0k");
		expect(line).toContain("↓200");
		expect(line).toContain("$0.0123");
		expect(line).toContain("ctx:25%");
		expect(line).toContain("claude (medium)");
	});

	test("omits context entirely when the window is unknown (percent only)", () => {
		const line = formatUsageStats(
			{ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 5000, turns: 1 },
			"claude",
		);
		expect(line).not.toContain("ctx");
		expect(line).not.toContain("5.0k");
	});

	test("omits timing for a still-running result", () => {
		const running = { exitCode: -1, timing: { wallMs: 10, apiMs: 1, toolsMs: 1, overheadMs: 8 } } as SingleResult;
		expect(formatResultTiming(running)).toBeUndefined();
	});

	test("classifies a settled failed result", () => {
		const failed = {
			exitCode: 1,
			stopReason: "error",
			timing: { wallMs: 42_300, apiMs: 31_800, toolsMs: 9_700, overheadMs: 800 },
		} as SingleResult;
		expect(formatResultTiming(failed)).toContain("Failed after 42.3s");
	});
});
