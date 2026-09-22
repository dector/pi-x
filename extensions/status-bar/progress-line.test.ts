import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { placeProgress, wrapProgressText } from "./index.ts";

describe("wrapProgressText", () => {
	test("wraps plain text to the requested width", () => {
		const lines = wrapProgressText("alpha beta gamma delta", 10, 3);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => visibleWidth(line) <= 10)).toBe(true);
	});

	test("caps at maxLines and appends an ellipsis", () => {
		const lines = wrapProgressText("aaaa bbbb cccc dddd eeee ffff gggg", 8, 3);
		expect(lines.length).toBe(3);
		expect(lines[2]).toContain("...");
	});

	test("returns no lines for non-positive width or maxLines", () => {
		expect(wrapProgressText("x", 0, 3)).toEqual([]);
		expect(wrapProgressText("x", 10, 0)).toEqual([]);
	});
});

describe("placeProgress", () => {
	const base = { separatorWidth: 3, full: "Stage 1/3", compact: "S 1/3" };

	test("inlines when the line has room", () => {
		const placement = placeProgress({ ...base, width: 40, leftWidth: 6, rightWidth: 0, hasCenter: false });
		expect(placement.inline).toBe(true);
		expect(placement.before).toEqual([]);
	});

	test("inlines into the gap left by a right-aligned section", () => {
		const placement = placeProgress({ ...base, width: 40, leftWidth: 6, rightWidth: 10, hasCenter: false });
		expect(placement.inline).toBe(true);
	});

	test("does not inline when a right section leaves too little room", () => {
		const placement = placeProgress({ ...base, width: 20, leftWidth: 6, rightWidth: 10, hasCenter: false });
		expect(placement.inline).toBe(false);
		expect(placement.before).toEqual(["Stage 1/3"]);
	});

	test("never inlines when the line has a center section", () => {
		const placement = placeProgress({ ...base, width: 80, leftWidth: 6, rightWidth: 0, hasCenter: true });
		expect(placement.inline).toBe(false);
	});

	test("uses the compact form when the full text does not fit the fallback line", () => {
		const placement = placeProgress({
			width: 26,
			leftWidth: 26,
			rightWidth: 0,
			hasCenter: false,
			separatorWidth: 3,
			full: "Milestone 1/3: Implement network",
			compact: "M 1/3: Implement network",
		});
		expect(placement.inline).toBe(false);
		expect(placement.before).toEqual(["M 1/3: Implement network"]);
	});

	test("wraps to at most three lines with an ellipsis", () => {
		const placement = placeProgress({
			width: 6,
			leftWidth: 6,
			rightWidth: 0,
			hasCenter: false,
			separatorWidth: 3,
			full: "aaaa bbbb cccc dddd eeee ffff",
		});
		expect(placement.inline).toBe(false);
		expect(placement.before.length).toBe(3);
		expect(placement.before[2]).toContain("...");
	});
});
