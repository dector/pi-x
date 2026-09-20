import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hubExtension from "../hub/index.ts";
import { NETWORK_STATE_EVENTS } from "./contract.ts";
import permissionsCoreExtension from "./index.ts";

type BusHandler = (...args: unknown[]) => unknown;

interface Bus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function createBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const bus: Bus = {
		emit(channel, data) {
			const set = handlers.get(channel);
			if (!set) return;
			for (const handler of [...set]) handler(data);
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
	entries: Array<{ customType: string; data: unknown }>;
	lifecycle: Map<string, BusHandler[]>;
	on(event: string, handler: BusHandler): void;
	registerCommand(name: string, options: unknown): void;
	appendEntry(customType: string, data: unknown): void;
}

function createFakePi(bus: Bus): FakePi {
	const lifecycle = new Map<string, BusHandler[]>();
	const pi: FakePi = {
		events: bus,
		entries: [],
		lifecycle,
		on(event, handler) {
			const list = lifecycle.get(event) ?? [];
			list.push(handler);
			lifecycle.set(event, list);
		},
		registerCommand() {},
		appendEntry(customType, data) {
			pi.entries.push({ customType, data });
		},
	};
	return pi;
}

function createContext(branch: unknown[] = []) {
	return { hasUI: false, cwd: "/tmp", sessionManager: { getBranch: () => branch } };
}

async function fireLifecycle(pi: FakePi, event: string, branch: unknown[] = []): Promise<void> {
	const ctx = createContext(branch);
	for (const handler of pi.lifecycle.get(event) ?? []) {
		await handler({}, ctx);
	}
}

// Safe-mode surrogate: answers the read-only state contract synchronously.
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
			bus.emit("px:safe-mode:state:changed", { mode, outerAccess: false, source: "test" });
		},
	};
}

function captureChanged(bus: Bus) {
	const changed: unknown[] = [];
	bus.on(NETWORK_STATE_EVENTS.changed, (payload) => changed.push(payload));
	return changed;
}

function requestState(bus: Bus, id: string): Promise<unknown> {
	return new Promise((resolve) => {
		const off = bus.on(NETWORK_STATE_EVENTS.response, (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			if ((payload as { id?: unknown }).id !== id) return;
			off();
			resolve(payload);
		});
		bus.emit(NETWORK_STATE_EVENTS.request, { id });
	});
}

async function askPermNet(bus: Bus, id: string): Promise<Array<{ what: string; action: string; reason?: string }>> {
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error("hub answer timeout"));
		}, 1000);
		const off = bus.on("hub:answer", (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			const answer = payload as { id?: unknown; results?: unknown };
			if (answer.id !== id || !Array.isArray(answer.results)) return;
			clearTimeout(timer);
			off();
			resolve(answer.results as Array<{ what: string; action: string; reason?: string }>);
		});
		bus.emit("hub:ask", {
			id,
			from: "test",
			cap: [{ what: "perm:net", data: { toolName: "http", operation: "request", url: "https://example.com", method: "GET" } }],
		});
	});
}

function setup() {
	const { bus } = createBus();
	const pi = createFakePi(bus);
	hubExtension(pi as unknown as ExtensionAPI);
	permissionsCoreExtension(pi as unknown as ExtensionAPI);
	const safeMode = stubSafeMode(bus, "smart");
	return { bus, pi, safeMode };
}

describe("permissions-core index wiring", () => {
	test("session_tree resets and restores persisted state, emitting changes", async () => {
		const { bus, pi } = setup();
		const changed = captureChanged(bus);
		await fireLifecycle(pi, "session_start");

		bus.emit(NETWORK_STATE_EVENTS.set, { setting: "allow-all", source: "test" });
		expect(await requestState(bus, "s1")).toMatchObject({
			state: { configured: "allow-all", effective: "allow-all", overriddenByParanoid: false },
		});

		// session_tree with a persisted explicit choice: reset (Auto) then restore.
		const branch = [{ type: "custom", customType: "permissions-core-net", data: { configured: "allow-trusted" } }];
		await fireLifecycle(pi, "session_tree", branch);
		expect(await requestState(bus, "s2")).toMatchObject({
			state: { configured: "allow-trusted", effective: "allow-trusted", overriddenByParanoid: false },
		});

		// session_tree with an empty branch must not leave the previous explicit
		// choice visible to consumers.
		await fireLifecycle(pi, "session_tree", []);
		expect(await requestState(bus, "s3")).toMatchObject({
			state: { configured: "auto", effective: "ask-untrusted", overriddenByParanoid: false },
		});
		expect(changed.length).toBeGreaterThanOrEqual(3);
	});

	test("session_shutdown unregisters the hub provider", async () => {
		const { bus, pi } = setup();
		await fireLifecycle(pi, "session_start");
		expect((await askPermNet(bus, "before"))[0]).toMatchObject({ action: "allow" });

		await fireLifecycle(pi, "session_shutdown");
		const after = await askPermNet(bus, "after");
		expect(after[0]).toMatchObject({ what: "perm:net", action: "block", reason: "no hub provider" });
	});

	test("state request/response returns the validated current state", async () => {
		const { bus, pi } = setup();
		await fireLifecycle(pi, "session_start");
		expect(await requestState(bus, "state-1")).toEqual({
			id: "state-1",
			state: { configured: "auto", effective: "ask-untrusted", overriddenByParanoid: false },
		});
	});

	test("safe-mode changes propagate to state consumers", async () => {
		const { bus, pi, safeMode } = setup();
		await fireLifecycle(pi, "session_start");
		safeMode.setMode("paranoid");
		expect(await requestState(bus, "p1")).toMatchObject({
			state: { configured: "auto", effective: "ask-all", overriddenByParanoid: true },
		});
		safeMode.setMode("yolo");
		expect(await requestState(bus, "y1")).toMatchObject({
			state: { configured: "auto", effective: "allow-trusted", overriddenByParanoid: false },
		});
	});

	test("safe-mode absence fails closed after the bounded query timeout", async () => {
		// No safe-mode stub: `session_start` awaits the real bounded query and
		// must resolve (not hang). `safe-mode.test.ts` covers the timeout itself
		// with a tiny injected timeout to keep this suite fast.
		const { bus } = createBus();
		const pi = createFakePi(bus);
		hubExtension(pi as unknown as ExtensionAPI);
		permissionsCoreExtension(pi as unknown as ExtensionAPI);

		await fireLifecycle(pi, "session_start");
		expect(await requestState(bus, "absent")).toMatchObject({
			state: { configured: "auto", effective: "ask-all", overriddenByParanoid: true },
		});
		// The provider still answers and fails closed to approval.
		expect((await askPermNet(bus, "absent-ask"))[0]).toMatchObject({ what: "perm:net", action: "confirm" });
	});
});
