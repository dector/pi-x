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
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const bus: Bus = {
		emit(channel, data) {
			emitted.push({ channel, data });
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
	return { bus, emitted };
}

interface FakePi {
	events: Bus;
	entries: Array<{ customType: string; data: unknown }>;
	lifecycle: Map<string, BusHandler[]>;
	flags: Map<string, boolean | string | undefined>;
	on(event: string, handler: BusHandler): void;
	registerCommand(name: string, options: unknown): void;
	registerTool(): void;
	registerFlag(name: string, options: unknown): void;
	getFlag(name: string): boolean | string | undefined;
	appendEntry(customType: string, data: unknown): void;
}

function createFakePi(bus: Bus, flags: Record<string, string | boolean> = {}): FakePi {
	const lifecycle = new Map<string, BusHandler[]>();
	const pi: FakePi = {
		events: bus,
		entries: [],
		lifecycle,
		flags: new Map(Object.entries(flags)),
		on(event, handler) {
			const list = lifecycle.get(event) ?? [];
			list.push(handler);
			lifecycle.set(event, list);
		},
		registerCommand() {},
		registerTool() {},
		registerFlag() {},
		getFlag(name) {
			return pi.flags.get(name);
		},
		appendEntry(customType, data) {
			pi.entries.push({ customType, data });
		},
	};
	return pi;
}

function createContext(branch: unknown[] = []) {
	return { hasUI: false, cwd: "/tmp", sessionManager: { getBranch: () => branch } };
}

async function startSession(pi: FakePi, branch: unknown[] = []): Promise<void> {
	const ctx = createContext(branch);
	for (const handler of pi.lifecycle.get("session_start") ?? []) {
		await handler({}, ctx);
	}
}

// A minimal safe-mode surrogate: answers the read-only state contract and lets
// the test change the observed mode without touching safe-mode.
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

interface CapResult {
	what: string;
	action: string;
	reason?: string;
	summary?: string;
}

let askCounter = 0;

async function ask(bus: Bus, cap: unknown[], timeoutMs = 1000): Promise<CapResult[]> {
	const id = `ask-${++askCounter}`;
	return await new Promise<CapResult[]>((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error("hub answer timeout (possible deadlock)"));
		}, timeoutMs);
		const off = bus.on("hub:answer", (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			const answer = payload as { id?: unknown; results?: unknown };
			if (answer.id !== id || !Array.isArray(answer.results)) return;
			clearTimeout(timer);
			off();
			resolve(answer.results as CapResult[]);
		});
		bus.emit("hub:ask", { id, from: "test-requester", cap });
	});
}

function request(method: string) {
	return {
		what: "perm:net",
		data: { toolName: "http", operation: "request", url: "https://example.com", method },
	};
}

describe("perm:net request flow (before HTTP enforcement)", () => {
	test("a requester gets an answer through the real hub without recursive deadlock", async () => {
		const { bus, emitted } = createBus();
		const pi = createFakePi(bus);
		hubExtension(pi as unknown as ExtensionAPI);
		permissionsCoreExtension(pi as unknown as ExtensionAPI);
		const safeMode = stubSafeMode(bus, "smart");
		await startSession(pi);

		const trusted = await ask(bus, [request("GET")]);
		expect(trusted[0]).toMatchObject({ what: "perm:net", action: "allow" });

		const untrusted = await ask(bus, [request("POST")]);
		expect(untrusted[0]).toMatchObject({ what: "perm:net", action: "confirm" });

		// Safe-mode transition recomputes Auto without any new registration.
		safeMode.setMode("yolo");
		const yoloTrusted = await ask(bus, [request("GET")]);
		expect(yoloTrusted[0]).toMatchObject({ what: "perm:net", action: "allow" });
		const yoloUntrusted = await ask(bus, [request("POST")]);
		expect(yoloUntrusted[0]).toMatchObject({ what: "perm:net", action: "block" });

		// PARANOID forces ask-all even for trusted traffic.
		safeMode.setMode("paranoid");
		const paranoid = await ask(bus, [request("GET")]);
		expect(paranoid[0]).toMatchObject({ what: "perm:net", action: "confirm" });

		// Leaving PARANOID resumes Auto derivation.
		safeMode.setMode("smart");
		const restored = await ask(bus, [request("GET")]);
		expect(restored[0]).toMatchObject({ what: "perm:net", action: "allow" });

		// The provider must never emit its own hub:ask. Exactly the six asks
		// issued by the requester above are expected.
		const asks = emitted.filter((event) => event.channel === "hub:ask");
		expect(asks.length).toBe(6);
	});

	test("malformed payloads fail closed through the hub", async () => {
		const { bus } = createBus();
		const pi = createFakePi(bus);
		hubExtension(pi as unknown as ExtensionAPI);
		permissionsCoreExtension(pi as unknown as ExtensionAPI);
		stubSafeMode(bus, "yolo");
		await startSession(pi);

		const bogus = await ask(bus, [{ what: "perm:net", data: {} }]);
		expect(bogus[0]?.action).toBe("block");
		expect(bogus[0]?.reason).toBeDefined();
	});

	test("no provider fails closed immediately", async () => {
		const { bus } = createBus();
		const pi = createFakePi(bus);
		hubExtension(pi as unknown as ExtensionAPI);
		// permissions-core is intentionally not loaded.
		const results = await ask(bus, [request("GET")]);
		expect(results[0]).toMatchObject({ what: "perm:net", action: "block", reason: "no hub provider" });
	});

	test("provider registers only after session start", async () => {
		const { bus } = createBus();
		const pi = createFakePi(bus);
		hubExtension(pi as unknown as ExtensionAPI);
		permissionsCoreExtension(pi as unknown as ExtensionAPI);

		const before = await ask(bus, [request("GET")]);
		expect(before[0]).toMatchObject({ action: "block", reason: "no hub provider" });

		stubSafeMode(bus, "yolo");
		await startSession(pi);
		const after = await ask(bus, [request("GET")]);
		expect(after[0]?.action).toBe("allow");
	});

	test("explicit choice persists and resume restores it; a new session starts Auto", async () => {
		const { bus } = createBus();
		const pi = createFakePi(bus);
		hubExtension(pi as unknown as ExtensionAPI);
		permissionsCoreExtension(pi as unknown as ExtensionAPI);
		stubSafeMode(bus, "smart");
		await startSession(pi);

		bus.emit(NETWORK_STATE_EVENTS.set, { setting: "allow-all", source: "test" });
		expect(pi.entries).toEqual([
			{ customType: "permissions-core-net", data: { configured: "allow-all" } },
		]);

		// Resume restores the explicit choice.
		const branch = [{ type: "custom", customType: "permissions-core-net", data: { configured: "allow-all" } }];
		await startSession(pi, branch);
		const resumed = await ask(bus, [request("POST")]);
		expect(resumed[0]).toMatchObject({ what: "perm:net", action: "allow" });

		// A brand new session (empty branch) starts at Auto again.
		await startSession(pi, []);
		const fresh = await ask(bus, [request("POST")]);
		expect(fresh[0]).toMatchObject({ what: "perm:net", action: "confirm" });
	});
});

// Register a minimal `perm:net` provider directly on the real hub bus. Its
// `hub:request` listener order is whatever order these helpers are called in.
function registerFakeProvider(bus: Bus, id: string, action: string, delayMs = 0) {
	bus.on("hub:request", (payload) => {
		if (typeof payload !== "object" || payload === null) return;
		const request = payload as { id?: unknown; targets?: unknown; cap?: unknown };
		if (typeof request.id !== "string") return;
		if (Array.isArray(request.targets) && !request.targets.includes(id)) return;
		if (!Array.isArray(request.cap)) return;
		const results = request.cap
			.filter((item): item is { what: string } =>
				typeof item === "object" && item !== null && (item as { what?: unknown }).what === "perm:net",
			)
			.map((item) => ({ what: item.what, action }));
		const reply = (): void => {
			bus.emit("hub:reply", { id: request.id, from: id, results });
		};
		if (delayMs > 0) setTimeout(reply, delayMs);
		else reply();
	});
}

async function multiProviderArbitration(
	actions: string[],
	listenerOrder: number[],
	registerOrder: number[],
): Promise<CapResult[]> {
	const { bus } = createBus();
	const pi = createFakePi(bus);
	hubExtension(pi as unknown as ExtensionAPI);

	for (const index of listenerOrder) registerFakeProvider(bus, `provider-${index}`, actions[index] ?? "block");
	for (const index of registerOrder) {
		bus.emit("hub:register", { id: `provider-${index}`, caps: { provide: ["perm:net"] } });
	}

	return await ask(bus, [request("GET")]);
}

describe("hub multi-provider arbitration", () => {
	test("collects every targeted provider before finalizing, independent of order", async () => {
		// block must beat the earlier allow/confirm even when the block provider is
		// registered and listens last.
		const permutations = [
			{ actions: ["allow", "confirm", "block"], listener: [0, 1, 2], register: [0, 1, 2] },
			{ actions: ["allow", "confirm", "block"], listener: [2, 1, 0], register: [2, 1, 0] },
			{ actions: ["block", "allow", "confirm"], listener: [1, 2, 0], register: [2, 0, 1] },
			{ actions: ["confirm", "block", "allow"], listener: [0, 2, 1], register: [1, 0, 2] },
		];

		for (const permutation of permutations) {
			const results = await multiProviderArbitration(
				permutation.actions,
				permutation.listener,
				permutation.register,
			);
			expect(results).toHaveLength(1);
			expect(results[0]).toMatchObject({ what: "perm:net", action: "block" });
		}
	});

	test("confirm beats allow and allow wins only when unanimous", async () => {
		const confirmed = await multiProviderArbitration(["allow", "confirm"], [0, 1], [0, 1]);
		expect(confirmed[0]).toMatchObject({ action: "confirm" });

		const allowed = await multiProviderArbitration(["allow", "allow"], [1, 0], [0, 1]);
		expect(allowed[0]).toMatchObject({ action: "allow" });
	});

	test("untargeted providers cannot influence another capability's result", async () => {
		const { bus } = createBus();
		const pi = createFakePi(bus);
		hubExtension(pi as unknown as ExtensionAPI);

		// Not a `perm:net` provider, but it blanket-replies with a block.
		bus.on("hub:request", (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			const id = (payload as { id?: unknown }).id;
			if (typeof id !== "string") return;
			bus.emit("hub:reply", { id, from: "bystander", results: [{ what: "perm:net", action: "block" }] });
			bus.emit("hub:reply", { id, results: [{ what: "perm:net", action: "block" }] });
		});
		registerFakeProvider(bus, "provider-0", "allow");
		bus.emit("hub:register", { id: "provider-0", caps: { provide: ["perm:net"] } });

		const results = await ask(bus, [request("GET")]);
		expect(results[0]).toMatchObject({ action: "allow" });
	});

	test("waits for a delayed provider instead of finalizing on the first reply", async () => {
		const { bus } = createBus();
		const pi = createFakePi(bus);
		hubExtension(pi as unknown as ExtensionAPI);

		registerFakeProvider(bus, "fast", "allow");
		registerFakeProvider(bus, "slow", "block", 5);
		bus.emit("hub:register", { id: "fast", caps: { provide: ["perm:net"] } });
		bus.emit("hub:register", { id: "slow", caps: { provide: ["perm:net"] } });

		const results = await ask(bus, [request("GET")]);
		expect(results[0]).toMatchObject({ what: "perm:net", action: "block" });
	});

	test("no provider still fails closed when only unrelated providers exist", async () => {
		const { bus } = createBus();
		const pi = createFakePi(bus);
		hubExtension(pi as unknown as ExtensionAPI);
		bus.emit("hub:register", { id: "other", caps: { provide: ["perm:tool"] } });

		const results = await ask(bus, [request("GET")]);
		expect(results[0]).toMatchObject({ what: "perm:net", action: "block", reason: "no hub provider" });
	});
});
