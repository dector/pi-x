import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	REWIRE_PRESET_LIST_HELP,
	RewirePresetListView,
	type RewirePresetListNavigationKey,
	type RewirePresetListResult,
} from "./rewire-preset-list.ts";
import {
	INHERIT_ALL_REWIRE_PRESET,
	INHERIT_REWIRE_PRESET,
	withInheritRewirePreset,
	type RewirePreset,
} from "./rewire-presets.ts";

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";

const presets: RewirePreset[] = [
	{ model: "anthropic/claude", thinkingLevel: "high" },
	{ model: "openai/gpt", thinkingLevel: "medium" },
];

const keys: Record<RewirePresetListNavigationKey, string> = {
	"tui.select.up": UP,
	"tui.select.down": DOWN,
	"tui.select.confirm": ENTER,
	"tui.select.cancel": ESC,
};

function makeView(items: RewirePreset[] = presets, maxVisible?: number) {
	const results: RewirePresetListResult[] = [];
	let renders = 0;
	const view = new RewirePresetListView({
		presets: items,
		theme: { fg: (_color, text) => text, bold: (text) => text },
		keybindings: { matches: (data, binding) => data === keys[binding] },
		requestRender: () => {
			renders += 1;
		},
		done: (result) => results.push(result),
		maxVisible,
	});
	return { view, results, get renders() { return renders; } };
}

describe("RewirePresetListView", () => {
	test("n creates even when the list is empty", () => {
		const { view, results } = makeView([]);
		view.handleInput("n");
		expect(results).toEqual([{ type: "create" }]);
	});

	test("moves, wraps, and applies the preset under the cursor", () => {
		const harness = makeView();
		harness.view.handleInput(DOWN);
		expect(harness.view.selectedIndex).toBe(1);
		expect(harness.renders).toBe(1);
		harness.view.handleInput(DOWN);
		expect(harness.view.selectedIndex).toBe(0);
		harness.view.handleInput(UP);
		expect(harness.view.selectedIndex).toBe(1);
		harness.view.handleInput(ENTER);
		expect(harness.results).toEqual([{ type: "select", index: 1 }]);
	});

	test("d deletes under the cursor and escape cancels", () => {
		const deletion = makeView();
		deletion.view.handleInput(DOWN);
		deletion.view.handleInput("d");
		expect(deletion.results).toEqual([{ type: "delete", index: 1 }]);

		const cancellation = makeView();
		cancellation.view.handleInput(ESC);
		expect(cancellation.results).toEqual([{ type: "cancel" }]);
	});

	test("keeps the built-in Inherit entries first and locked", () => {
		const { view, results } = makeView(withInheritRewirePreset(presets));
		expect(view.selectedIndex).toBe(0);
		view.handleInput("d");
		expect(results).toEqual([]);
		view.handleInput(ENTER);
		expect(results).toEqual([{ type: "select", index: 0 }]);
		const output = view.render(80).join("\n");
		expect(output).toContain("Inherit model");
		expect(output).toContain("Inherit All");
		expect(INHERIT_REWIRE_PRESET.model).toBe("inherit");
		expect(INHERIT_ALL_REWIRE_PRESET.model).toBe("inherit-all");
	});

	test("empty lists ignore apply and delete", () => {
		const { view, results } = makeView([]);
		view.handleInput(ENTER);
		view.handleInput("d");
		expect(results).toEqual([]);
	});

	test("renders labels, empty guidance, key hints, and width-safe lines", () => {
		const populated = makeView().view.render(34);
		expect(populated.join("\n")).toContain("anthropic/claude · high");
		expect(populated.join("\n")).toContain(REWIRE_PRESET_LIST_HELP.slice(0, 10));
		expect(populated.every((line) => visibleWidth(line) <= 34)).toBe(true);

		const empty = makeView([]).view.render(80);
		expect(empty.join("\n")).toContain("Press n to create one");
	});

	test("scrolls around the selected preset", () => {
		const many = Array.from({ length: 6 }, (_value, index) => ({
			model: `provider/model-${index}`,
			thinkingLevel: "low" as const,
		}));
		const { view } = makeView(many, 3);
		for (let index = 0; index < 4; index++) view.handleInput(DOWN);
		const output = view.render(80).join("\n");
		expect(output).toContain("provider/model-4");
		expect(output).toContain("(5/6)");
		expect(output).not.toContain("provider/model-0");
	});
});
