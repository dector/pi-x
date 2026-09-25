import { describe, expect, test } from "bun:test";
import { showHiDialog } from "./index";

type Dialog = { handleInput: (data: string) => void; render: (width: number) => string[] };
type Context = Parameters<typeof showHiDialog>[0];
type Handlers = Parameters<typeof showHiDialog>[1];
type Lifecycle = Parameters<typeof showHiDialog>[2];

function openDialog(initiallyLocked = false) {
	let dialog!: Dialog;
	let done!: () => void;
	let renders = 0;
	let closes = 0;
	let reader = false;
	let outer = false;
	let doomCalls = 0;
	let rewire = false;
	let locked = initiallyLocked;
	let renderFromEvent: (() => void) | undefined;
	const ctx = {
		hasUI: true,
		sessionManager: { getBranch: () => [] },
		ui: {
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => Dialog) =>
				new Promise<void>((resolve) => {
					done = () => { closes++; resolve(); };
					dialog = factory({ requestRender: () => renders++ }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, done);
				}),
		},
	} as unknown as Context;
	const handlers = {
		onToggleReader: () => { reader = !reader; },
		onToggleLock: () => { locked = !locked; },
		isLocked: () => locked,
		onToggleOuter: () => { outer = !outer; },
		onSetYoloPlus: () => { doomCalls++; },
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
	return { dialog, finished, get closes() { return closes; }, get renders() { return renders; }, get reader() { return reader; }, get outer() { return outer; }, get doomCalls() { return doomCalls; }, get rewire() { return rewire; }, get locked() { return locked; } };
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

	test("DANGER mode uses Ctrl+d to toggle yolo+ and closes the dialog", async () => {
		const ui = openDialog();
		const text = ui.dialog.render(80).join("\n");
		expect(text).toMatch(/DANGER mode\s+Ctrl\+d/);
		expect(text).not.toContain("YOLO+");
		ui.dialog.handleInput("!");
		await tick();
		expect(ui.doomCalls).toBe(0);
		expect(ui.closes).toBe(0);
		ui.dialog.handleInput("\x04"); // Ctrl+d
		await ui.finished;
		expect(ui.doomCalls).toBe(1);
		expect(ui.closes).toBe(1);
	});

	test("rewire hotkey still closes the dialog", async () => {
		const ui = openDialog();
		ui.dialog.handleInput("\x12"); // Ctrl+r
		await ui.finished;
		expect(ui.rewire).toBe(true);
		expect(ui.closes).toBe(1);
	});

	test("lock is the last, unheaded group; locked dialog only runs unlock", async () => {
		const ui = openDialog();
		const text = ui.dialog.render(80).join("\n");
		expect(text).toMatch(/New note[^]*Lock/);
		expect(text).not.toContain("Shift+L");
		expect(text).toMatch(/Lock\s+L/);
		ui.dialog.handleInput("L");
		await ui.finished;
		expect(ui.locked).toBe(true);

		const again = openDialog(true);
		expect(again.dialog.render(80).join("\n")).not.toContain("Reader mode");
		again.dialog.handleInput("r");
		await tick();
		expect(again.reader).toBe(false);
		again.dialog.handleInput("\r");
		await again.finished;
		expect(again.locked).toBe(false);
		expect(again.closes).toBe(1);
	});

	test("only uppercase L toggles lock; lowercase l does nothing", async () => {
		const ui = openDialog();
		ui.dialog.handleInput("l");
		await tick();
		expect(ui.locked).toBe(false);
		expect(ui.closes).toBe(0);
		ui.dialog.handleInput("L");
		await ui.finished;
		expect(ui.locked).toBe(true);
	});

	test("unlock via hotkey closes the dialog", async () => {
		const ui = openDialog(true);
		ui.dialog.handleInput("l");
		await tick();
		expect(ui.locked).toBe(true);
		ui.dialog.handleInput("L");
		await ui.finished;
		expect(ui.locked).toBe(false);
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
