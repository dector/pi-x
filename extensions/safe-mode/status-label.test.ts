import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { styleMode } from "./index.ts";

const ctx = {
	ui: { theme: { fg: (_color: string, label: string) => label } },
} as unknown as ExtensionContext;

test("status bar shows DGR for yolo+", () => {
	expect(styleMode(ctx, "yolo", true)).toBe("\x1b[48;5;88;38;2;211;143;143mDGR\x1b[0m");
	expect(styleMode(ctx, "yolo", false)).toBe("YOLO");
	expect(styleMode(ctx, "smart", true)).toBe("SMART+");
	expect(styleMode(ctx, "reader", true)).toBe("READER+");
});
