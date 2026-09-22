import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { centerProgressLine } from "./index.ts";

describe("centerProgressLine", () => {
	test("centers ANSI-styled text after truncation without trailing padding", () => {
		const purple = "\u001b[35mAuthentication\u001b[0m";
		const centered = centerProgressLine(purple, 20);
		expect(centered.startsWith("   \u001b[35m")).toBe(true);
		expect(centered.endsWith("\u001b[0m")).toBe(true);
		expect(visibleWidth(centered)).toBe(17);

		const truncated = centerProgressLine(purple, 8);
		expect(visibleWidth(truncated)).toBe(8);
		expect(truncated.startsWith(" ")).toBe(false);
	});
});
