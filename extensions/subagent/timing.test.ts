import { describe, expect, test } from "bun:test";
import { formatDuration, formatSubagentTiming, SubagentTimingTracker } from "./timing.ts";

describe("subagent timing", () => {
	test("classifies API, unioned parallel tools, and overhead", () => {
		const tracker = new SubagentTimingTracker(0);
		tracker.record({ type: "turn_start" }, 10);
		tracker.record({ type: "message_end", message: { role: "assistant" } }, 60);
		tracker.record({ type: "tool_execution_start", toolCallId: "a" }, 70);
		tracker.record({ type: "tool_execution_start", toolCallId: "b" }, 80);
		tracker.record({ type: "tool_execution_end", toolCallId: "a" }, 100);
		tracker.record({ type: "tool_execution_end", toolCallId: "b" }, 120);

		expect(tracker.finish(150)).toEqual({ wallMs: 150, apiMs: 50, toolsMs: 50, overheadMs: 50 });
	});

	test("gives tool time precedence if event phases overlap", () => {
		const tracker = new SubagentTimingTracker(0);
		tracker.record({ type: "turn_start" }, 10);
		tracker.record({ type: "tool_execution_start", toolCallId: "a" }, 20);
		tracker.record({ type: "tool_execution_end", toolCallId: "a" }, 40);
		tracker.record({ type: "message_end", message: { role: "assistant" } }, 60);

		expect(tracker.finish(60)).toEqual({ wallMs: 60, apiMs: 30, toolsMs: 20, overheadMs: 10 });
	});

	test("formats concise summaries", () => {
		expect(formatDuration(42)).toBe("42ms");
		expect(formatDuration(420)).toBe("0.4s");
		expect(formatDuration(42_340)).toBe("42.3s");
		expect(formatDuration(72_000)).toBe("1m 12s");
		expect(formatSubagentTiming({ wallMs: 42_300, apiMs: 31_800, toolsMs: 9_700, overheadMs: 800 }, "failed"))
			.toBe("Failed after 42.3s — API 31.8s, tools 9.7s, overhead 0.8s");
	});
});
