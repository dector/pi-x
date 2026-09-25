// Integration tests for Stage 4: `/px:net` changes state only through the
// validated permissions-core contract. Loads the real hub, permissions-core,
// and permissions-ui on a fake event bus. The picker is replaced by a fake
// `ctx.ui.custom` that returns the desired selection, so the command flow and
// `set`/`changed` round trip are exercised end to end.

import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hubExtension from "../hub/index.ts";
import permissionsCoreExtension from "../permissions-core/index.ts";
import { NETWORK_STATE_EVENTS, type NetworkPolicySetting } from "./contract.ts";
import permissionsUiExtension from "./index.ts";

type BusHandler = (...args: unknown[]) => unknown;

interface Bus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function createBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const bus: Bus = {
		emit(channel, data) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
	};
	return { bus };
}

interface FakePi {
	events: Bus;
	lifecycle: Map<string, BusHandler[]>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	flags: Map<string, boolean | string | undefined>;
	on(event: string, handler: BusHandler): void;
	registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }): void;
	registerTool(): void;
	// permissions-core registers its `--network-policy` session flag and reads
	// it back on session start; this fake only needs the surface to exist.
	registerFlag(name: string, options: unknown): void;
	getFlag(name: string): boolean | string | undefined;
	appendEntry(customType: string, data: unknown): void;
}

function createFakePi(bus: Bus): FakePi {
	const lifecycle = new Map<string, BusHandler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi: FakePi = {
		events: bus,
		lifecycle,
		commands,
		flags: new Map(),
		on(event, handler) {
			const list = lifecycle.get(event) ?? [];
			list.push(handler);
			lifecycle.set(event, list);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerTool() {},
		registerFlag() {},
		getFlag(name) {
			return pi.flags.get(name);
		},
		appendEntry() {},
	};
	return pi;
}

function stubSafeMode(bus: Bus, initialMode: string) {
	let mode = initialMode;
	bus.on("px:safe-mode:state:request", (payload) => {
		if (typeof payload !== "object" || payload === null) return;
		const id = (payload as { id?: unknown }).id;
		if (typeof id !== "string") return;
		bus.emit("px:safe-mode:state:response", { id, state: { mode, outerAccess: false } });
	});
	return {
		setMode(next: string) {
			mode = next;
			bus.emit("px:safe-mode:state:changed", { mode: next, outerAccess: false, source: "test" });
		},
	};
}

async function fireLifecycle(pi: FakePi, event: string): Promise<void> {
	const ctx = { hasUI: false, cwd: "/tmp", sessionManager: { getBranch: () => [] } };
	for (const handler of pi.lifecycle.get(event) ?? []) {
		await handler({}, ctx);
	}
}

function requestState(bus: Bus, id: string): Promise<{ state: Record<string, unknown> }> {
	return new Promise((resolve) => {
		const off = bus.on(NETWORK_STATE_EVENTS.response, (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			if ((payload as { id?: unknown }).id !== id) return;
			off();
			resolve(payload as { state: Record<string, unknown> });
		});
		bus.emit(NETWORK_STATE_EVENTS.request, { id });
	});
}

function commandContext(selection: NetworkPolicySetting | null) {
	const notifications: Array<{ message: string; type: string }> = [];
	const ctx = {
		hasUI: true,
		cwd: "/tmp",
		sessionManager: { getBranch: () => [] },
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
			custom: async () => selection,
		},
	};
	return { ctx, notifications };
}

async function openNet(pi: FakePi, selection: NetworkPolicySetting | null) {
	const command = pi.commands.get("px:net");
	expect(command).toBeDefined();
	const { ctx, notifications } = commandContext(selection);
	await command!.handler("", ctx);
	return notifications;
}

function setup(options: { withCore: boolean; withUi: boolean; safeMode?: string }) {
	const { bus } = createBus();
	const pi = createFakePi(bus);
	hubExtension(pi as unknown as ExtensionAPI);
	if (options.withCore) permissionsCoreExtension(pi as unknown as ExtensionAPI);
	if (options.withUi) permissionsUiExtension(pi as unknown as ExtensionAPI);
	const safeMode = options.withCore ? stubSafeMode(bus, options.safeMode ?? "smart") : undefined;
	return { bus, pi, safeMode };
}

describe("permissions-ui /px:net integration", () => {
	test("selecting an explicit policy updates the core through the contract", async () => {
		const { bus, pi } = setup({ withCore: true, withUi: true, safeMode: "smart" });
		await fireLifecycle(pi, "session_start");

		const notifications = await openNet(pi, "allow-all");
		expect(notifications).toEqual([{ message: "Network policy: Allow all", type: "info" }]);
		expect(await requestState(bus, "after-allow-all")).toMatchObject({
			state: { configured: "allow-all", effective: "allow-all", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		});
	});

	test("Auto selection resumes safe-mode derivation", async () => {
		const { bus, pi } = setup({ withCore: true, withUi: true, safeMode: "smart" });
		await fireLifecycle(pi, "session_start");

		await openNet(pi, "allow-all");
		await openNet(pi, "auto");

		expect(await requestState(bus, "after-auto")).toMatchObject({
			state: { configured: "auto", effective: "ask-untrusted", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		});
	});

	test("PARANOID keeps effective ask-all while saving the explicit choice", async () => {
		const { bus, pi, safeMode } = setup({ withCore: true, withUi: true, safeMode: "smart" });
		await fireLifecycle(pi, "session_start");
		safeMode!.setMode("paranoid");

		const notifications = await openNet(pi, "allow-all");
		expect(notifications).toEqual([
			{ message: "Network policy: Allow all (PARANOID still forces NET?)", type: "info" },
		]);
		expect(await requestState(bus, "under-paranoid")).toMatchObject({
			state: { configured: "allow-all", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: true },
		});

		safeMode!.setMode("yolo");
		expect(await requestState(bus, "after-paranoid")).toMatchObject({
			state: { configured: "allow-all", effective: "allow-all", autoEffective: "allow-trusted", overriddenByParanoid: false },
		});
	});

	test("notifies with no local change when permissions-core is unavailable", async () => {
		const { pi } = setup({ withCore: false, withUi: true });
		const notifications = await openNet(pi, "allow-all");
		expect(notifications).toEqual([
			{ message: "permissions-core is unavailable; network policy cannot be changed.", type: "warning" },
		]);
	});
});
