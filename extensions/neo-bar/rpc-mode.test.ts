import { expect, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import statusBarExtension, { FrameStatusEditor } from "./index.ts";
import { STATUS_BAR_EVENTS } from "./contract.ts";
import { GitStatsWatcher } from "./git-stats.ts";
import { NETWORK_STATE_EVENTS } from "./network.ts";
import { HUB_PROGRESS_CHANNELS } from "./progress.ts";

function fixture(mode: string | undefined, hasUI = true) {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
	const listeners = new Map<string, Set<(payload: any) => void>>();
	const emitted: string[] = [];
	const events = {
		on(channel: string, handler: (payload: any) => void) {
			if (!listeners.has(channel)) listeners.set(channel, new Set());
			listeners.get(channel)!.add(handler);
			return () => { listeners.get(channel)!.delete(handler); };
		},
		emit(channel: string, payload: any) {
			emitted.push(channel);
			for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
		},
	};
	// Preserve the bounded network/progress query timers, but answer immediately.
	events.on(NETWORK_STATE_EVENTS.request, ({ id }) => events.emit(NETWORK_STATE_EVENTS.response, {
		id, state: { configured: "auto", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: false },
	}));
	events.on(HUB_PROGRESS_CHANNELS.query, ({ requestId }) => events.emit(HUB_PROGRESS_CHANNELS.snapshot, {
		requestId, snapshot: { active: false, count: 0, trackers: [] },
	}));
	const calls: string[] = [];
	const notices: string[] = [];
	let editor: FrameStatusEditor | undefined;
	let footer: { render(width: number): string[]; dispose(): void } | undefined;
	const theme = {
		fg: (_token: unknown, text: string) => text,
		getFgAnsi: () => "", bold: (text: string) => text,
		getThinkingBorderColor: () => (text: string) => text,
	};
	const tui = { requestRender() {} };
	const ui = {
		theme,
		setFooter(factory: any) {
			calls.push("footer");
			if (mode !== "tui") return; // Real RPC ignores terminal factories.
			footer?.dispose();
			footer = factory?.(tui, theme, { onBranchChange: () => () => {}, getGitBranch: () => "main" });
		},
		getEditorComponent() { calls.push("getEditor"); return undefined; },
		setEditorComponent(factory: any) {
			calls.push("editor");
			if (mode !== "tui" || !factory) return;
			editor = factory(tui, { borderColor: (text: string) => text }, {});
			editor!.onEscape = () => {};
		},
		setWorkingIndicator() { calls.push("working"); },
		async custom() { calls.push("custom"); },
		notify(message: string) { notices.push(message); },
	};
	const ctx = {
		mode, hasUI, ui, cwd: process.cwd(),
		sessionManager: { getBranch: () => [], getSessionId: () => "test", getLeafId: () => null, getSessionName: () => "" },
		getContextUsage: () => undefined,
	} as unknown as ExtensionContext;
	statusBarExtension({
		events,
		on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			commands.set(name, command.handler);
		},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	return {
		calls, notices, emitted, events,
		get editor() { return editor; }, get footer() { return footer; },
		async dispatch(name: string, event = {}) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		async command(name: string, args = "") { await commands.get(name)!(args, ctx); },
	};
}

for (const [mode, hasUI] of [["rpc", true], ["json", true], ["print", true], [undefined, true], ["tui", false]] as const) {
	test(`${mode ?? "missing mode"} (hasUI=${hasUI}): no terminal setup, editor error, git debounce or preview/animation timers`, async () => {
		const timers = spyOn(globalThis, "setTimeout");
		const intervals = spyOn(globalThis, "setInterval");
		const schedule = spyOn(GitStatsWatcher.prototype, "schedule");
		const f = fixture(mode, hasUI);
		try {
			await f.dispatch("session_start");
			await f.dispatch("session_tree");
			for (const name of ["turn_start", "turn_end", "input", "user_bash", "agent_start", "agent_end", "model_select"]) {
				await f.dispatch(name);
			}
			await f.command("px:status-bar-contract");
			await f.command("px:status-bar-set", "safe-mode SMART");
			await f.command("px:status-bar-clear", "safe-mode");
			await f.command("px:status-bar-display-mode"); // Query does not write settings.
			f.events.emit(STATUS_BAR_EVENTS.rewirePreview, { model: "test", thinkingLevel: "high" });
			f.events.emit(STATUS_BAR_EVENTS.ping, { id: "probe" });
			await f.dispatch("session_shutdown");
			expect(f.calls).toEqual([]);
			expect(f.editor).toBeUndefined();
			expect(schedule).not.toHaveBeenCalled();
			expect(intervals).not.toHaveBeenCalled();
			// Only the preserved network/progress bounded queries create timers.
			expect(timers.mock.calls.map((call) => call[1])).toEqual([300, 300, 300, 300]);
			expect(f.emitted).toContain(NETWORK_STATE_EVENTS.request);
			expect(f.emitted).toContain(HUB_PROGRESS_CHANNELS.query);
			expect(f.emitted).toContain(STATUS_BAR_EVENTS.pong);
			if (hasUI) expect(f.notices[0]).toContain("status-bar display mode:");
			else expect(f.notices).toEqual([]);
		} finally {
			await f.dispatch("session_shutdown");
			timers.mockRestore(); intervals.mockRestore(); schedule.mockRestore();
		}
	});
}

test("TUI still installs footer/editor synchronously, protects interrupt, renders producer rows, and cleans up", async () => {
	// Observe automatic Git scheduling without launching Git in this unit test.
	const schedule = spyOn(GitStatsWatcher.prototype, "schedule").mockImplementation(() => {});
	const protect = spyOn(FrameStatusEditor.prototype, "protectInterrupt");
	const f = fixture("tui");
	try {
		await f.dispatch("session_start");
		expect(f.calls).toEqual(["footer", "getEditor", "editor", "working"]);
		expect(f.editor).toBeInstanceOf(FrameStatusEditor);
		expect(protect).toHaveBeenCalledTimes(1);
		expect(schedule).toHaveBeenCalledTimes(1);
		const previewTimer = spyOn(globalThis, "setTimeout");
		try {
			f.events.emit(STATUS_BAR_EVENTS.rewirePreview, { model: "test", thinkingLevel: "high" });
			expect(previewTimer.mock.calls.map((call) => call[1])).toEqual([1500]);
			f.events.emit(STATUS_BAR_EVENTS.rewireClear, {});
		} finally {
			previewTimer.mockRestore();
		}
		f.events.emit(STATUS_BAR_EVENTS.rowSet, { id: "test", content: "producer row" });
		expect(f.footer!.render(80)).toContain("producer row");
		await f.command("px:status-bar-contract");
		expect(f.calls.filter((call) => call === "editor")).toHaveLength(1);
		expect(f.calls).toContain("custom");
		await f.dispatch("session_shutdown");
		expect(f.calls.slice(-3)).toEqual(["footer", "working", "editor"]);
	} finally {
		await f.dispatch("session_shutdown");
		schedule.mockRestore(); protect.mockRestore();
	}
});
