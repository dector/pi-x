import { describe, expect, test } from "bun:test";
import { NETWORK_STATE_EVENTS } from "./contract.ts";
import { queryNetworkState, type EventBusLike } from "./query.ts";

function createBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const bus: EventBusLike = {
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
	return bus;
}

const VALID_STATE = {
	configured: "auto",
	effective: "ask-untrusted",
	autoEffective: "ask-untrusted",
	overriddenByParanoid: false,
} as const;

describe("queryNetworkState", () => {
	test("resolves the state from a matching response", async () => {
		const bus = createBus();
		bus.on(NETWORK_STATE_EVENTS.request, (payload) => {
			const id = (payload as { id: string }).id;
			bus.emit(NETWORK_STATE_EVENTS.response, { id, state: VALID_STATE });
		});

		await expect(queryNetworkState(bus, { requestId: "req-1" })).resolves.toEqual(VALID_STATE);
	});

	test("ignores mismatched, malformed, and unrelated responses", async () => {
		const bus = createBus();
		bus.on(NETWORK_STATE_EVENTS.request, (payload) => {
			const id = (payload as { id: string }).id;
			bus.emit(NETWORK_STATE_EVENTS.response, { id: "someone-else", state: VALID_STATE });
			bus.emit(NETWORK_STATE_EVENTS.response, { id, state: { configured: "auto" } });
			bus.emit(NETWORK_STATE_EVENTS.response, { id, state: VALID_STATE });
		});

		await expect(queryNetworkState(bus, { requestId: "req-2" })).resolves.toEqual(VALID_STATE);
	});

	test("resolves undefined on timeout when core is absent", async () => {
		const bus = createBus();
		await expect(queryNetworkState(bus, { requestId: "req-3", timeoutMs: 5 })).resolves.toBeUndefined();
	});

	test("resolves undefined when emitting fails", async () => {
		const bus: EventBusLike = {
			emit() {
				throw new Error("boom");
			},
			on() {
				return () => {};
			},
		};
		await expect(queryNetworkState(bus, { requestId: "req-4" })).resolves.toBeUndefined();
	});
});
