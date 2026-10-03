import { describe, expect, test } from "bun:test";
import { showHiDialog } from "./index";

type Dialog = { handleInput: (data: string) => void; render: (width: number) => string[] };
type Context = Parameters<typeof showHiDialog>[0];
type Handlers = Parameters<typeof showHiDialog>[1];
type Lifecycle = Parameters<typeof showHiDialog>[2];

function openDialog(initiallyLocked = false, gustAvailable = true) {
	let dialog!: Dialog;
	let done!: () => void;
	let renders = 0;
	let closes = 0;
	let reader = false;
	let outer = false;
	let focus = false;
	let gust = false;
	let doomCalls = 0;
	let rewire = false;
	let newPromptStashCalls = 0;
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
		onToggleFocus: () => { focus = !focus; },
		isFocusEnabled: () => focus,
		onToggleGust: () => { gust = !gust; renderFromEvent?.(); },
		isGustEnabled: () => gust,
		isGustAvailable: () => gustAvailable,
		onShowPromptPreviews: () => {},
		onPromptStashStash: () => {},
		onPromptStashNew: () => { newPromptStashCalls++; },
		onPromptStashPop: () => {},
		onPromptStashList: () => {},
		onPromptStashClearAll: () => {},
		onOpenNote: () => {},
		onListNotes: () => {},
		onToggleAgentsRewire: () => { rewire = !rewire; renderFromEvent?.(); },
		onOpenAgentsRewire: () => {},
		onOpenAgentsManager: () => {},
		onOpenModelPresets: () => {},
		isAgentsRewireEnabled: () => rewire,
	} satisfies Handlers;
	const lifecycle = {
		isShown: () => false,
		onShown: () => {},
		onRenderReady: (requestRender: () => void) => { renderFromEvent = requestRender; },
		onHidden: () => { renderFromEvent = undefined; },
	} satisfies Lifecycle;
	const finished = showHiDialog(ctx, handlers, lifecycle);
	return { dialog, finished, get closes() { return closes; }, get renders() { return renders; }, get reader() { return reader; }, get outer() { return outer; }, get focus() { return focus; }, get gust() { return gust; }, get doomCalls() { return doomCalls; }, get rewire() { return rewire; }, get locked() { return locked; }, get newPromptStashCalls() { return newPromptStashCalls; } };
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

	test("stash submenu n opens a new prompt stash composer", async () => {
		const ui = openDialog();
		ui.dialog.handleInput("s");
		expect(ui.dialog.render(80).some((line) => line.includes("New prompt stash"))).toBe(true);
		ui.dialog.handleInput("n");
		await ui.finished;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ui.newPromptStashCalls).toBe(1);
		expect(ui.closes).toBe(1);
	});

	test("More contains the Gust toggle without a hotkey", async () => {
		const ui = openDialog();
		const lines = ui.dialog.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
		expect(lines.join("\n")).toMatch(/More ›[^]*Focus mode/);
		expect(lines.find((line) => line.includes("More ›"))!.indexOf("··")).toBe(
			lines.find((line) => line.includes("Prompt stash ›"))!.indexOf("··"),
		);
		ui.dialog.handleInput("M");
		expect(ui.dialog.render(80).join("\n")).not.toContain("Quick actions / More");
		for (let i = 0; i < 11; i++) ui.dialog.handleInput("\x1b[B");
		ui.dialog.handleInput("\r");
		await tick();
		const text = ui.dialog.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(text).toContain("Quick actions / More");
		expect(text).not.toContain("Focus mode");
		expect(text).not.toContain("Reader mode");
		expect(text).toMatch(/Toggle Gust\s+○─/);
		ui.dialog.handleInput("g"); // No hotkey assigned.
		expect(ui.gust).toBe(false);
		ui.dialog.handleInput("\r");
		await tick();
		expect(ui.gust).toBe(true);
		expect(ui.dialog.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/Toggle Gust\s+─●/);
		ui.dialog.handleInput("\r");
		await tick();
		expect(ui.gust).toBe(false);
		expect(ui.reader).toBe(false);
		expect(ui.closes).toBe(0);
		ui.dialog.handleInput("\x1b[D");
		expect(ui.dialog.render(80).join("\n")).toContain("Focus mode");
		ui.dialog.handleInput("\x1b");
		await ui.finished;
	});

	test("Gust toggle is inactive when Gust is not detected, including in search", async () => {
		const ui = openDialog(false, false);
		for (let i = 0; i < 11; i++) ui.dialog.handleInput("\x1b[B");
		ui.dialog.handleInput("\r");
		await tick();
		expect(ui.dialog.render(80).join("\n")).toContain("Toggle Gust");
		ui.dialog.handleInput("\r");
		await tick();
		expect(ui.gust).toBe(false);
		expect(ui.closes).toBe(0);
		ui.dialog.handleInput("/");
		for (const char of "gust") ui.dialog.handleInput(char);
		ui.dialog.handleInput("\r");
		await tick();
		expect(ui.gust).toBe(false);
		expect(ui.closes).toBe(0);
		ui.dialog.handleInput("\x1b");
		ui.dialog.handleInput("\x1b");
		await ui.finished;
	});

	test("Gust toggle is searchable from the main menu", async () => {
		const ui = openDialog();
		ui.dialog.handleInput("/");
		for (const char of "gust") ui.dialog.handleInput(char);
		expect(ui.dialog.render(80).join("\n")).toContain("Toggle Gust");
		ui.dialog.handleInput("\r");
		await tick();
		expect(ui.gust).toBe(true);
		expect(ui.closes).toBe(0);
		ui.dialog.handleInput("\x1b");
		ui.dialog.handleInput("\x1b");
		await ui.finished;
	});

	test("Ctrl+f toggles focus mode and closes the dialog", async () => {
		const ui = openDialog();
		ui.dialog.handleInput("\x06"); // Ctrl+f
		await ui.finished;
		expect(ui.focus).toBe(true);
		expect(ui.closes).toBe(1);
	});

	test("Enter on focus mode keeps the dialog open", async () => {
		const ui = openDialog();
		for (let i = 0; i < 12; i++) ui.dialog.handleInput("\x1b[B"); // Focus mode
		ui.dialog.handleInput("\r");
		await tick();
		expect(ui.focus).toBe(true);
		expect(ui.closes).toBe(0);
		ui.dialog.handleInput("\x1b");
		await ui.finished;
	});

	test("Enter on rewire keeps the dialog open and redraws on state change", async () => {
		const ui = openDialog();
		for (let i = 0; i < 6; i++) ui.dialog.handleInput("\x1b[B"); // Rewire agents
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
		expect(text).toMatch(/New note[^]*Focus mode[^]*Lock/);
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
