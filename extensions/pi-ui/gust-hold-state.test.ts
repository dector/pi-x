import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piUiExtension from "./index";

type Dialog = { handleInput: (data: string) => void; render: (width: number) => string[] };

function startPiUi() {
	const eventHandlers = new Map<string, (payload: unknown) => void>();
	const shortcuts = new Map<string, { description: string; handler: (ctx: ExtensionContext) => unknown }>();
	let dialog!: Dialog;
	const tui = { requestRender() {}, addInputListener: () => () => {} };
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		hasUI: true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme,
			setWidget: (_key: string, factory: (tui: unknown, theme: unknown) => unknown) => { factory(tui, theme); },
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => Dialog) =>
				new Promise<void>((resolve) => { dialog = factory(tui, theme, {}, resolve); }),
		},
	} as unknown as ExtensionContext;
	const pi = {
		events: {
			on: (name: string, handler: (payload: unknown) => void) => eventHandlers.set(name, handler),
			emit() {},
		},
		on() {},
		registerCommand() {},
		registerShortcut: (key: string, options: { description: string; handler: (ctx: ExtensionContext) => unknown }) => shortcuts.set(key, options),
	};
	piUiExtension(pi as unknown as ExtensionAPI);
	const toggleShortcut = [...shortcuts.values()].find(({ description }) => description === "Toggle pi-ui dialog");
	if (!toggleShortcut) throw new Error("pi-ui toggle shortcut was not registered");
	return {
		dialog: () => dialog,
		openOrCloseDialog: () => toggleShortcut.handler(ctx),
		emitGustState: (payload: unknown) => eventHandlers.get("px:status-bar:gust-hold:set")?.(payload),
	};
}

describe("Gust hold quick action state", () => {
	test("shows the toggle on when automatic reload hold is enabled", async () => {
		const ui = startPiUi();
		ui.emitGustState({ enabled: true, running: true, paused: false });
		const opened = ui.openOrCloseDialog();
		ui.dialog().handleInput("t");
		const render = () => ui.dialog().render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(render()).toMatch(/Hold Gust Reload\s+r ─●/);

		ui.emitGustState({ enabled: false, running: true, paused: false });
		expect(render()).toMatch(/Hold Gust Reload\s+r ○─/);

		await ui.openOrCloseDialog();
		await opened;
	});
});
