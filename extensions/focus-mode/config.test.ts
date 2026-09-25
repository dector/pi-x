import { describe, expect, test } from "bun:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import {
	BIAS_PRESETS,
	FocusModeConfigDialog,
	mergePreset,
	previewFor,
	renderBarBlock,
	step,
	WIDTH_PRESETS,
} from "./config";
import type { FocusModeStateV1 } from "./state";

const COLORS = {
	accent: 39, border: 39, borderAccent: 39, borderMuted: 39, success: 39, error: 39, warning: 39,
	muted: 39, dim: 39, text: 39, thinkingText: 39, scrollbarTrack: 39, scrollbarThumb: 39,
	searchMatchText: 39, userMessageText: 39, customMessageText: 39, customMessageLabel: 39,
	toolTitle: 39, toolOutput: 39, mdHeading: 39, mdLink: 39, mdLinkUrl: 39, mdCode: 39,
	mdCodeBlock: 39, mdCodeBlockBorder: 39, mdQuote: 39, mdQuoteBorder: 39, mdHr: 39,
	mdListBullet: 39, toolDiffAdded: 39, toolDiffRemoved: 39, toolDiffContext: 39,
	syntaxComment: 39, syntaxKeyword: 39, syntaxFunction: 39, syntaxVariable: 39,
	syntaxString: 39, syntaxPunctuation: 39, syntaxTag: 39, thinkingOff: 39, thinkingMinimal: 39,
	thinkingLow: 39, thinkingMedium: 39, thinkingHigh: 39, thinkingXhigh: 39, thinkingMax: 39,
	bashMode: 39,
} as unknown as ConstructorParameters<typeof Theme>[0];
const BACKGROUND = {
	selectedBg: 0, searchMatchBg: 0, userMessageBg: 0, customMessageBg: 0,
	toolPendingBg: 0, toolSuccessBg: 0, toolErrorBg: 0,
} as unknown as ConstructorParameters<typeof Theme>[1];
const theme = new Theme(COLORS, BACKGROUND, "truecolor");

const base = (over: Partial<FocusModeStateV1> = {}): FocusModeStateV1 => ({ version: 1, enabled: true, width: 100, bias: 0, ...over });

interface Harness {
	dialog: FocusModeConfigDialog;
	applied: () => { state: FocusModeStateV1; persist: boolean } | null;
	closed: () => number;
	press: (...keys: string[]) => void;
	render: (width?: number) => string[];
}

function harness(term: number, over: Partial<FocusModeStateV1> = {}): Harness {
	const tui = { requestRender: () => {} } as unknown as ConstructorParameters<typeof FocusModeConfigDialog>[0];
	let applied: { state: FocusModeStateV1; persist: boolean } | null = null;
	let closed = 0;
	const dialog = new FocusModeConfigDialog(
		tui,
		theme,
		() => term,
		base(over),
		(state, persist) => {
			applied = { state, persist };
		},
		() => {
			closed += 1;
		},
	);
	return {
		dialog,
		applied: () => applied,
		closed: () => closed,
		press: (...keys) => keys.forEach((key) => dialog.handleInput(key)),
		render: (width = 100) => dialog.render(width).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")),
	};
}

const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", esc: "\x1b" } as const;

describe("mergePreset", () => {
	test("keeps a preset list untouched", () => {
		expect(mergePreset(100, WIDTH_PRESETS)).toEqual([80, 100, 120]);
		expect(mergePreset(0, BIAS_PRESETS)).toEqual([-100, -80, -25, 0, 25, 80, 100]);
	});

	test("splices a custom value into the sorted list", () => {
		expect(mergePreset(90, WIDTH_PRESETS)).toEqual([80, 90, 100, 120]);
		expect(mergePreset(200, WIDTH_PRESETS)).toEqual([80, 100, 120, 200]);
		expect(mergePreset(-50, BIAS_PRESETS)).toEqual([-100, -80, -50, -25, 0, 25, 80, 100]);
	});

	test("does not duplicate a value that is already a preset", () => {
		expect(mergePreset(80, WIDTH_PRESETS)).toEqual([80, 100, 120]);
	});
});

describe("step", () => {
	test("moves and clamps", () => {
		expect(step(100, 5, 20, 2000)).toBe(105);
		expect(step(100, -5, 20, 2000)).toBe(95);
		expect(step(22, -5, 20, 2000)).toBe(20);
		expect(step(1998, 5, 20, 2000)).toBe(2000);
	});
});

describe("previewFor", () => {
	test("splits the screen into margin, column and remainder", () => {
		const preview = previewFor(240, base({ width: 100 }));
		expect(preview).toMatchObject({ realWidth: 240, enabled: true, margin: 70, effective: 100, right: 70, inert: false });
	});

	test("a column wider than the screen is inert", () => {
		const preview = previewFor(80, base({ width: 140 }));
		expect(preview).toMatchObject({ effective: 80, margin: 0, right: 0, inert: true });
	});

	test("disabled uses the whole screen", () => {
		const preview = previewFor(240, base({ enabled: false }));
		expect(preview).toMatchObject({ effective: 240, margin: 0, inert: false });
	});
});

describe("renderBarBlock", () => {
	test("puts the numbers under the bar and centers the terminal width above it", () => {
		const lines = renderBarBlock(previewFor(240, base({ width: 100 })), 30, "  ");
		expect(lines).toHaveLength(5);
		expect(lines[0]?.trim()).toBe("240");
		expect([...lines[0]!].length).toBe(34);
		expect(lines[1]).toBe("  ┌" + "─".repeat(30) + "┐");
		// margin left, width under the block, remainder right
		expect(lines[4]?.trim()).toBe("70            100           70");
	});

	test("a dotted bar when disabled", () => {
		const lines = renderBarBlock(previewFor(240, base({ enabled: false })), 20, "");
		expect(lines[2]).toBe("│" + "·".repeat(20) + "│");
	});

	test("the three bar lines are all the same width", () => {
		for (const width of [40, 80, 240]) {
			for (const state of [base(), base({ bias: -100 }), base({ bias: 100 }), base({ enabled: false })]) {
				const [, top, bar, bottom] = renderBarBlock(previewFor(width, state), 30, "  ");
				expect([...top!].length).toBe(34);
				expect([...bar!].length).toBe(34);
				expect([...bottom!].length).toBe(34);
			}
		}
	});
});

describe("navigation", () => {
	test("j and k move between rows and stop at the ends", () => {
		const { dialog, press } = harness(240);
		expect(dialog.selectedRow).toBe("enabled");
		press("j");
		expect(dialog.selectedRow).toBe("width");
		press("j", "j", "j", "j", "j");
		expect(dialog.selectedRow).toBe("apply-session");
		press("k");
		expect(dialog.selectedRow).toBe("apply");
		press("k", "k", "k", "k", "k", "k");
		expect(dialog.selectedRow).toBe("enabled");
	});

	test("arrow keys work too", () => {
		const { dialog, press } = harness(240);
		press(KEY.down, KEY.down);
		expect(dialog.selectedRow).toBe("bias");
		press(KEY.up);
		expect(dialog.selectedRow).toBe("width");
	});
});

describe("editing", () => {
	test("h and l step the width, H and L nudge it", () => {
		const { dialog, press } = harness(240);
		press("j");
		press("l");
		expect(dialog.state.width).toBe(105);
		press("h");
		expect(dialog.state.width).toBe(100);
		press("L");
		expect(dialog.state.width).toBe(101);
		press("H", "H", "H");
		expect(dialog.state.width).toBe(98);
	});

	test("h and l step the bias by 25 and H and L by 5", () => {
		const { dialog, press } = harness(240);
		press("j", "j");
		press("l");
		expect(dialog.state.bias).toBe(25);
		press("h", "h");
		expect(dialog.state.bias).toBe(-25);
		press("L", "L");
		expect(dialog.state.bias).toBe(-15);
	});

	test("the width clamps to the supported range", () => {
		const { dialog, press } = harness(240, { width: 1995 });
		press("j", "l");
		expect(dialog.state.width).toBe(2000);
	});

	test("enter toggles enabled", () => {
		const { dialog, press } = harness(240);
		press(KEY.enter);
		expect(dialog.state.enabled).toBe(false);
		press(KEY.enter);
		expect(dialog.state.enabled).toBe(true);
	});

	test("l and h on the enabled row turn it on and off", () => {
		const { dialog, press } = harness(240, { enabled: false });
		press("l");
		expect(dialog.state.enabled).toBe(true);
		press("h");
		expect(dialog.state.enabled).toBe(false);
	});

	test("0 centers the bias from any row", () => {
		const { dialog, press } = harness(240, { bias: -75 });
		press("0");
		expect(dialog.state.bias).toBe(0);
	});

	test("r resets only the selected row", () => {
		const { dialog, press } = harness(240, { width: 137, bias: -60 });
		press("j", "r");
		expect(dialog.state).toMatchObject({ width: 100, bias: -60 });
		press("j", "r");
		expect(dialog.state).toMatchObject({ width: 100, bias: 0 });
	});

	test("R resets everything but not the terminal", () => {
		const { dialog, press } = harness(240, { enabled: false, width: 137, bias: -60 });
		press("R");
		expect(dialog.state).toEqual(base());
	});
});

describe("preset scroller", () => {
	test("enter on width opens the presets with the current value selected", () => {
		const { dialog, press } = harness(240);
		press("j", KEY.enter);
		expect(dialog.mode_).toBe("preset");
		expect(dialog.scroller_).toMatchObject({ field: "width", values: [80, 100, 120], index: 1 });
	});

	test("a custom width is spliced into the preset list", () => {
		const { dialog, press } = harness(240, { width: 90 });
		press("j", KEY.enter);
		expect(dialog.scroller_?.values).toEqual([80, 90, 100, 120]);
		expect(dialog.scroller_?.index).toBe(1);
	});

	test("scrolling previews the candidate in the width row before it is committed", () => {
		const { dialog, press } = harness(240, { width: 90 });
		press("j", KEY.enter, "l");
		expect(dialog.state.width).toBe(90);
		// the width row and the scroller both show 100 highlighted, draft still 90
		const text = dialog.render(100).join("\n");
		expect(text).toContain("100");
		expect(text).toContain("[100]");
		press("h");
		expect(dialog.render(100).join("\n")).toContain("[90]");
	});

	test("enter commits the highlighted preset", () => {
		const { dialog, press } = harness(240, { width: 90 });
		press("j", KEY.enter, "l", "l", KEY.enter);
		expect(dialog.mode_).toBe("edit");
		expect(dialog.state.width).toBe(120);
	});

	test("esc leaves the old value in place", () => {
		const { dialog, press } = harness(240, { width: 90 });
		press("j", KEY.enter, "l", "l", KEY.esc);
		expect(dialog.mode_).toBe("edit");
		expect(dialog.state.width).toBe(90);
	});

	test("bias presets carry the custom value too", () => {
		const { dialog, press } = harness(240, { bias: -50 });
		press("j", "j", KEY.enter);
		expect(dialog.scroller_?.values).toEqual([-100, -80, -50, -25, 0, 25, 80, 100]);
		expect(dialog.scroller_?.index).toBe(2);
	});

	test("scrolling stops at the ends of the list", () => {
		const { dialog, press } = harness(240, { bias: 0 });
		press("j", "j", KEY.enter, "h", "h", "h", "h", "h", "h", "h");
		expect(dialog.scroller_?.index).toBe(0);
	});
});

describe("apply", () => {
	test("apply writes the config and closes", () => {
		const { dialog, press, applied, closed } = harness(240);
		press("j", "l", "j", "j", "j", KEY.enter);
		expect(dialog.selectedRow).toBe("apply");
		expect(applied()).toEqual({ state: base({ width: 105 }), persist: true });
		expect(closed()).toBe(1);
	});

	test("apply for session does the same without persisting", () => {
		const { dialog, press, applied, closed } = harness(240);
		press("j", "j", "l"); // width, then bias: bias becomes 25
		press("j", "j", "j", KEY.enter); // reset, apply, apply-session, activate
		expect(dialog.selectedRow).toBe("apply-session");
		expect(applied()).toEqual({ state: base({ bias: 25 }), persist: false });
		expect(closed()).toBe(1);
	});

	test("entering the reset row resets instead of applying", () => {
		const { press, applied } = harness(240, { width: 133 });
		press("j", "j", "j", KEY.enter);
		expect(applied()).toBeNull();
	});
});

describe("closing", () => {
	test("esc on an untouched draft just closes", () => {
		const { dialog, press, closed } = harness(240);
		expect(dialog.pending).toBe(false);
		press(KEY.esc);
		expect(closed()).toBe(1);
		expect(dialog.mode_).toBe("edit");
	});

	test("esc on a changed draft asks first", () => {
		const { dialog, press, closed } = harness(240);
		press("j", "l");
		expect(dialog.pending).toBe(true);
		press(KEY.esc);
		expect(closed()).toBe(0);
		expect(dialog.mode_).toBe("confirm");
	});

	test("save from the prompt applies and persists", () => {
		const { press, applied, closed } = harness(240);
		press("j", "l", KEY.esc, "s");
		expect(applied()).toEqual({ state: base({ width: 105 }), persist: true });
		expect(closed()).toBe(1);
	});

	test("session from the prompt applies without persisting", () => {
		const { press, applied, closed } = harness(240);
		press("j", "l", KEY.esc, "S");
		expect(applied()).toEqual({ state: base({ width: 105 }), persist: false });
		expect(closed()).toBe(1);
	});

	test("discard drops the changes and closes", () => {
		const { dialog, press, applied, closed } = harness(240);
		press("j", "l", KEY.esc, "d");
		expect(applied()).toBeNull();
		expect(closed()).toBe(1);
		expect(dialog.state).toEqual(base());
	});

	test("keep editing returns to the dialog with the draft intact", () => {
		const { dialog, press, closed } = harness(240);
		press("j", "l", KEY.esc, "c");
		expect(closed()).toBe(0);
		expect(dialog.mode_).toBe("edit");
		expect(dialog.state.width).toBe(105);
	});

	test("esc in the prompt goes back to editing", () => {
		const { dialog, press, closed } = harness(240);
		press("j", "l", KEY.esc, KEY.esc);
		expect(closed()).toBe(0);
		expect(dialog.mode_).toBe("edit");
	});
});

describe("rendering", () => {
	test("every line is the same visible width and stays inside the frame", () => {
		const { render, press } = harness(240);
		const widths = (lines: string[]): number[] => lines.map((line) => [...line].length);
		for (const lines of [render(), render(47), render(200)]) {
			expect(new Set(widths(lines)).size).toBe(1);
		}
		press("j", KEY.enter);
		const scroller = render(100);
		expect(new Set(widths(scroller)).size).toBe(1);
	});

	test("the selected row is marked and the values are shown", () => {
		const { render } = harness(240, { bias: -50 });
		const text = render(100).join("\n");
		expect(text).toContain("Focus");
		expect(text).toContain("Enabled");
		expect(text).toContain("● on");
		expect(text).toContain("Bias");
		expect(text).toContain("-50");
		expect(text).toContain("240");
		expect(text).toContain("↺ Reset to defaults");
		expect(text).toContain("Apply for session");
	});

	test("the inert case says why there is no margin", () => {
		const { render } = harness(80, { width: 140 });
		expect(render(100).join("\n")).toContain("no margin, the terminal is only 80 wide");
	});

	test("the preset list keeps the custom value visible", () => {
		const { render, press } = harness(240, { width: 90 });
		press("j", KEY.enter);
		expect(render(100).join("\n")).toContain("80 · [90] · 100 · 120");
	});
});
