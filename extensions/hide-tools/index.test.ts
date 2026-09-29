import { afterEach, expect, test } from "bun:test";
import hideToolsExtension from "./index.ts";

// Existing tests assume a running tool expands immediately.
process.env.PI_HIDE_TOOLS_RUNNING_DELAY_MS = "0";

class ToolExecutionComponent {
	hideComponent = false;
	isPartial = false;
	executionStarted = false;
	toolName = "bash";
	args = { command: "echo ok" };
	constructor(public toolCallId: string, public result?: { isError: boolean }) {}
}

class AssistantMessageComponent {
	lastMessage: any = { stopReason: "error", errorMessage: "Usage limit reached", content: [] };
	render() { return ["Error: Usage limit reached"]; }
}

const stateKey = "__px_hide_tools_state_v1";
const syncKey = "__px_hide_tools_sync_v1";
const tuiKey = "__px_hide_tools_tui_v1";
const themeKey = "__px_hide_tools_theme_v1";

afterEach(() => {
	const existing = (globalThis as any)[stateKey];
	for (const timer of existing?.runningTimers?.values() ?? []) clearTimeout(timer);
	for (const key of [stateKey, syncKey, tuiKey, themeKey]) delete (globalThis as any)[key];
	process.env.PI_HIDE_TOOLS_RUNNING_DELAY_MS = "0";
});

test("compact separates message text from tool groups without gaps between tools", async () => {
	class UserMessageComponent { render() { return ["User blah blah"]; } }
	const user = new UserMessageComponent();
	const assistant = new AssistantMessageComponent();
	assistant.lastMessage = { stopReason: "stop", content: [{ type: "text", text: "Agent blah blah" }] };
	const thinking = new AssistantMessageComponent();
	thinking.lastMessage = { stopReason: "toolUse", content: [{ type: "thinking", thinking: "hmm" }] };
	const first = new ToolExecutionComponent("first");
	const second = new ToolExecutionComponent("second");
	const third = new ToolExecutionComponent("third");
	const chat = { children: [user, assistant, thinking, first, second, user, third] as any[] };
	const tui: any = { layoutRoot: { children: [chat] }, doRender() {}, requestRender() { this.doRender(); } };
	let command!: (args: string, ctx: any) => Promise<void>;
	const ui = {
		theme: { fg: (_color: string, text: string) => text },
		setWidget: (_key: string, factory: (tui: any, theme: any) => unknown) => factory(tui, ui.theme),
		notify() {},
	};
	hideToolsExtension({
		registerShortcut() {},
		registerCommand: (_name: string, options: any) => { command = options.handler; },
		on() {},
	} as any);
	await command("compact -s", { mode: "tui", hasUI: true, ui });
	const kinds = () => chat.children.map((child) => child.__px_hide_tools_line ?? child.constructor.name);
	expect(kinds()).toEqual([
		"UserMessageComponent", "AssistantMessageComponent", "AssistantMessageComponent",
		"spacing", "compact", "ToolExecutionComponent", "compact", "ToolExecutionComponent",
		"UserMessageComponent", "spacing", "compact", "ToolExecutionComponent",
	]);
	for (const mode of ["compact-running", "compact"]) {
		await command(`${mode} -s`, { mode: "tui", hasUI: true, ui });
		tui.doRender();
		expect(kinds().filter((kind) => kind === "spacing")).toHaveLength(2);
	}
	await command("full -s", { mode: "tui", hasUI: true, ui });
	expect(kinds().filter((kind) => kind === "spacing" || kind === "compact")).toHaveLength(0);
});

test("compact collapses failed tools; hidden still shows failed tools in full", async () => {
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
	expect(failed.hideComponent).toBe(true);
	expect(chat.children.filter((child) => child.__px_hide_tools_line === "compact")).toHaveLength(3);
	expect(chat.children.find((child) => child.__px_hide_tools_line === "compact" && child.render(80)[0].includes(" x "))).toBeDefined();
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

test("compact-running shows only executing tools in full until their final result", async () => {
	const pending = new ToolExecutionComponent("pending");
	const running = new ToolExecutionComponent("running");
	const finished = new ToolExecutionComponent("finished", { isError: false });
	const failed = new ToolExecutionComponent("failed", { isError: true });
	const chat = { children: [pending, running, finished, failed] as any[] };
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
	await command("-s", ctx); // Cycle to compact-running.
	const lines = () => chat.children.filter((child) => child.__px_hide_tools_line === "compact");
	expect(lines()).toHaveLength(4);
	expect(chat.children.filter((child) => child instanceof ToolExecutionComponent && !child.hideComponent)).toHaveLength(0);

	running.executionStarted = true;
	running.isPartial = true;
	tui.doRender();
	expect(running.hideComponent).toBe(false);
	expect(pending.hideComponent).toBe(true);
	expect(lines()).toHaveLength(3); // No duplicate compact line while running.

	running.result = { isError: false };
	tui.doRender(); // A partial result must not collapse it yet.
	expect(running.hideComponent).toBe(false);
	expect(lines()).toHaveLength(3);
	running.isPartial = false;
	tui.doRender();
	expect(running.hideComponent).toBe(true);
	expect(lines()).toHaveLength(4);
	expect(lines().map((line) => line.render(80)[0])).toEqual([
		" ▸ · bash echo ok", " ▸ ✓ bash echo ok", " ▸ ✓ bash echo ok", " ▸ x bash echo ok",
	]);
	const runningLine = lines()[1];
	runningLine.handleMouse?.({ type: "click", button: "left" });
	tui.doRender();
	expect(running.hideComponent).toBe(false); // Finished tools still support click-to-peek.

	failed.executionStarted = true;
	failed.isPartial = true;
	tui.doRender();
	expect(failed.hideComponent).toBe(false);
	expect(lines()).toHaveLength(3);
	failed.result = { isError: true };
	failed.isPartial = false;
	tui.doRender();
	expect(failed.hideComponent).toBe(true);
	expect(lines()).toHaveLength(4);
	expect(lines()[3].render(80)[0]).toBe(" ▸ x bash echo ok");

	await command("-s", ctx); // Cycle to hidden.
	expect(lines()).toHaveLength(0);
});

test("compact-running keeps a fast tool collapsed until it crosses the delay", async () => {
	process.env.PI_HIDE_TOOLS_RUNNING_DELAY_MS = "2000";
	const running = new ToolExecutionComponent("running");
	const chat = { children: [running] as any[] };
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
	await command("-s", ctx); // Cycle to compact-running.
	running.executionStarted = true;
	running.isPartial = true;
	tui.doRender();
	const lines = () => chat.children.filter((child) => child.__px_hide_tools_line === "compact");
	// Still within the delay: the tool stays behind its compact line.
	expect(running.hideComponent).toBe(true);
	expect(lines()).toHaveLength(1);

	// Simulate crossing the delay without sleeping.
	process.env.PI_HIDE_TOOLS_RUNNING_DELAY_MS = "0";
	tui.doRender();
	expect(running.hideComponent).toBe(false);
	expect(lines()).toHaveLength(0);

	// A fast tool that lands within the delay never expands.
	process.env.PI_HIDE_TOOLS_RUNNING_DELAY_MS = "2000";
	const fast = new ToolExecutionComponent("fast");
	chat.children.push(fast);
	tui.doRender(); // Fast tool sits collapsed.
	expect(fast.hideComponent).toBe(true);
	fast.executionStarted = true;
	fast.isPartial = true;
	fast.result = { isError: false };
	fast.isPartial = false;
	tui.doRender(); // It already finished: no full view ever shown.
	expect(fast.hideComponent).toBe(true);
	expect(lines()).toHaveLength(2);
});

test("compact status changes from dot to check or x as results arrive", async () => {
	const running = new ToolExecutionComponent("running");
	const failed = new ToolExecutionComponent("failed");
	const chat = { children: [running, failed] as any[] };
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
	hideToolsExtension({
		registerShortcut() {},
		registerCommand: (_name: string, options: any) => { command = options.handler; },
		on() {},
	} as any);
	await command("compact -s", { mode: "tui", hasUI: true, ui });
	const lines = () => chat.children.filter((child) => child.__px_hide_tools_line === "compact");
	expect(lines().map((line) => line.render(80)[0])).toEqual([
		" ▸ · bash echo ok", " ▸ · bash echo ok",
	]);
	running.result = { isError: false };
	failed.result = { isError: true };
	failed.isPartial = true;
	tui.doRender();
	expect(lines().map((line) => line.render(80)[0])).toEqual([
		" ▸ ✓ bash echo ok", " ▸ · bash echo ok",
	]);
	failed.isPartial = false;
	tui.doRender();
	expect(lines()[1].render(80)[0]).toBe(" ▸ x bash echo ok");
	expect(failed.hideComponent).toBe(true); // Only the compact line is shown.
	const line = lines()[0];
	line.handleMouse?.({ type: "click", button: "left" });
	tui.doRender();
	expect(lines()[0].render(80)[0]).toBe(" ▾ ✓ bash echo ok");
	await command("full -s", { mode: "tui", hasUI: true, ui });
	expect(lines()).toHaveLength(0);
});
