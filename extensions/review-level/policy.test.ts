import { describe, expect, test } from "bun:test";
import {
	parseReviewLevel,
	REVIEW_LEVEL_ICONS,
	reviewGuidance,
	reviewStatusIcon,
} from "./policy";

describe("review-level policy", () => {
	test("parses only supported levels", () => {
		expect(parseReviewLevel(" HIGH ")).toBe("high");
		expect(parseReviewLevel("low")).toBeUndefined();
		expect(parseReviewLevel(1)).toBeUndefined();
	});

	test("uses the selected Nerd Font eye family", () => {
		expect(REVIEW_LEVEL_ICONS).toEqual({
			auto: "󰈈",
			off: "󰛑",
			minimal: "󱀧",
			normal: "󰛐",
			high: "󰡬",
		});
		expect(reviewStatusIcon("normal")).toBe("󰛐");
	});

	test("auto adds no hint and explicit levels add focused guidance", () => {
		expect(reviewGuidance("auto")).toBeUndefined();
		expect(reviewGuidance("off")).toContain("do not launch reviewer subagents");
		expect(reviewGuidance("minimal")).toContain("small non-critical implementation issues are acceptable");
		expect(reviewGuidance("normal")).toContain("one proportionate review pass");
		expect(reviewGuidance("high")).toContain("resolve critical and important findings");
	});
});
