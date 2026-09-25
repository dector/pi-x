import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import resetExtension from "./index.ts";

type Handler = (payload: any) => void;
function bus() {
	const listeners = new Map<string, Set<Handler>>();
	return {
		on(name: string, fn: Handler) {
			const set = listeners.get(name) ?? new Set<Handler>();
			set.add(fn);
			listeners.set(name, set);
			return () => set.delete(fn);
		},
		emit(name: string, payload: unknown) {
			for (const fn of [...(listeners.get(name) ?? [])]) fn(payload);
		},
	};
}

for (const available of [true, false]) test(`reset transfers through replacement bus (model available: ${available})`, async () => {
	const oldBus = bus();
	const freshBus = bus();
	let selectedModel = "";
	let selectedThinking = "";
	const notices: string[] = [];
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
	const oldPi = {
		events: oldBus,
		getThinkingLevel: () => "high",
		registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
		on: (name: string, handler: (event: unknown, ctx: any) => void) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
	};
	resetExtension(oldPi as unknown as ExtensionAPI);
	const newHandlers = new Map<string, Array<(event: unknown, ctx: any) => void>>();
	const freshPi = {
		events: freshBus,
		setModel: async (model: { id: string }) => { selectedModel = model.id; return true; },
		setThinkingLevel: (level: string) => { selectedThinking = level; },
		registerCommand: () => {},
		on: (name: string, handler: (event: unknown, ctx: any) => void) => newHandlers.set(name, [...(newHandlers.get(name) ?? []), handler]),
	};
	oldBus.on("px:reset:settings:request", ({ id, sourceSessionId, cwd }) => {
		oldBus.emit("px:reset:settings:response", { id, sourceSessionId, cwd, owner: "safe-mode", state: { mode: "reader" } });
	});
	let applied: unknown;
	freshBus.on("px:reset:settings:apply", (payload) => {
		applied = payload;
		const { transferId, targetSessionId, cwd } = payload as any;
		freshBus.emit("px:reset:settings:ack", { transferId, targetSessionId, cwd, owner: "safe-mode" });
	});
	const newCtx = {
		cwd: "/repo", sessionManager: { getSessionId: () => "new" },
		modelRegistry: { getAvailable: async () => available ? [{ provider: "test", id: "old-model" }] : [] },
		ui: { notify: (message: string) => notices.push(message) },
	};
	const oldCtx = {
		cwd: "/repo", hasUI: true, model: { provider: "test", id: "old-model" },
		sessionManager: { getSessionId: () => "old" },
		ui: { notify: (message: string) => notices.push(message) },
		newSession: async ({ withSession }: { withSession: (ctx: any) => Promise<void> }) => {
			for (const handler of handlers.get("session_shutdown") ?? []) handler({}, oldCtx);
			resetExtension(freshPi as unknown as ExtensionAPI);
			for (const handler of newHandlers.get("session_start") ?? []) handler({}, newCtx);
			await withSession(newCtx);
			return { cancelled: false };
		},
	};
	await command?.("", oldCtx as unknown as ExtensionCommandContext);
	expect(selectedModel).toBe(available ? "old-model" : "");
	expect(selectedThinking).toBe("high");
	expect((applied as any).state).toEqual({ mode: "reader" });
	expect(notices).toEqual(available ? [] : ["/reset: model or thinking level could not be restored."]);
	for (const handler of newHandlers.get("session_shutdown") ?? []) handler({}, newCtx);
});

test("missing replacement bridge warns and skips transfer", async () => {
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const notices: string[] = [];
	const pi = {
		events: bus(),
		getThinkingLevel: () => "off",
		registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
		on: () => {},
	};
	resetExtension(pi as unknown as ExtensionAPI);
	const newCtx = { cwd: "/repo", sessionManager: { getSessionId: () => "new" }, ui: { notify: (m: string) => notices.push(m) } };
	const ctx = {
		cwd: "/repo", model: undefined, sessionManager: { getSessionId: () => "old" },
		ui: { notify: (m: string) => notices.push(m) },
		newSession: async ({ withSession }: { withSession: (c: unknown) => Promise<void> }) => { await withSession(newCtx); return { cancelled: false }; },
	};
	await command?.("", ctx as unknown as ExtensionCommandContext);
	expect(notices.some((message) => message.includes("replacement extension is unavailable"))).toBe(true);
});

test("/reset +agents is refused without starting a new session", async () => {
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	let newSessions = 0;
	const notices: string[] = [];
	const pi = {
		events: bus(),
		getThinkingLevel: () => "off",
		registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
		on: () => {},
	};
	resetExtension(pi as unknown as ExtensionAPI);
	const ctx = {
		cwd: "/repo",
		sessionManager: { getSessionId: () => "old" },
		ui: { notify: (message: string) => notices.push(message) },
		newSession: async () => { newSessions += 1; return { cancelled: false }; },
	};
	await command?.("+agents", ctx as unknown as ExtensionCommandContext);
	expect(newSessions).toBe(0);
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain("+agents is unavailable");
});
