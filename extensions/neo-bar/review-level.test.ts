import { describe, expect, test } from "bun:test";
import { formatReviewLevelLabel, isGustHoldSetPayload, isReviewLevelSetPayload } from "./index";
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

	test("accepts Gust hold state only when enabled is boolean", () => {
		expect(isGustHoldSetPayload({ enabled: true })).toBe(true);
		expect(isGustHoldSetPayload({ enabled: false })).toBe(true);
		for (const payload of [undefined, null, {}, { enabled: "yes" }, { enabled: 1 }]) {
			expect(isGustHoldSetPayload(payload)).toBe(false);
		}
	});
});
