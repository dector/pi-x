import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import promptStashExtension from "./index.ts";
import renewExtension from "../renew/index.ts";

function harness(sessionId = "old", entries: any[] = []) {
	const listeners = new Map<string, Set<(payload: any) => void>>();
	const lifecycle = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const statuses: any[] = [];
	let editor = "";
	let branch: any[] = [];
	const events = {
		on(name: string, fn: (payload: any) => void) {
			const set = listeners.get(name) ?? new Set();
			set.add(fn);
			listeners.set(name, set);
			return () => set.delete(fn);
		},
		emit(name: string, payload: any) { for (const fn of [...(listeners.get(name) ?? [])]) fn(payload); },
	};
	events.on("px:status-bar:set", (payload) => statuses.push(payload));
	events.on("px:status-bar:clear", (payload) => statuses.push({ ...payload, content: "" }));
	const pi = {
		events,
		on(name: string, fn: (event: any, ctx: any) => unknown) {
			lifecycle.set(name, [...(lifecycle.get(name) ?? []), fn]);
		},
		registerCommand(name: string, options: any) { commands.set(name, options); },
		registerEntryRenderer() {},
		appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
		getThinkingLevel: () => "high",
		setThinkingLevel() {},
	};
	const notices: string[] = [];
	const ctx = {
		cwd: "/repo", hasUI: true,
		sessionManager: { getSessionId: () => sessionId, getEntries: () => entries, getBranch: () => branch },
		ui: {
			getEditorText: () => editor,
			setEditorText: (text: string) => { editor = text; },
			notify: (message: string) => notices.push(message),
			confirm: async () => true,
			select: async (_title: string, options: string[]) => options[0],
		},
	};
	promptStashExtension(pi as unknown as ExtensionAPI);
	return {
		pi, ctx, entries, statuses, notices,
		setBranch: (value: any[]) => { branch = value; },
		fire: async (name: string) => { for (const fn of lifecycle.get(name) ?? []) await fn({}, ctx); },
		run: (action: string) => commands.get(`px:prompt-stash.${action}`)!.handler("", ctx),
		command: (name: string, args: string, context: any) => commands.get(name)!.handler(args, context),
	};
}

function stash(id: string, text = id) {
	return { type: "custom", customType: "prompt-stash", data: { action: "stash", stash: { id, text, createdAt: 123, charCount: text.length } } };
}

test("stashes are available across branches and popped stashes stay removed after navigation and reload", async () => {
	const h = harness("old", [stash("a"), stash("b")]);
	h.setBranch([h.entries[0]]);
	await h.fire("session_start");
	expect(h.statuses.at(-1).content).toContain("2");
	await h.run("pop");
	expect(h.ctx.ui.getEditorText()).toBe("b");
	h.ctx.ui.setEditorText("");
	h.setBranch([]);
	await h.fire("session_tree");
	expect(h.statuses.at(-1).content).toContain("1");
	const reloaded = harness("old", h.entries);
	await reloaded.fire("session_start");
	await reloaded.run("pop");
	expect(reloaded.ctx.ui.getEditorText()).toBe("a");
	await reloaded.fire("session_tree");
	expect(reloaded.statuses.at(-1).content).toBe("");
});

test("clear-all removes stashes throughout the session and survives reload", async () => {
	const h = harness("old", [stash("a"), stash("b")]);
	await h.fire("session_start");
	await h.run("clear-all");
	await h.fire("session_tree");
	const reloaded = harness("old", h.entries);
	await reloaded.fire("session_start");
	expect(reloaded.statuses.at(-1).content).toBe("");
});

test("legacy clear-all only removes its recorded IDs, not unseen sibling-branch stashes", async () => {
	const h = harness("old", [stash("a"), stash("b"), { type: "custom", customType: "prompt-stash", data: { action: "clear-all", clearedIds: ["a"] } }]);
	await h.fire("session_start");
	await h.run("pop");
	expect(h.ctx.ui.getEditorText()).toBe("b");
});

test("renew carries all stashes through a replacement bus and persists them in the new session", async () => {
	const old = harness("old", [stash("a", " first\n"), stash("b")]);
	const fresh = harness("new");
	renewExtension(old.pi as unknown as ExtensionAPI);
	await old.fire("session_start");
	await old.command("renew", "", {
		...old.ctx,
		newSession: async ({ withSession }: any) => {
			await old.fire("session_shutdown");
			renewExtension(fresh.pi as unknown as ExtensionAPI);
			await fresh.fire("session_start");
			await withSession(fresh.ctx);
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext);
	expect(fresh.notices).toEqual([]);
	expect(fresh.entries).toEqual(old.entries);
	await fresh.run("pop");
	expect(fresh.ctx.ui.getEditorText()).toBe("b");
	await fresh.fire("session_shutdown");
	const reloaded = harness("new", fresh.entries);
	await reloaded.fire("session_start");
	await reloaded.run("pop");
	expect(reloaded.ctx.ui.getEditorText()).toBe(" first\n");
});

test("renew handoff validates scope and data, and repeated apply does not resurrect popped stashes", async () => {
	const h = harness("new");
	await h.fire("session_start");
	const request = { transferId: "transfer", owner: "prompt-stash", targetSessionId: "new", cwd: "/repo", state: { stashes: [stash("a").data.stash] } };
	for (const bad of [{ targetSessionId: "wrong" }, { cwd: "/wrong" }, { owner: "wrong" }, { state: { stashes: [{}] } }]) {
		h.pi.events.emit("px:renew:settings:apply", { ...request, ...bad });
	}
	expect(h.entries).toHaveLength(0);
	h.pi.events.emit("px:renew:settings:apply", request);
	await h.run("pop");
	h.pi.events.emit("px:renew:settings:apply", request);
	expect(h.entries).toHaveLength(2);
	expect(h.statuses.at(-1).content).toBe("");
});

test("unrelated sessions start with no stashes", async () => {
	const h = harness("unrelated");
	await h.fire("session_start");
	expect(h.statuses.at(-1).content).toBe("");
});
