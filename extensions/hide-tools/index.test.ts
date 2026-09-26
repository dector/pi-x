import { afterEach, expect, test } from "bun:test";
import hideToolsExtension from "./index.ts";

class ToolExecutionComponent {
	hideComponent = false;
	constructor(public toolCallId: string, public result?: { isError: boolean }) {}
}

class AssistantMessageComponent {
	lastMessage = { stopReason: "error", errorMessage: "Usage limit reached", content: [] };
	render() { return ["Error: Usage limit reached"]; }
}

const stateKey = "__px_hide_tools_state_v1";
const syncKey = "__px_hide_tools_sync_v1";
const tuiKey = "__px_hide_tools_tui_v1";
const themeKey = "__px_hide_tools_theme_v1";

afterEach(() => {
	for (const key of [stateKey, syncKey, tuiKey, themeKey]) delete (globalThis as any)[key];
});

test("compact and hidden modes render failed tools in full, including newly failed calls", async () => {
	const ok = new ToolExecutionComponent("ok");
	const failed = new ToolExecutionComponent("failed", { isError: true });
	const late = new ToolExecutionComponent("late");
	const assistantError = new AssistantMessageComponent();
	const chat = { children: [ok, failed, late, assistantError] as any[] };
	const tui: any = {
		layoutRoot: { children: [chat] },
		doRender() {},
		requestRender() { this.doRender(); },
	};
	let command!: (args: string, ctx: any) => Promise<void>;
	const ui = {
		theme: { fg: (_color: string, text: string) => text },
		setWidget: (_key: string, factory: (tui: any, theme: any) => unknown) => factory(tui, ui.theme),
		notify() {},
	};
	const ctx = { mode: "tui", hasUI: true, ui };
	hideToolsExtension({
		registerShortcut() {},
		registerCommand: (_name: string, options: any) => { command = options.handler; },
		on() {},
	} as any);
	await command("compact -s", ctx);
	expect(ok.hideComponent).toBe(true);
	expect(failed.hideComponent).toBe(false);
	expect(chat.children.filter((child) => child.__px_hide_tools_line === "compact")).toHaveLength(2);
	await command("hidden -s", ctx);
	expect(ok.hideComponent).toBe(true);
	expect(failed.hideComponent).toBe(false);
	expect(chat.children.filter((child) => child.__px_hide_tools_line === "summary")).toHaveLength(2);
	late.result = { isError: true };
	tui.doRender();
	expect(late.hideComponent).toBe(false);
	expect(chat.children.filter((child) => child.__px_hide_tools_line === "summary")).toHaveLength(1);
	expect(assistantError.render()).toEqual(["Error: Usage limit reached"]);
});
