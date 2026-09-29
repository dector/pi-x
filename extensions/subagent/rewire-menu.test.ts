import { describe, expect, test } from "bun:test";
import {
	REWIRE_MENU_HELP,
	RewireMenuView,
	type RewireMenuNavigationKey,
	type RewireMenuResult,
} from "./rewire-menu.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_C = "\x03";
const colors: string[] = [];
const theme = {
	fg: (color: string, text: string) => {
		colors.push(color);
		return text;
	},
	bold: (text: string) => text,
};
const navigationKeys: Record<RewireMenuNavigationKey, string[]> = {
	"tui.select.up": [UP],
	"tui.select.down": [DOWN],
	"tui.select.confirm": [ENTER],
	"tui.select.cancel": [ESC, CTRL_C],
};
const keybindings = {
	matches: (data: string, binding: RewireMenuNavigationKey) => navigationKeys[binding].includes(data),
};

function makeView(overrides: Partial<ConstructorParameters<typeof RewireMenuView>[0]> = {}) {
	const results: RewireMenuResult[] = [];
	let renders = 0;
	const view = new RewireMenuView({
		enabled: true,
		inheritAll: false,
		inheritModel: true,
		theme,
		keybindings,
		requestRender: () => { renders += 1; },
		done: (result) => results.push(result),
		...overrides,
	});
	return { view, results, get renders() { return renders; } };
}

describe("RewireMenuView", () => {
	test("renders Configuration, Inherit All, Inherit Model, and Enabled in order", () => {
		const { view } = makeView({ target: "Inherit model" });
		const lines = view.render(100);
		const rows = lines.filter((line) => /Configuration|Inherit All|Inherit Model|Enabled/.test(line));
		expect(rows).toHaveLength(4);
		expect(rows[0]).toContain("Configuration");
		expect(rows[1]).toContain("Inherit All");
		expect(rows[2]).toContain("Inherit Model");
		expect(rows[3]).toContain("Enabled");
		expect(lines.join("\n")).toContain("Rewiring to Inherit model");
		expect(lines.join("\n")).toContain(REWIRE_MENU_HELP);
	});

	test("aligns toggle indicators and colors the selected row purple", () => {
		colors.length = 0;
		const { view } = makeView();
		const lines = view.render(100);
		const indicators = lines.filter((line) => line.includes("[ON]") || line.includes("[OFF]"));
		expect(indicators).toHaveLength(3);
		expect(new Set(indicators.map((line) => line.indexOf("["))).size).toBe(1);
		expect(colors).toContain("thinkingHigh");
		expect(colors).toContain("success");
		expect(colors).toContain("error");
		expect(colors).toContain("muted");
	});

	test("enter selects Configuration and arrows navigate in menu order", () => {
		const harness = makeView();
		const { view, results } = harness;
		expect(view.selectedAction).toBe("configuration");
		view.handleInput(ENTER);
		expect(results).toEqual([{ type: "configuration" }]);
		view.handleInput(DOWN);
		expect(view.selectedAction).toBe("inherit-all");
		view.handleInput(DOWN);
		expect(view.selectedAction).toBe("inherit-model");
		view.handleInput(DOWN);
		expect(view.selectedAction).toBe("enabled");
		view.handleInput(UP);
		expect(view.selectedAction).toBe("inherit-model");
		expect(harness.renders).toBe(4);
	});

	test("i, I, and e trigger the matching toggle actions", () => {
		const { view, results } = makeView();
		view.handleInput("i");
		view.handleInput("I");
		view.handleInput("e");
		expect(results).toEqual([
			{ type: "inherit-all" },
			{ type: "inherit-model" },
			{ type: "enabled" },
		]);
	});

	test("escape and Ctrl+C cancel the menu", () => {
		const escape = makeView();
		escape.view.handleInput(ESC);
		expect(escape.results).toEqual([{ type: "cancel" }]);
		const ctrlC = makeView();
		ctrlC.view.handleInput(CTRL_C);
		expect(ctrlC.results).toEqual([{ type: "cancel" }]);
	});
});
