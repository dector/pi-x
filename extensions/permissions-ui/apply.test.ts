import { describe, expect, test } from "bun:test";
import { applyNetworkSetting } from "./apply.ts";
import { NETWORK_STATE_EVENTS, type NetworkPermissionState } from "./contract.ts";
import type { EventBusLike } from "./query.ts";

function createBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const bus: EventBusLike & { emitted: typeof emitted } = {
		emitted,
		emit(channel, data) {
			emitted.push({ channel, data });
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
	};
	return bus;
}

function state(configured: NetworkPermissionState["configured"]): NetworkPermissionState {
	const effective = configured === "auto" ? "ask-untrusted" : configured;
	return { configured, effective, autoEffective: "ask-untrusted", overriddenByParanoid: false };
}

function changedPayload(configured: NetworkPermissionState["configured"], source?: string) {
	const current = state(configured);
	return { ...current, source };
}

describe("applyNetworkSetting", () => {
	test("emits set and resolves true on a matching changed ack", async () => {
		const bus = createBus();
		bus.on(NETWORK_STATE_EVENTS.set, (payload) => {
			expect(payload).toEqual({ setting: "allow-all", source: "permissions-ui" });
			bus.emit(NETWORK_STATE_EVENTS.changed, changedPayload("allow-all", "permissions-ui"));
		});

		const accepted = await applyNetworkSetting(bus, "allow-all", "permissions-ui", {
			queryState: async () => undefined,
			timeoutMs: 50,
		});
		expect(accepted).toBe(true);
	});

	test("accepts a matching changed without a source", async () => {
		const bus = createBus();
		bus.on(NETWORK_STATE_EVENTS.set, () => {
			bus.emit(NETWORK_STATE_EVENTS.changed, changedPayload("allow-all"));
		});

		const accepted = await applyNetworkSetting(bus, "allow-all", "permissions-ui", {
			queryState: async () => undefined,
			timeoutMs: 50,
		});
		expect(accepted).toBe(true);
	});

	test("ignores a changed from another source and falls back to the re-query", async () => {
		const bus = createBus();
		bus.on(NETWORK_STATE_EVENTS.set, () => {
			// A different writer acknowledges first; it must not count as our ack.
			bus.emit(NETWORK_STATE_EVENTS.changed, changedPayload("allow-all", "concurrent"));
		});

		let queried = 0;
		const accepted = await applyNetworkSetting(bus, "allow-all", "permissions-ui", {
			queryState: async () => {
				queried++;
				return state("allow-all");
			},
			timeoutMs: 20,
		});
		expect(accepted).toBe(true);
		expect(queried).toBe(1);
	});

	test("no-op race: no changed is emitted, but the re-query matches the request", async () => {
		const bus = createBus();
		let queried = 0;
		const accepted = await applyNetworkSetting(bus, "allow-all", "permissions-ui", {
			queryState: async () => {
				queried++;
				return state("allow-all");
			},
			timeoutMs: 20,
		});
		expect(accepted).toBe(true);
		expect(queried).toBe(1);
	});

	test("resolves false when nothing confirms the request", async () => {
		const bus = createBus();
		let queried = 0;
		const accepted = await applyNetworkSetting(bus, "allow-all", "permissions-ui", {
			queryState: async () => {
				queried++;
				return state("auto");
			},
			timeoutMs: 20,
		});
		expect(accepted).toBe(false);
		expect(queried).toBe(1);
	});

	test("resolves false when the re-query is unavailable", async () => {
		const bus = createBus();
		const accepted = await applyNetworkSetting(bus, "allow-all", "permissions-ui", {
			queryState: async () => undefined,
			timeoutMs: 20,
		});
		expect(accepted).toBe(false);
	});

	test("resolves false when emitting the set throws", async () => {
		const bus: EventBusLike = {
			emit() {
				throw new Error("boom");
			},
			on() {
				return () => {};
			},
		};
		const accepted = await applyNetworkSetting(bus, "allow-all", "permissions-ui", {
			queryState: async () => state("allow-all"),
			timeoutMs: 20,
		});
		expect(accepted).toBe(false);
	});
});
