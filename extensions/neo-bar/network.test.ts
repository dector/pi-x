import { describe, expect, test } from "bun:test";
import {
	NETWORK_STATE_EVENTS,
	NetworkStateStore,
	POLICY_BORDER_TOKENS,
	POLICY_COLORS,
	POLICY_TOKENS,
	joinSafeModeAndNetwork,
	networkSurfaceForDisplayMode,
	parseNetworkPermissionState,
	parseNetworkStateChanged,
	parseNetworkStateResponse,
	queryNetworkState,
	renderBorderNetworkToken,
	renderEffectiveNetworkToken,
	renderNetworkToken,
	resolveNetworkStatus,
	tokenForPolicy,
	colorForPolicy,
	type NetworkPermissionState,
	type NetworkPolicy,
	type NetworkTheme,
} from "./network.ts";

const ALL_POLICIES: NetworkPolicy[] = [
	"deny-all",
	"ask-all",
	"allow-trusted",
	"ask-untrusted",
	"allow-all",
];

// Minimal theme stub: renders color tokens as `<muted>text</muted>` so tests can
// assert exactly which color family each policy uses.
const theme: NetworkTheme = {
	fg: (token, text) => `<${token}>${text}</${token}>`,
};

function state(overrides: Partial<NetworkPermissionState> = {}): NetworkPermissionState {
	return {
		configured: "auto",
		effective: "ask-all",
		autoEffective: "ask-all",
		overriddenByParanoid: false,
		...overrides,
	};
}

function createBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	return {
		emitted,
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel: string, handler: (data: unknown) => void) {
			const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
	};
}

describe("network token and color matrix", () => {
	test("maps every policy to the exact documented label", () => {
		expect(POLICY_TOKENS).toEqual({
			"deny-all": "NET",
			"ask-all": "NET?",
			"allow-trusted": "NET",
			"ask-untrusted": "NET?",
			"allow-all": "NET+",
		});
	});

	test("maps every policy to the compact border value", () => {
		expect(POLICY_BORDER_TOKENS).toEqual({
			"deny-all": "×",
			"ask-all": "?",
			"allow-trusted": "✓",
			"ask-untrusted": "✓?",
			"allow-all": "!",
		});
	});

	test("maps every legacy policy to the documented muted/user-message color", () => {
		expect(POLICY_COLORS).toEqual({
			"deny-all": "muted",
			"ask-all": "muted",
			"allow-trusted": "userMessageText",
			"ask-untrusted": "userMessageText",
			"allow-all": "userMessageText",
		});
	});

	test("tokenForPolicy/colorForPolicy cover all five policies", () => {
		for (const policy of ALL_POLICIES) {
			expect(tokenForPolicy(policy)).toBe(POLICY_TOKENS[policy]);
			expect(colorForPolicy(policy)).toBe(POLICY_COLORS[policy]);
		}
	});

	test("renderNetworkToken uses the policy label and color", () => {
		for (const policy of ALL_POLICIES) {
			const color = POLICY_COLORS[policy];
			expect(renderNetworkToken(policy, theme)).toBe(`<${color}>${POLICY_TOKENS[policy]}</${color}>`);
		}
	});

	test("renderEffectiveNetworkToken renders the effective policy, not configured", () => {
		const explicitDeny = state({ configured: "allow-all", effective: "deny-all", autoEffective: "allow-trusted" });
		expect(renderEffectiveNetworkToken(explicitDeny, theme)).toBe("<muted>NET</muted>");
	});

	test("border values reserve colors for blocked and unrestricted access", () => {
		expect(renderBorderNetworkToken("deny-all", theme)).toBe("<muted>×</muted>");
		expect(renderBorderNetworkToken("ask-all", theme)).toBe("?");
		expect(renderBorderNetworkToken("allow-trusted", theme)).toBe("✓");
		expect(renderBorderNetworkToken("ask-untrusted", theme)).toBe("✓?");
		expect(renderBorderNetworkToken("allow-all", theme)).toBe("<error>!</error>");
	});
});

describe("PARANOID override rendering", () => {
	test("effective ask-all renders gray NET? even when a permissive policy is saved", () => {
		const paranoid = state({
			configured: "allow-all",
			effective: "ask-all",
			autoEffective: "ask-all",
			overriddenByParanoid: true,
		});
		expect(renderEffectiveNetworkToken(paranoid, theme)).toBe("<muted>NET?</muted>");
		expect(parseNetworkPermissionState(paranoid)).toEqual(paranoid);
	});

	test("PARANOID with Auto saved still renders gray NET?", () => {
		const paranoid = state({
			configured: "auto",
			effective: "ask-all",
			autoEffective: "ask-all",
			overriddenByParanoid: true,
		});
		expect(renderEffectiveNetworkToken(paranoid, theme)).toBe("<muted>NET?</muted>");
	});

	test("inconsistent PARANOID state is rejected by the parser", () => {
		expect(
			parseNetworkPermissionState(
				state({ overriddenByParanoid: true, effective: "allow-all", autoEffective: "allow-trusted" }),
			),
		).toBeUndefined();
	});
});

describe("state validation", () => {
	test("accepts Auto consistent with its derived policy", () => {
		expect(parseNetworkPermissionState(state({ configured: "auto", effective: "allow-trusted", autoEffective: "allow-trusted" }))).toEqual(
			state({ configured: "auto", effective: "allow-trusted", autoEffective: "allow-trusted" }),
		);
	});

	test("accepts every explicit policy whose effective matches configured", () => {
		for (const policy of ALL_POLICIES) {
			const candidate = state({ configured: policy, effective: policy, autoEffective: "ask-all" });
			expect(parseNetworkPermissionState(candidate)).toEqual(candidate);
		}
	});

	test("rejects Auto whose effective differs from autoEffective", () => {
		expect(parseNetworkPermissionState(state({ configured: "auto", effective: "allow-all" }))).toBeUndefined();
	});

	test("rejects explicit choice whose effective differs from configured", () => {
		expect(
			parseNetworkPermissionState(state({ configured: "deny-all", effective: "allow-all" })),
		).toBeUndefined();
	});

	test("rejects an autoEffective that Auto derivation cannot produce", () => {
		expect(parseNetworkPermissionState(state({ autoEffective: "deny-all" }))).toBeUndefined();
	});

	test("rejects malformed and unrelated payloads", () => {
		expect(parseNetworkPermissionState(undefined)).toBeUndefined();
		expect(parseNetworkPermissionState("nope")).toBeUndefined();
		expect(parseNetworkPermissionState([])).toBeUndefined();
		expect(parseNetworkPermissionState({ configured: "auto" })).toBeUndefined();
	});

	test("parseNetworkStateChanged validates the same state shape", () => {
		const valid = { ...state({ configured: "auto", effective: "ask-untrusted", autoEffective: "ask-untrusted" }), source: "core" };
		expect(parseNetworkStateChanged(valid)).toEqual(valid);
		expect(parseNetworkStateChanged({ ...valid, effective: "allow-all" })).toBeUndefined();
		expect(parseNetworkStateChanged(null)).toBeUndefined();
	});

	test("parseNetworkStateResponse requires a bounded id", () => {
		expect(parseNetworkStateResponse({ id: "a", state: state() })).toEqual({ id: "a", state: state() });
		expect(parseNetworkStateResponse({ id: "", state: state() })).toBeUndefined();
		expect(parseNetworkStateResponse({ id: 1, state: state() })).toBeUndefined();
	});
});

describe("surface resolution and display modes", () => {
	test("new display mode owns the border surface", () => {
		expect(networkSurfaceForDisplayMode("new")).toBe("border");
		const resolution = resolveNetworkStatus({ displayMode: "new", state: state({ effective: "allow-all" }), theme });
		expect(resolution).toEqual({ surface: "border", label: "<error>!</error>" });
	});

	test("legacy display mode owns the status-line surface", () => {
		expect(networkSurfaceForDisplayMode("legacy")).toBe("status-line");
		const resolution = resolveNetworkStatus({ displayMode: "legacy", state: state({ effective: "ask-all" }), theme });
		expect(resolution).toEqual({ surface: "status-line", label: "<muted>NET?</muted>" });
	});

	test("each display mode resolves exactly one surface, so the token is never duplicated", () => {
		for (const displayMode of ["new", "legacy"] as const) {
			const resolution = resolveNetworkStatus({ displayMode, state: state(), theme });
			expect(resolution?.surface).toBe(networkSurfaceForDisplayMode(displayMode));
		}
	});

	test("missing state (core absent) resolves to nothing", () => {
		expect(resolveNetworkStatus({ displayMode: "new", state: undefined, theme })).toBeUndefined();
		expect(resolveNetworkStatus({ displayMode: "legacy", state: undefined, theme })).toBeUndefined();
	});
});

describe("safe-mode and network join", () => {
	const border = (text: string) => `[${text}]`;

	test("joins with exactly ` · ` colored by the caller", () => {
		const seen: string[] = [];
		const separator = (text: string) => {
			seen.push(text);
			return border(text);
		};
		expect(joinSafeModeAndNetwork("SMART", "NET?", separator)).toBe("SMART[ · ]NET?");
		expect(seen).toEqual([" · "]);
	});

	test("keeps the network token when safe-mode is missing", () => {
		expect(joinSafeModeAndNetwork(undefined, "NET+", border)).toBe("NET+");
	});

	test("keeps the safe-mode label when network is missing (core absent)", () => {
		expect(joinSafeModeAndNetwork("PARANOID", undefined, border)).toBe("PARANOID");
		expect(joinSafeModeAndNetwork("PARANOID", "", border)).toBe("PARANOID");
	});

	test("returns undefined when both parts are missing", () => {
		expect(joinSafeModeAndNetwork(undefined, undefined, border)).toBeUndefined();
		expect(joinSafeModeAndNetwork("", "", border)).toBeUndefined();
	});
});

describe("NetworkStateStore", () => {
	test("applies validated changed events and notifies on every update", () => {
		const bus = createBus();
		let renders = 0;
		const store = new NetworkStateStore({ events: bus, onChange: () => renders++ });
		store.activate();
		expect(store.current).toBeUndefined();

		const next = state({ configured: "allow-all", effective: "allow-all" });
		bus.emit(NETWORK_STATE_EVENTS.changed, { ...next, source: "core" });
		expect(store.current).toEqual(next);
		expect(renders).toBe(1);
		store.dispose();
	});

	test("ignores malformed changed payloads", () => {
		const bus = createBus();
		let renders = 0;
		const store = new NetworkStateStore({ events: bus, onChange: () => renders++ });
		store.activate();

		bus.emit(NETWORK_STATE_EVENTS.changed, { configured: "auto" });
		bus.emit(NETWORK_STATE_EVENTS.changed, { ...state(), effective: "deny-all" });
		bus.emit(NETWORK_STATE_EVENTS.changed, null);

		expect(store.current).toBeUndefined();
		expect(renders).toBe(0);
		store.dispose();
	});

	test("ignores changed events until a session is activated", () => {
		const bus = createBus();
		let renders = 0;
		const store = new NetworkStateStore({ events: bus, onChange: () => renders++ });

		bus.emit(NETWORK_STATE_EVENTS.changed, state({ configured: "allow-all", effective: "allow-all" }));
		expect(store.current).toBeUndefined();
		expect(renders).toBe(0);

		store.activate();
		const live = state({ configured: "deny-all", effective: "deny-all" });
		bus.emit(NETWORK_STATE_EVENTS.changed, live);
		expect(store.current).toEqual(live);
		expect(renders).toBe(1);
		store.dispose();
	});

	test("deactivate drops state and ignores late changed events after shutdown", () => {
		const bus = createBus();
		let renders = 0;
		const store = new NetworkStateStore({ events: bus, onChange: () => renders++ });
		store.activate();

		const live = state({ configured: "allow-all", effective: "allow-all" });
		bus.emit(NETWORK_STATE_EVENTS.changed, live);
		expect(store.current).toEqual(live);
		expect(renders).toBe(1);

		store.deactivate();
		expect(store.current).toBeUndefined();
		expect(renders).toBe(2);

		// A late event after shutdown must not restore a stale token.
		bus.emit(NETWORK_STATE_EVENTS.changed, live);
		expect(store.current).toBeUndefined();
		expect(renders).toBe(2);

		// Reactivating applies fresh events again.
		store.activate();
		bus.emit(NETWORK_STATE_EVENTS.changed, live);
		expect(store.current).toEqual(live);
		expect(renders).toBe(3);
		store.dispose();
	});

	test("refresh applies the queried state", async () => {
		const bus = createBus();
		const expected = state({ configured: "allow-all", effective: "allow-all" });
		bus.on(NETWORK_STATE_EVENTS.request, (payload) => {
			const id = (payload as { id?: unknown }).id;
			if (typeof id !== "string") return;
			bus.emit(NETWORK_STATE_EVENTS.response, { id, state: expected });
		});

		let renders = 0;
		const store = new NetworkStateStore({ events: bus, onChange: () => renders++ });
		store.activate();
		await store.refresh({ timeoutMs: 50 });

		expect(store.current).toEqual(expected);
		expect(renders).toBe(1);
		store.dispose();
	});

	test("refresh is a no-op while inactive", async () => {
		const bus = createBus();
		let requests = 0;
		bus.on(NETWORK_STATE_EVENTS.request, (payload) => {
			requests += 1;
			const id = (payload as { id?: unknown }).id;
			if (typeof id !== "string") return;
			bus.emit(NETWORK_STATE_EVENTS.response, { id, state: state() });
		});

		const store = new NetworkStateStore({ events: bus, onChange: () => {} });
		await store.refresh({ timeoutMs: 10 });
		expect(requests).toBe(0);
		expect(store.current).toBeUndefined();
		store.dispose();
	});

	test("refresh keeps no state when the core is absent", async () => {
		const bus = createBus();
		const store = new NetworkStateStore({ events: bus, onChange: () => {} });
		store.activate();
		await store.refresh({ timeoutMs: 10 });
		expect(store.current).toBeUndefined();
		store.dispose();
	});

	test("a changed event that lands during refresh wins over the older query response", async () => {
		const bus = createBus();
		bus.on(NETWORK_STATE_EVENTS.request, (payload) => {
			const id = (payload as { id?: unknown }).id;
			if (typeof id !== "string") return;
			setTimeout(() => {
				bus.emit(NETWORK_STATE_EVENTS.response, {
					id,
					state: state({ configured: "deny-all", effective: "deny-all" }),
				});
			}, 5);
		});

		const store = new NetworkStateStore({ events: bus, onChange: () => {} });
		store.activate();
		const pending = store.refresh({ timeoutMs: 50 });
		const liveUpdate = state({ configured: "allow-all", effective: "allow-all" });
		bus.emit(NETWORK_STATE_EVENTS.changed, liveUpdate);
		await pending;

		expect(store.current).toEqual(liveUpdate);
		store.dispose();
	});

	test("clear resets to no state and notifies; dispose stops updates", () => {
		const bus = createBus();
		let renders = 0;
		const store = new NetworkStateStore({ events: bus, onChange: () => renders++ });
		store.activate();
		const next = state({ configured: "allow-all", effective: "allow-all" });

		bus.emit(NETWORK_STATE_EVENTS.changed, next);
		store.clear();
		expect(store.current).toBeUndefined();
		expect(renders).toBe(2);

		store.dispose();
		bus.emit(NETWORK_STATE_EVENTS.changed, next);
		expect(store.current).toBeUndefined();
		expect(renders).toBe(2);
	});
});

describe("queryNetworkState", () => {
	test("resolves the state from a matching response", async () => {
		const bus = createBus();
		const expected = state({ configured: "allow-all", effective: "allow-all" });
		bus.on(NETWORK_STATE_EVENTS.request, (payload) => {
			const id = (payload as { id?: unknown }).id;
			if (typeof id !== "string") return;
			bus.emit(NETWORK_STATE_EVENTS.response, { id, state: expected });
		});

		await expect(queryNetworkState(bus, { timeoutMs: 50 })).resolves.toEqual(expected);
	});

	test("ignores mismatched ids, malformed responses, and unrelated events", async () => {
		const bus = createBus();
		bus.on(NETWORK_STATE_EVENTS.request, (payload) => {
			const id = (payload as { id?: unknown }).id;
			if (typeof id !== "string") return;
			bus.emit(NETWORK_STATE_EVENTS.response, { id: "someone-else", state: state() });
			bus.emit(NETWORK_STATE_EVENTS.response, { id, state: { bogus: true } });
			bus.emit("unrelated", { id, state: state() });
		});

		await expect(queryNetworkState(bus, { timeoutMs: 20 })).resolves.toBeUndefined();
	});

	test("resolves undefined when the core is absent (timeout)", async () => {
		const bus = createBus();
		await expect(queryNetworkState(bus, { timeoutMs: 10 })).resolves.toBeUndefined();
	});

	test("resolves undefined when emitting the request throws", async () => {
		const bus = {
			emit() {
				throw new Error("boom");
			},
			on() {
				return () => {};
			},
		};
		await expect(queryNetworkState(bus, { timeoutMs: 20 })).resolves.toBeUndefined();
	});
});
