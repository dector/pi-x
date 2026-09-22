/**
 * Focused tests for the `/px:agents` top-level list.
 *
 * These cover the pure row grouping and shortcut eligibility, plus the custom
 * component's navigation, hotkeys, warnings, and width-safe rendering. No Pi
 * runtime or terminal is needed.
 */

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_MANAGER_LIST_VISIBLE,
	MANAGER_LIST_HELP,
	MANAGER_LIST_TITLE,
	ManagerListView,
	buildManagerListRows,
	resolveManagerShortcut,
	type ManagerListItemLike,
	type ManagerListNavigationKey,
	type ManagerListResult,
} from "./manager-list.ts";
import type { ManagerRunDescriptor } from "./manager.ts";

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const LOWER_D = "d";
const UPPER_D = "D";
const CTRL_C = "\x03";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const defaultNavigationKeys: Record<ManagerListNavigationKey, string[]> = {
	"tui.select.up": [UP],
	"tui.select.down": [DOWN],
	"tui.select.confirm": [ENTER],
	"tui.select.cancel": [ESC, CTRL_C],
};

const keybindings = {
	matches: (data: string, keybinding: ManagerListNavigationKey) => defaultNavigationKeys[keybinding].includes(data),
};

function descriptor(overrides: Partial<ManagerRunDescriptor> = {}): ManagerRunDescriptor {
	return {
		runId: "sa-1",
		agentName: "worker",
		task: "do the thing",
		active: true,
		failed: false,
		state: "running",
		mode: "smart",
		...overrides,
	};
}

interface TestItem extends ManagerListItemLike {
	transcript: boolean;
}

function item(overrides: Partial<ManagerRunDescriptor> = {}, transcript = true): TestItem {
	return { descriptor: descriptor(overrides), transcript };
}

interface Harness {
	view: ManagerListView<TestItem>;
	results: ManagerListResult[];
	renders: number;
}

function makeView(items: TestItem[], maxVisible?: number): Harness {
	const results: ManagerListResult[] = [];
	let renders = 0;
	const view = new ManagerListView<TestItem>({
		items,
		theme,
		keybindings,
		requestRender: () => {
			renders += 1;
		},
		done: (result) => {
			results.push(result);
		},
		hasTranscript: (entry) => entry.transcript,
		now: () => 0,
		maxVisible,
	});
	return {
		view,
		results,
		get renders() {
			return renders;
		},
	};
}

describe("buildManagerListRows", () => {
	test("groups active before finished with one separator", () => {
		const rows = buildManagerListRows([
			descriptor({ runId: "active-1", active: true }),
			descriptor({ runId: "finished-1", active: false }),
			descriptor({ runId: "active-2", active: true }),
		]);
		expect(rows).toEqual([
			{ kind: "item", itemIndex: 0 },
			{ kind: "item", itemIndex: 2 },
			{ kind: "separator" },
			{ kind: "item", itemIndex: 1 },
		]);
	});

	test("omits the separator when only one group is present", () => {
		expect(buildManagerListRows([descriptor(), descriptor()])).toEqual([
			{ kind: "item", itemIndex: 0 },
			{ kind: "item", itemIndex: 1 },
		]);
		expect(buildManagerListRows([descriptor({ active: false })])).toEqual([{ kind: "item", itemIndex: 0 }]);
		expect(buildManagerListRows([])).toEqual([]);
	});

	test("emits a header per dispatch and one separator between groups", () => {
		const rows = buildManagerListRows([
			descriptor({ runId: "a", dispatchId: "dp-1", active: true }),
			descriptor({ runId: "b", dispatchId: "dp-1", active: true }),
			descriptor({ runId: "c", dispatchId: "dp-2", active: false }),
		]);
		expect(rows).toEqual([
			{ kind: "batch", groupIndex: 0 },
			{ kind: "item", itemIndex: 0 },
			{ kind: "item", itemIndex: 1 },
			{ kind: "separator" },
			{ kind: "batch", groupIndex: 1 },
			{ kind: "item", itemIndex: 2 },
		]);
	});

	test("keeps dispatch-less singleton runs flat", () => {
		expect(
			buildManagerListRows([descriptor({ runId: "a" }), descriptor({ runId: "b", active: false })]),
		).toEqual([
			{ kind: "item", itemIndex: 0 },
			{ kind: "separator" },
			{ kind: "item", itemIndex: 1 },
		]);
	});
});

describe("resolveManagerShortcut", () => {
	test("lowercase d attaches when a transcript exists", () => {
		expect(resolveManagerShortcut("d", { runId: "sa-1", hasTranscript: true, detachable: false })).toEqual({
			kind: "attach",
		});
	});

	test("lowercase d warns when no transcript exists", () => {
		const outcome = resolveManagerShortcut("d", { runId: "sa-1", hasTranscript: false, detachable: false });
		expect(outcome.kind).toBe("warning");
		expect(outcome.kind === "warning" && outcome.message).toContain("sa-1");
	});

	test("uppercase D detaches only an attached blocking dispatch", () => {
		expect(resolveManagerShortcut("D", { runId: "sa-1", hasTranscript: true, detachable: true })).toEqual({
			kind: "detach",
		});
		const outcome = resolveManagerShortcut("D", { runId: "sa-2", hasTranscript: true, detachable: false });
		expect(outcome.kind).toBe("warning");
		expect(outcome.kind === "warning" && outcome.message).toContain("attached blocking dispatch");
	});
});

describe("ManagerListView", () => {
	test("starts on the first active run", () => {
		const { view } = makeView([
			item({ runId: "active-1", active: true }),
			item({ runId: "finished-1", active: false }),
		]);
		expect(view.selectedItem?.descriptor.runId).toBe("active-1");
	});

	test("arrow navigation skips the separator and wraps", () => {
		const { view } = makeView([
			item({ runId: "active-1" }),
			item({ runId: "finished-1", active: false }),
		]);
		view.handleInput(DOWN);
		expect(view.selectedItem?.descriptor.runId).toBe("finished-1");
		view.handleInput(DOWN);
		expect(view.selectedItem?.descriptor.runId).toBe("active-1");
		view.handleInput(UP);
		expect(view.selectedItem?.descriptor.runId).toBe("finished-1");
	});

	test("j/k navigate like the arrow keys", () => {
		const { view } = makeView([
			item({ runId: "active-1" }),
			item({ runId: "finished-1", active: false }),
		]);
		view.handleInput("j");
		expect(view.selectedItem?.descriptor.runId).toBe("finished-1");
		view.handleInput("k");
		expect(view.selectedItem?.descriptor.runId).toBe("active-1");
	});

	test("enter selects the highlighted run by original index", () => {
		const { view, results } = makeView([
			item({ runId: "active-1" }),
			item({ runId: "finished-1", active: false }),
			item({ runId: "active-2" }),
		]);
		// Rows: [active-1, active-2, separator, finished-1].
		view.handleInput(ENTER);
		expect(results).toEqual([{ type: "select", itemIndex: 0 }]);
		view.handleInput(DOWN);
		view.handleInput(ENTER);
		expect(results[1]).toEqual({ type: "select", itemIndex: 2 });
	});

	test("configured cancel keys close the list", () => {
		const escape = makeView([item()]);
		escape.view.handleInput(ESC);
		expect(escape.results).toEqual([{ type: "cancel" }]);

		const ctrlC = makeView([item()]);
		ctrlC.view.handleInput(CTRL_C);
		expect(ctrlC.results).toEqual([{ type: "cancel" }]);
	});

	test("uses configured navigation and confirmation keys", () => {
		const results: ManagerListResult[] = [];
		const view = new ManagerListView<TestItem>({
			items: [item({ runId: "first" }), item({ runId: "second" })],
			theme,
			keybindings: {
				matches: (data, binding) =>
					({
						"tui.select.up": "k",
						"tui.select.down": "j",
						"tui.select.confirm": "o",
						"tui.select.cancel": "x",
					})[binding] === data,
			},
			requestRender: () => {},
			done: (result) => results.push(result),
			hasTranscript: () => true,
		});
		view.handleInput("j");
		expect(view.selectedItem?.descriptor.runId).toBe("second");
		view.handleInput("o");
		expect(results).toEqual([{ type: "select", itemIndex: 1 }]);
	});

	test("lowercase d attaches the selected live run", () => {
		const { view, results } = makeView([item({ runId: "active-1" })]);
		view.handleInput(LOWER_D);
		expect(results).toEqual([{ type: "attach", itemIndex: 0 }]);
	});

	test("lowercase d attaches a completed persisted run with a transcript", () => {
		const { view, results } = makeView([item({ runId: "sa-old", active: false }, true)]);
		view.handleInput(LOWER_D);
		expect(results).toEqual([{ type: "attach", itemIndex: 0 }]);
	});

	test("ineligible lowercase d stays in the list and warns", () => {
		const { view, results } = makeView([item({ runId: "sa-no-log" }, false)]);
		view.handleInput(LOWER_D);
		expect(results).toEqual([]);
		expect(view.statusMessage).toContain("sa-no-log");
	});

	test("uppercase D detaches only attached blocking dispatches", () => {
		const { view, results } = makeView([
			item({ runId: "attached", attachedBlocking: true, dispatchId: "d1" }),
		]);
		view.handleInput(UPPER_D);
		expect(results).toEqual([{ type: "detach", itemIndex: 0 }]);
	});

	test("ineligible uppercase D stays in the list and warns", () => {
		const { view, results } = makeView([item({ runId: "attached", attachedBlocking: true })]);
		view.handleInput(UPPER_D);
		expect(results).toEqual([]);
		expect(view.statusMessage).toContain("attached blocking dispatch");
	});

	test("moving clears a previous shortcut warning", () => {
		const { view } = makeView([item({ runId: "a" }), item({ runId: "b" })]);
		view.handleInput(UPPER_D);
		expect(view.statusMessage).toBeDefined();
		view.handleInput(DOWN);
		expect(view.statusMessage).toBeUndefined();
	});

	test("renders a blank separator between groups and concise key hints", () => {
		const { view } = makeView([
			item({ runId: "active-1" }),
			item({ runId: "finished-1", active: false }),
		]);
		const lines = view.render(120);
		expect(lines.join("\n")).toContain(MANAGER_LIST_TITLE);
		expect(lines.join("\n")).toContain(MANAGER_LIST_HELP);
		// One blank non-selectable line sits between the active and finished rows.
		const activeLine = lines.findIndex((line) => line.includes("active-1"));
		const finishedLine = lines.findIndex((line) => line.includes("finished-1"));
		expect(activeLine).toBeGreaterThan(-1);
		expect(finishedLine).toBe(activeLine + 2);
		expect(lines[activeLine + 1]).toBe("");
		// The selected row uses the arrow prefix; the separator does not.
		expect(lines.some((line) => line.trimStart().startsWith("→ "))).toBe(true);
	});

	test("shows the inline warning instead of a shortcut-only no-op", () => {
		const { view } = makeView([item({ runId: "sa-1" }, false)]);
		view.handleInput(LOWER_D);
		expect(view.render(120).join("\n")).toContain("No transcript available");
	});

	test("never renders a line wider than the requested width", () => {
		const { view } = makeView(
			[
				item({ runId: "active-with-a-fairly-long-run-identifier", agentName: "worker-with-long-name" }),
				item({ runId: "finished-1", active: false }),
			],
			2,
		);
		const lines = view.render(4);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(4);
	});

	test("scrolls long lists around the selection", () => {
		const items = Array.from({ length: DEFAULT_MANAGER_LIST_VISIBLE + 4 }, (_value, index) =>
			item({ runId: `sa-${index}` }),
		);
		const { view } = makeView(items);
		const first = view.render(80).join("\n");
		expect(first).toContain("(1/");
		for (let index = 0; index < items.length - 1; index++) view.handleInput(DOWN);
		const last = view.render(80).join("\n");
		expect(last).toContain(`(${items.length}/${items.length})`);
	});

	test("renders a batch header with dispatch, execution, count, and summary", () => {
		const { view } = makeView([
			item({ runId: "a", dispatchId: "dp-7c1", execution: "async" }),
			item({ runId: "b", dispatchId: "dp-7c1", execution: "async" }),
		]);
		const text = view.render(120).join("\n");
		expect(text).toContain("dp-7c1");
		expect(text).toContain("async");
		expect(text).toContain("2 runs");
		expect(text).toContain("2 active");
	});

	test("batch headers never exceed the requested width", () => {
		const { view } = makeView([
			item({ runId: "a", dispatchId: "dp-with-a-very-long-identifier", execution: "blocking" }),
			item({ runId: "b", dispatchId: "dp-with-a-very-long-identifier", execution: "blocking" }),
		]);
		for (const line of view.render(10)) expect(visibleWidth(line)).toBeLessThanOrEqual(10);
	});
});
