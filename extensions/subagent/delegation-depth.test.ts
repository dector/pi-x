import { describe, expect, test } from "bun:test";
import {
	canDelegate,
	childSubagentDepth,
	DEFAULT_SUBAGENT_DEPTH,
	initialSubagentDepth,
	parseSubagentDepth,
} from "./delegation-depth.ts";

describe("subagent delegation depth", () => {
	test("defaults the main process to top-level-only", () => {
		expect(initialSubagentDepth({}, false)).toBe(DEFAULT_SUBAGENT_DEPTH);
	});

	test("defaults a child without an explicit budget to disabled", () => {
		expect(initialSubagentDepth({}, true)).toBe(-1);
	});

	test("uses separate main and child environment values", () => {
		const env = { PI_SUBAGENT_MAX_DEPTH: "3", PI_SUBAGENT_REMAINING_DEPTH: "1" };
		expect(initialSubagentDepth(env, false)).toBe(3);
		expect(initialSubagentDepth(env, true)).toBe(1);
	});

	test("decrements and floors each child budget at disabled", () => {
		expect(childSubagentDepth(2)).toBe(1);
		expect(childSubagentDepth(0)).toBe(-1);
		expect(childSubagentDepth(-1)).toBe(-1);
	});

	test("allows delegation at zero but not at minus one", () => {
		expect(canDelegate(0)).toBe(true);
		expect(canDelegate(-1)).toBe(false);
	});

	test("rejects malformed values and clamps large values", () => {
		expect(parseSubagentDepth("1.5", 0)).toBe(0);
		expect(parseSubagentDepth("nope", -1)).toBe(-1);
		expect(parseSubagentDepth("99", 0)).toBe(8);
		expect(parseSubagentDepth("-99", 0)).toBe(-1);
	});
});
