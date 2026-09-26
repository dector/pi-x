import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { centerProgressLine, progressFooterLines, wrapProgressText } from "./index.ts";

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

describe("centerProgressLine", () => {
	test("centers without trailing padding", () => {
		expect(centerProgressLine("abc", 9)).toBe("   abc");
	});

	test("computes width ignoring ANSI codes", () => {
		const centered = centerProgressLine("\u001b[35mabc\u001b[0m", 9);
		expect(centered.startsWith("   \u001b[35m")).toBe(true);
	});
});

describe("progressFooterLines", () => {
	test("uses the full text when it fits", () => {
		expect(progressFooterLines({ width: 40, full: "Stage 1/3", compact: "S 1/3" })).toEqual(["Stage 1/3"]);
	});

	test("uses the compact form when the full text does not fit", () => {
		expect(
			progressFooterLines({
				width: 26,
				full: "Milestone 1/3: Implement network",
				compact: "M 1/3: Implement network",
			}),
		).toEqual(["M 1/3: Implement network"]);
	});

	test("wraps to at most three lines with an ellipsis", () => {
		const lines = progressFooterLines({ width: 6, full: "aaaa bbbb cccc dddd eeee ffff" });
		expect(lines.length).toBe(3);
		expect(lines[2]).toContain("...");
	});

	test("returns no lines for a non-positive width", () => {
		expect(progressFooterLines({ width: 0, full: "x" })).toEqual([]);
	});
});
