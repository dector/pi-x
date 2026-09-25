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
	flags: Map<string, boolean | string | undefined>;
	registeredFlags: Array<{ name: string; description?: string; type?: string }>;
	notifications: string[];
	on(event: string, handler: BusHandler): void;
	registerCommand(name: string, options: unknown): void;
	registerTool(): void;
	registerFlag(name: string, options: { description?: string; type?: string }): void;
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
		registeredFlags: [],
		notifications: [],
		on(event, handler) {
			const list = lifecycle.get(event) ?? [];
			list.push(handler);
			lifecycle.set(event, list);
		},
		registerCommand() {},
		registerTool() {},
		registerFlag(name, options) {
			pi.registeredFlags.push({ name, description: options.description, type: options.type });
		},
		getFlag(name) {
			return pi.flags.get(name);
		},
		appendEntry(customType, data) {
			pi.entries.push({ customType, data });
		},
	};
	return pi;
}

function createContext(branch: unknown[] = [], notifications: string[] = []) {
	return {
		hasUI: true,
		cwd: "/tmp",
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getBranch: () => branch },
	};
}

async function fireLifecycle(pi: FakePi, event: string, branch: unknown[] = [], notifications: string[] = []): Promise<void> {
	const ctx = createContext(branch, notifications);
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

async function askPermNet(
	bus: Bus,
	id: string,
	data: { toolName?: string; operation?: string; url?: string; method?: string } = {},
): Promise<Array<{ what: string; action: string; reason?: string }>> {
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
			cap: [
				{
					what: "perm:net",
					data: { toolName: "http", operation: "request", url: "https://example.com", method: "GET", ...data },
				},
			],
		});
	});
}

function setup(flags?: Record<string, string | boolean>) {
	const { bus } = createBus();
	const pi = createFakePi(bus, flags);
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
			state: { configured: "allow-all", effective: "allow-all", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		});

		// session_tree with a persisted explicit choice: reset (Auto) then restore.
		const branch = [{ type: "custom", customType: "permissions-core-net", data: { configured: "allow-trusted" } }];
		await fireLifecycle(pi, "session_tree", branch);
		expect(await requestState(bus, "s2")).toMatchObject({
			state: { configured: "allow-trusted", effective: "allow-trusted", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		});

		// session_tree with an empty branch must not leave the previous explicit
		// choice visible to consumers.
		await fireLifecycle(pi, "session_tree", []);
		expect(await requestState(bus, "s3")).toMatchObject({
			state: { configured: "auto", effective: "ask-untrusted", autoEffective: "ask-untrusted", overriddenByParanoid: false },
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
			state: { configured: "auto", effective: "ask-untrusted", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		});
	});

	test("safe-mode changes propagate to state consumers", async () => {
		const { bus, pi, safeMode } = setup();
		await fireLifecycle(pi, "session_start");
		safeMode.setMode("paranoid");
		expect(await requestState(bus, "p1")).toMatchObject({
			state: { configured: "auto", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: true },
		});
		safeMode.setMode("yolo");
		expect(await requestState(bus, "y1")).toMatchObject({
			state: { configured: "auto", effective: "allow-trusted", autoEffective: "allow-trusted", overriddenByParanoid: false },
		});
	});

	test("outer access (YOLO+) derives the same policy as its safe mode", async () => {
		const { bus } = createBus();
		const pi = createFakePi(bus);
		hubExtension(pi as unknown as ExtensionAPI);
		permissionsCoreExtension(pi as unknown as ExtensionAPI);
		// Safe mode reports `yolo` with outer access on: the `YOLO+` label. Outer
		// access is a filesystem/scope modifier and must not change network policy.
		bus.on("px:safe-mode:state:request", (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			const id = (payload as { id?: unknown }).id;
			if (typeof id !== "string") return;
			bus.emit("px:safe-mode:state:response", { id, state: { mode: "yolo", outerAccess: true } });
		});

		await fireLifecycle(pi, "session_start");
		expect(await requestState(bus, "yolo-plus")).toMatchObject({
			state: { configured: "auto", effective: "allow-trusted", autoEffective: "allow-trusted", overriddenByParanoid: false },
		});
		// Trusted traffic still allows, exactly as for plain `yolo`.
		expect((await askPermNet(bus, "yolo-plus-get"))[0]).toMatchObject({ what: "perm:net", action: "allow" });
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
			state: { configured: "auto", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: true },
		});
		// The provider still answers and fails closed to approval.
		expect((await askPermNet(bus, "absent-ask"))[0]).toMatchObject({ what: "perm:net", action: "confirm" });
	});
});

describe("inherited --network-policy flag", () => {
	test("registers the flag with the full policy list in its description", () => {
		const { pi } = setup();
		const flag = pi.registeredFlags.find((entry) => entry.name === "network-policy");
		expect(flag).toBeDefined();
		expect(flag?.type).toBe("string");
		expect(flag?.description).toContain("auto");
		for (const setting of ["deny-all", "ask-all", "allow-trusted", "ask-untrusted", "allow-all"]) {
			expect(flag?.description).toContain(setting);
		}
	});

	test("a valid flag overrides an empty session branch", async () => {
		// A subagent child is a fresh `--no-session` run: nothing is persisted, so
		// without the flag it would start at `auto`.
		const { bus, pi } = setup({ "network-policy": "allow-all" });
		await fireLifecycle(pi, "session_start");
		expect(await requestState(bus, "inherited")).toMatchObject({
			state: { configured: "allow-all", effective: "allow-all", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		});
	});

	test("a valid flag wins over a persisted session choice", async () => {
		const { bus, pi } = setup({ "network-policy": "allow-all" });
		const branch = [{ type: "custom", customType: "permissions-core-net", data: { configured: "deny-all" } }];
		await fireLifecycle(pi, "session_tree", branch);
		expect(await requestState(bus, "inherited-over-persisted")).toMatchObject({
			state: { configured: "allow-all", effective: "allow-all" },
		});
	});

	test("an invalid flag fails closed to ask-all instead of reverting to Auto", async () => {
		for (const value of ["bogus", "ALLOW-ALL", "", "allow-all ", 7 as unknown as string]) {
			const { bus, pi } = setup({ "network-policy": value });
			await fireLifecycle(pi, "session_start");
			expect(await requestState(bus, `invalid-${String(value)}`)).toMatchObject({
				state: { configured: "ask-all", effective: "ask-all", autoEffective: "ask-untrusted", overriddenByParanoid: false },
			});
		}
	});

	test("an invalid flag never falls back to a persisted choice and warns once", async () => {
		const { bus, pi } = setup({ "network-policy": "nope" });
		const branch = [{ type: "custom", customType: "permissions-core-net", data: { configured: "allow-all" } }];
		const notifications: string[] = [];
		await fireLifecycle(pi, "session_tree", branch, notifications);
		expect(await requestState(bus, "invalid-over-persisted")).toMatchObject({
			state: { configured: "ask-all", effective: "ask-all" },
		});
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain("--network-policy");
		expect(notifications[0]).toContain("nope");
	});

	test("an invalid flag is rejected silently when the session has no UI", async () => {
		const { bus, pi } = setup({ "network-policy": "nope" });
		const ctx = { hasUI: false, cwd: "/tmp", sessionManager: { getBranch: () => [] } };
		for (const handler of pi.lifecycle.get("session_start") ?? []) await handler({}, ctx);
		expect(await requestState(bus, "invalid-headless")).toMatchObject({
			state: { configured: "ask-all", effective: "ask-all" },
		});
	});

	test("an absent flag keeps normal persisted restore behavior", async () => {
		const { bus, pi } = setup();
		// No flag: Auto on a fresh branch.
		await fireLifecycle(pi, "session_start");
		expect(await requestState(bus, "no-flag-1")).toMatchObject({
			state: { configured: "auto", effective: "ask-untrusted", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		});
		// No flag: the persisted choice is still restored.
		const branch = [{ type: "custom", customType: "permissions-core-net", data: { configured: "allow-trusted" } }];
		await fireLifecycle(pi, "session_tree", branch);
		expect(await requestState(bus, "no-flag-2")).toMatchObject({
			state: { configured: "allow-trusted", effective: "allow-trusted" },
		});
		// No flag + corrupt persisted entry still fails closed.
		const corrupt = [{ type: "custom", customType: "permissions-core-net", data: { configured: "bogus" } }];
		await fireLifecycle(pi, "session_tree", corrupt);
		expect(await requestState(bus, "no-flag-3")).toMatchObject({
			state: { configured: "ask-all", effective: "ask-all" },
		});
	});

	test("the inherited policy is what perm:net enforces", async () => {
		const { bus, pi } = setup({ "network-policy": "allow-all" });
		await fireLifecycle(pi, "session_start");
		// An untrusted method is allowed, which `auto`/`ask-untrusted` would not do.
		const untrusted = await askPermNet(bus, "inherited-post", {
			toolName: "http",
			operation: "request",
			url: "https://example.com",
			method: "POST",
		});
		expect(untrusted[0]).toMatchObject({ what: "perm:net", action: "allow" });
	});

	test("PARANOID still forces ask-all with an inherited allow-all", async () => {
		const { bus, pi, safeMode } = setup({ "network-policy": "allow-all" });
		await fireLifecycle(pi, "session_start");
		safeMode.setMode("paranoid");
		// The configured choice is inherited, but PARANOID still overrides it.
		expect(await requestState(bus, "paranoid-inherited")).toMatchObject({
			state: { configured: "allow-all", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: true },
		});
		const untrusted = await askPermNet(bus, "paranoid-post", {
			toolName: "http",
			operation: "request",
			url: "https://example.com",
			method: "POST",
		});
		expect(untrusted[0]).toMatchObject({ what: "perm:net", action: "confirm" });
	});

	test("an inherited auto keeps the child's own safe-mode derivation", async () => {
		const { bus, pi, safeMode } = setup({ "network-policy": "auto" });
		await fireLifecycle(pi, "session_start");
		expect(await requestState(bus, "inherited-auto")).toMatchObject({
			state: { configured: "auto", effective: "ask-untrusted", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		});
		safeMode.setMode("yolo");
		expect(await requestState(bus, "inherited-auto-yolo")).toMatchObject({
			state: { configured: "auto", effective: "allow-trusted", autoEffective: "allow-trusted" },
		});
	});

	test("inheriting never persists an entry for the child session", async () => {
		const { bus, pi } = setup({ "network-policy": "allow-all" });
		await fireLifecycle(pi, "session_start");
		expect(pi.entries).toEqual([]);
		// A later explicit change still persists normally.
		bus.emit(NETWORK_STATE_EVENTS.set, { setting: "ask-all", source: "test" });
		expect(pi.entries).toEqual([{ customType: "permissions-core-net", data: { configured: "ask-all" } }]);
	});

	test("a nested child reports the configured choice its own child would inherit", async () => {
		// Nested subagents: a child that queries its own state and hands the
		// `configured` value to a grandchild must pass the choice, not the
		// derived `effective` value.
		const { bus, pi, safeMode } = setup({ "network-policy": "allow-trusted" });
		await fireLifecycle(pi, "session_start");
		const inherited = (await requestState(bus, "nested")) as { state: { configured: string; effective: string } };
		expect(inherited.state).toEqual({
			configured: "allow-trusted",
			effective: "allow-trusted",
			autoEffective: "ask-untrusted",
			overriddenByParanoid: false,
		});

		// Under PARANOID the effective value must stay `ask-all`, so a grandchild
		// inheriting the reported `configured` choice still derives ask-all itself.
		safeMode.setMode("paranoid");
		const paranoid = (await requestState(bus, "nested-paranoid")) as { state: { configured: string; effective: string } };
		expect(paranoid.state.configured).toBe("allow-trusted");
		expect(paranoid.state.effective).toBe("ask-all");
	});

	test("an inherited auto makes a grandchild derive from its own safe mode", async () => {
		const { bus, pi, safeMode } = setup({ "network-policy": "auto" });
		await fireLifecycle(pi, "session_start");
		safeMode.setMode("yolo");
		const state = (await requestState(bus, "nested-auto")) as { state: { configured: string; effective: string } };
		// The reported choice is `auto`, so the grandchild re-derives instead of
		// freezing this process's derived policy.
		expect(state.state.configured).toBe("auto");
		expect(state.state.effective).toBe("allow-trusted");
	});
});
