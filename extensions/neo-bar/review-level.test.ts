import { describe, expect, test } from "bun:test";
import { formatGustIndicator, formatReviewLevelLabel, isGustHoldSetPayload, isReviewLevelSetPayload } from "./index";
import type { NeoBarReviewLevel } from "./contract";

const EXPECTED_ICONS: Record<NeoBarReviewLevel, string> = {
	auto: "󰈈",
	off: "󰛑",
	minimal: "󱀧",
	normal: "󰛐",
	high: "󰡬",
};

describe("neo-bar review-level indicator", () => {
	test("accepts exactly the five supported set payloads", () => {
		for (const level of Object.keys(EXPECTED_ICONS)) {
			expect(isReviewLevelSetPayload({ level })).toBe(true);
		}
		for (const payload of [undefined, null, {}, { level: "low" }, { level: 1 }, "normal"]) {
			expect(isReviewLevelSetPayload(payload)).toBe(false);
		}
	});

	test("hides auto but keeps explicit eye glyphs with trailing space and no embedded color", () => {
		expect(formatReviewLevelLabel("auto")).toBeUndefined();
		for (const level of ["off", "minimal", "normal", "high"] as const) {
			expect(formatReviewLevelLabel(level)).toBe(`${EXPECTED_ICONS[level]} `);
		}
	});

	test("renders Gust only when running and colors its actual pause state", () => {
		expect(formatGustIndicator(false, false)).toBeUndefined();
		expect(formatGustIndicator(false, true)).toBeUndefined();
		expect(formatGustIndicator(true, false)).toContain("38;2;175;135;255");
		expect(formatGustIndicator(true, true)).toContain("38;2;181;154;86");
	});

	test("accepts Gust state only with boolean fields", () => {
		expect(isGustHoldSetPayload({ enabled: true, running: true, paused: true })).toBe(true);
		expect(isGustHoldSetPayload({ enabled: false, running: true, paused: false })).toBe(true);
		for (const payload of [undefined, null, {}, { enabled: true }, { enabled: "yes" }, { enabled: 1 },
			{ enabled: true, running: "yes", paused: false }, { enabled: true, running: true, paused: 1 }]) {
			expect(isGustHoldSetPayload(payload)).toBe(false);
		}
	});
});
