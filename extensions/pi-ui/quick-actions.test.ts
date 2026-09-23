import { describe, expect, test } from "bun:test";
import { showHiDialog } from "./index";

type Dialog = { handleInput: (data: string) => void; render: (width: number) => string[] };
type Context = Parameters<typeof showHiDialog>[0];
type Handlers = Parameters<typeof showHiDialog>[1];
type Lifecycle = Parameters<typeof showHiDialog>[2];

function openDialog() {
	let dialog!: Dialog;
	let done!: () => void;
	let renders = 0;
	let closes = 0;
	let reader = false;
	let outer = false;
	let rewire = false;
	let renderFromEvent: (() => void) | undefined;
	const ctx = {
		hasUI: true,
		sessionManager: { getBranch: () => [] },
		ui: {
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => Dialog) =>
				new Promise<void>((resolve) => {
					done = () => { closes++; resolve(); };
					dialog = factory({ requestRender: () => renders++ }, {}, {}, done);
				}),
		},
	} as unknown as Context;
	const handlers = {
		onToggleReader: () => { reader = !reader; },
		onToggleOuter: () => { outer = !outer; },
		onSetYoloPlus: () => {},
		onShowPromptPreviews: () => {},
		onPromptStashStash: () => {},
		onPromptStashPop: () => {},
		onPromptStashList: () => {},
		onPromptStashClearAll: () => {},
		onOpenNote: () => {},
		onListNotes: () => {},
		onToggleAgentsRewire: () => { rewire = !rewire; renderFromEvent?.(); },
		onOpenAgentsRewire: () => {},
		onOpenAgentsManager: () => {},
		isAgentsRewireEnabled: () => rewire,
	} satisfies Handlers;
	const lifecycle = {
		isShown: () => false,
		onShown: () => {},
		onRenderReady: (requestRender: () => void) => { renderFromEvent = requestRender; },
		onHidden: () => { renderFromEvent = undefined; },
	} satisfies Lifecycle;
	const finished = showHiDialog(ctx, handlers, lifecycle);
	return { dialog, finished, get closes() { return closes; }, get renders() { return renders; }, get reader() { return reader; }, get outer() { return outer; }, get rewire() { return rewire; } };
}

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("quick actions", () => {
	test("Enter toggles without closing; a hotkey still closes", async () => {
		const ui = openDialog();
		// Reader mode is the first access & safety action.
		ui.dialog.handleInput("\r");
		await tick();
		expect(ui.reader).toBe(true);
		expect(ui.closes).toBe(0);
		expect(ui.renders).toBeGreaterThan(0);
		ui.dialog.handleInput("r");
		await ui.finished;
		expect(ui.reader).toBe(false);
		expect(ui.closes).toBe(1);
	});

	test("Enter on rewire keeps the dialog open and redraws on state change", async () => {
		const ui = openDialog();
		for (let i = 0; i < 5; i++) ui.dialog.handleInput("\x1b[B"); // Rewire agents
		ui.dialog.handleInput("\r");
		await tick();
		expect(ui.rewire).toBe(true);
		expect(ui.closes).toBe(0);
		expect(ui.renders).toBeGreaterThan(0);
		ui.dialog.handleInput("\x1b");
		await ui.finished;
	});

	test("rewire hotkey still closes the dialog", async () => {
		const ui = openDialog();
		ui.dialog.handleInput("\x12"); // Ctrl+r
		await ui.finished;
		expect(ui.rewire).toBe(true);
		expect(ui.closes).toBe(1);
	});

	test("Enter on a search result toggle stays open", async () => {
		const ui = openDialog();
		ui.dialog.handleInput("/");
		for (const char of "outer") ui.dialog.handleInput(char);
		ui.dialog.handleInput("\r");
		await tick();
		expect(ui.outer).toBe(true);
		expect(ui.closes).toBe(0);
		ui.dialog.handleInput("\r"); // Search and selection should still be active.
		await tick();
		expect(ui.outer).toBe(false);
		expect(ui.reader).toBe(false);
		expect(ui.closes).toBe(0);
		ui.dialog.handleInput("\x1b"); // Exit search.
		ui.dialog.handleInput("\x1b"); // Close dialog.
		await ui.finished;
	});
});
