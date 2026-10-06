import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import renewExtension from "./index.ts";
import subagentExtension from "../subagent/index.ts";

function runtime(sessionId: string) {
	const listeners = new Map<string, Set<(payload: any) => void>>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, any>();
	const model = { provider: "test", id: "main", reasoning: true };
	const target = { provider: "test", id: "reviewer", reasoning: true };
	const notices: string[] = [];
	const ctx: any = {
		cwd: "/repo", hasUI: false, model, scopedModels: [],
		modelRegistry: { getAvailable: () => [model, target] },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
		ui: { notify: (message: string) => notices.push(message), setWidget: () => {} },
	};
	const pi: any = {
		events: {
			on(name: string, fn: (payload: any) => void) {
				const set = listeners.get(name) ?? new Set();
				set.add(fn); listeners.set(name, set);
				return () => set.delete(fn);
			},
			emit(name: string, payload: any) {
				for (const fn of [...(listeners.get(name) ?? [])]) fn(payload);
			},
		},
		on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		registerCommand: (name: string, options: any) => commands.set(name, options.handler),
		registerTool: () => {}, registerShortcut: () => {}, registerMessageRenderer: () => {}, registerEntryRenderer: () => {},
		getThinkingLevel: () => "high", setThinkingLevel: () => {}, setModel: async () => true,
	};
	subagentExtension(pi as ExtensionAPI);
	renewExtension(pi as ExtensionAPI);
	return { pi, ctx, commands, notices, async event(name: string) {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
	} };
}

for (const enabled of [false, true]) for (const temporaryInheritance of [false, true]) test(`renew retains rewiring (enabled: ${enabled}, temporary inheritance: ${temporaryInheritance})`, async () => {
	const old = runtime(`rewire-old-${crypto.randomUUID()}`);
	await old.event("session_start");
	old.pi.events.emit("px:subagent:rewire:target", { ctx: old.ctx, model: "test/reviewer", thinkingLevel: "medium" });
	if (enabled) old.pi.events.emit("px:subagent:rewire:toggle", { ctx: old.ctx });
	if (temporaryInheritance) old.pi.events.emit("px:subagent:rewire:inherit-all:toggle", { ctx: old.ctx });
	let fresh: ReturnType<typeof runtime>;
	old.ctx.newSession = async ({ withSession }: any) => {
		await old.event("session_shutdown");
		fresh = runtime(`rewire-new-${crypto.randomUUID()}`);
		await fresh.event("session_start");
		await withSession(fresh.ctx);
		return { cancelled: false };
	};
	await old.commands.get("renew")("", old.ctx);
	if (temporaryInheritance) fresh!.pi.events.emit("px:subagent:rewire:inherit-all:toggle", { ctx: fresh!.ctx });
	let state: unknown;
	fresh!.pi.events.emit("px:subagent:rewire:state:request", { ctx: fresh!.ctx, reply: (value: unknown) => { state = value; } });
	expect(state).toEqual({ enabled, model: "test/reviewer", thinkingLevel: "medium" });
	expect(fresh!.notices).toEqual([]);
	await fresh!.event("session_shutdown");
});
