import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SAFE_MODE_STATE_EVENTS } from "./contract.ts";
import safeModeExtension from "./index.ts";

// Regression: the `/renew` apply handler once referenced `parseSafeModeSnapshot`
// without importing it, so the handoff threw at runtime and safe mode silently
// failed to transfer. This drives the real extension end to end.

type Handler = (payload: unknown) => unknown;
function createBus() {
	const handlers = new Map<string, Set<Handler>>();
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const errors: unknown[] = [];
	return {
		emitted,
		errors,
		emit(event: string, payload: unknown) {
			emitted.push({ event, payload });
			for (const handler of [...(handlers.get(event) ?? [])]) {
				try {
					const result = handler(payload);
					if (result && typeof (result as Promise<unknown>).then === "function") {
						(result as Promise<unknown>).catch((error) => errors.push(error));
					}
				} catch (error) {
					errors.push(error);
				}
			}
		},
		on(event: string, handler: Handler) {
			const set = handlers.get(event) ?? new Set<Handler>();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
	};
}

function createFakePi(bus: ReturnType<typeof createBus>) {
	const lifecycle = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		events: bus,
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			lifecycle.set(event, [...(lifecycle.get(event) ?? []), handler]);
		},
		registerFlag() {},
		registerCommand() {},
		registerTool() {},
		registerShortcut() {},
		appendEntry() {},
		getFlag() {
			return undefined;
		},
		getCommands() {
			return [];
		},
		sendUserMessage() {},
	};
	return { pi, lifecycle };
}

function ctxFor(sessionId: string) {
	return {
		cwd: "/repo",
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			notify() {},
			select: async () => undefined,
			confirm: async () => false,
		},
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
	};
}

async function startSession(lifecycle: ReturnType<typeof createFakePi>["lifecycle"], ctx: unknown): Promise<void> {
	for (const handler of lifecycle.get("session_start") ?? []) await handler({}, ctx);
}

test("renew handoff transfers safe mode into the replacement session", async () => {
	const oldBus = createBus();
	const old = createFakePi(oldBus);
	safeModeExtension(old.pi as unknown as ExtensionAPI);
	await startSession(old.lifecycle, ctxFor("old"));
	// Seed a non-default selection, then snapshot it as `/renew` would.
	oldBus.emit(SAFE_MODE_STATE_EVENTS.set, { state: { mode: "reader", outerAccess: true }, source: "test" });
	let snapshot: unknown;
	oldBus.on("px:renew:settings:response", (payload) => {
		const value = payload as { owner?: string; state?: unknown };
		if (value.owner === "safe-mode") snapshot = value.state;
	});
	oldBus.emit("px:renew:settings:request", { id: "r1", sourceSessionId: "old", cwd: "/repo" });
	expect(snapshot).toEqual({ mode: "reader", outerAccess: true, sessionApprovedBashCommands: [] });

	const newBus = createBus();
	const fresh = createFakePi(newBus);
	safeModeExtension(fresh.pi as unknown as ExtensionAPI);
	await startSession(fresh.lifecycle, ctxFor("new"));
	let acked = false;
	newBus.on("px:renew:settings:ack", (payload) => {
		const value = payload as { owner?: string };
		if (value.owner === "safe-mode") acked = true;
	});
	newBus.emit("px:renew:settings:apply", {
		transferId: "r1",
		owner: "safe-mode",
		targetSessionId: "new",
		cwd: "/repo",
		state: snapshot,
	});
	expect(newBus.errors).toEqual([]);
	expect(acked).toBe(true);
	const changed = newBus.emitted
		.filter((entry) => entry.event === SAFE_MODE_STATE_EVENTS.changed)
		.map((entry) => entry.payload as { mode?: string; outerAccess?: boolean; source?: string });
	expect(changed.at(-1)).toEqual({ mode: "reader", outerAccess: true, source: "renew" });
});
