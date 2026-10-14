import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDefaultSafeMode, styleMode } from "./index.ts";

const ctx = {
	ui: { theme: { fg: (_color: string, label: string) => label } },
} as unknown as ExtensionContext;

test("PIX_VM overrides saved defaults, including when empty", () => {
	expect(getDefaultSafeMode(undefined, {})).toBe("smart");
	expect(getDefaultSafeMode("reader", {})).toBe("reader");
	for (const PIX_VM of ["1", "", "0"]) {
		expect(getDefaultSafeMode(undefined, { PIX_VM })).toBe("yolo");
		expect(getDefaultSafeMode("reader", { PIX_VM })).toBe("yolo");
	}
});

test("status bar uses a green VM shield and preserves non-VM labels", () => {
	const previous = process.env.PIX_VM;
	try {
		delete process.env.PIX_VM;
		expect(styleMode(ctx, "yolo", true)).toBe("\x1b[48;5;88;38;2;211;143;143m󰕥\x1b[0m");
		expect(styleMode(ctx, "yolo", false)).toBe("YOLO");
		process.env.PIX_VM = "";
		for (const outerAccess of [false, true]) {
			expect(styleMode(ctx, "yolo", outerAccess)).toBe("\x1b[48;2;33;93;57;38;2;188;228;197m󰕥\x1b[0m");
		}
		expect(styleMode(ctx, "smart", true)).toBe("SMART+");
		expect(styleMode(ctx, "reader", true)).toBe("READER+");
	} finally {
		if (previous === undefined) delete process.env.PIX_VM;
		else process.env.PIX_VM = previous;
	}
});
