import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { FrameStatusEditor } from "./index.ts";

type Options = ConstructorParameters<typeof FrameStatusEditor>[3];
const originalEnv = process.env.PIX_ANIMATE_PROGRESS;
const editors: FrameStatusEditor[] = [];
const label = "󰙴 cdx/5.6-sol · high";
const indicator = {} as NonNullable<Parameters<FrameStatusEditor["setWorkingStatusIndicator"]>[0]>;

afterEach(() => {
	for (const editor of editors.splice(0)) editor.stopWorkingAnimation();
	if (originalEnv === undefined) delete process.env.PIX_ANIMATE_PROGRESS;
	else process.env.PIX_ANIMATE_PROGRESS = originalEnv;
});

function makeEditor(style: "comet" | "glitch" = "comet") {
	const editor = new FrameStatusEditor(
		{ requestRender() {}, terminal: { rows: 40 } } as ConstructorParameters<typeof FrameStatusEditor>[0],
		{ borderColor: (text: string) => `\x1b[35m${text}\x1b[39m` } as ConstructorParameters<typeof FrameStatusEditor>[1],
		{} as ConstructorParameters<typeof FrameStatusEditor>[2],
		{
			getDisplayMode: () => "new",
			getWorkingAnimation: () => style,
			topLeft: () => label,
			highlightColor: (text) => `\x1b[97m${text}\x1b[39m`,
			interruptConfirmation: {} as Options["interruptConfirmation"],
		},
	);
	editors.push(editor);
	return editor;
}

describe("working model label", () => {
	for (const value of [undefined, "", "0", "true", "01", "1 "]) {
		test(`no animation timer unless exact opt-in (env=${String(value)})`, () => {
			if (value === undefined) delete process.env.PIX_ANIMATE_PROGRESS;
			else process.env.PIX_ANIMATE_PROGRESS = value;
			const editor = makeEditor("glitch");
			const timer = spyOn(globalThis, "setInterval");
			try {
				editor.setWorkingStatusIndicator(indicator);
				expect(timer).not.toHaveBeenCalled();
				const top = editor.render(100)[0]!;
				expect(top).toContain(`\x1b[32m${label}\x1b[39m`);
				expect(editor.render(100)[0]).toBe(top);
			} finally {
				timer.mockRestore();
			}
		});
	}

	for (const style of ["comet", "glitch"] as const) {
		test(`exact opt-in starts ${style} timer and clears it on idle`, () => {
			process.env.PIX_ANIMATE_PROGRESS = "1";
			const editor = makeEditor(style);
			const timer = spyOn(globalThis, "setInterval");
			const clear = spyOn(globalThis, "clearInterval");
			try {
				editor.setWorkingStatusIndicator(indicator);
				expect(timer).toHaveBeenCalledTimes(1);
				expect(timer.mock.calls[0]?.[1]).toBe(style === "comet" ? 60 : 70);
				expect(editor.render(100)[0]).not.toContain(`\x1b[32m${label}`);
				editor.setWorkingStatusIndicator(undefined);
				expect(clear).toHaveBeenCalledTimes(1);
			} finally {
				timer.mockRestore();
				clear.mockRestore();
			}
		});
	}

	test("idle styling and provider/model/effort formatting survive working transitions", () => {
		delete process.env.PIX_ANIMATE_PROGRESS;
		const editor = makeEditor();
		const idle = editor.render(100)[0]!;
		expect(idle).toContain("\x1b[35m");
		expect(idle).not.toContain("\x1b[32m");
		editor.setWorkingStatusIndicator(indicator);
		expect(editor.render(100)[0]).toContain(`\x1b[32m${label}\x1b[39m`);
		editor.setWorkingStatusIndicator(undefined);
		expect(editor.render(100)[0]).toBe(idle);
	});
});
