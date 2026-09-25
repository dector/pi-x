/**
 * Network-policy inheritance tests.
 *
 * The parent query is bounded and reads only permissions-core's validated
 * state contract, and the child flag is added only for a valid snapshot so a
 * failed query can never invent a more permissive policy.
 */

import { describe, expect, test } from "bun:test";
import {
	NETWORK_POLICY_FLAG,
	NETWORK_POLICY_STATE_REQUEST_EVENT,
	NETWORK_POLICY_STATE_RESPONSE_EVENT,
	appendNetworkPolicyArgs,
	parseNetworkPolicySetting,
	queryNetworkPolicySnapshot,
} from "./network-policy.ts";

class FakeEvents {
	private handlers = new Map<string, Set<(payload: unknown) => void>>();

	on(channel: string, handler: (payload: unknown) => void): () => void {
		const handlers = this.handlers.get(channel) ?? new Set();
		handlers.add(handler);
		this.handlers.set(channel, handlers);
		return () => handlers.delete(handler);
	}

	emit(channel: string, payload: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(payload);
	}

	listenerCount(channel: string): number {
		return this.handlers.get(channel)?.size ?? 0;
	}
}

/** Answer every state request with a fixed payload. */
function respondWith(events: FakeEvents, payload: (id: string) => unknown): void {
	events.on(NETWORK_POLICY_STATE_REQUEST_EVENT, (request) => {
		const id = (request as { id?: unknown }).id;
		if (typeof id !== "string") return;
		events.emit(NETWORK_POLICY_STATE_RESPONSE_EVENT, payload(id));
	});
}

function stateResponse(id: string, state: unknown): unknown {
	return { id, state };
}

describe("subagent network policy parsing", () => {
	test("accepts every configured policy and rejects everything else", () => {
		for (const setting of [
			"auto",
			"deny-all",
			"ask-all",
			"allow-trusted",
			"ask-untrusted",
			"allow-all",
		]) {
			expect(parseNetworkPolicySetting(setting)).toBe(setting);
		}

		for (const value of [
			undefined,
			null,
			42,
			true,
			[],
			{},
			"",
			" ",
			"ALL-ALLOW",
			"allow all",
			"yolo",
			"ask-untrusted\n",
		]) {
			expect(parseNetworkPolicySetting(value)).toBeUndefined();
		}
	});
});

describe("queryNetworkPolicySnapshot", () => {
	test("reads the configured policy from a correlated response and cleans up", async () => {
		const events = new FakeEvents();
		respondWith(events, (id) =>
			stateResponse(id, {
				// `effective` is deliberately not inherited: the child derives its
				// own effective policy from its own safe mode.
				configured: "allow-all",
				effective: "allow-all",
				autoEffective: "allow-trusted",
				overriddenByParanoid: false,
			}),
		);

		await expect(queryNetworkPolicySnapshot(events, { requestId: "request-1", timeoutMs: 50 })).resolves.toBe("allow-all");
		expect(events.listenerCount(NETWORK_POLICY_STATE_RESPONSE_EVENT)).toBe(0);
	});

	test("ignores responses correlated to another request", async () => {
		const events = new FakeEvents();
		events.on(NETWORK_POLICY_STATE_REQUEST_EVENT, (request) => {
			const id = (request as { id?: unknown }).id;
			// Responses for other queries must not settle this one.
			events.emit(NETWORK_POLICY_STATE_RESPONSE_EVENT, stateResponse("other-request", { configured: "deny-all" }));
			events.emit(NETWORK_POLICY_STATE_RESPONSE_EVENT, { state: { configured: "deny-all" } });
			// The matching id arrives on a later turn, as a real provider does.
			setTimeout(() => {
				events.emit(NETWORK_POLICY_STATE_RESPONSE_EVENT, stateResponse(id as string, { configured: "ask-all" }));
			}, 1);
		});

		await expect(queryNetworkPolicySnapshot(events, { requestId: "request-1", timeoutMs: 100 })).resolves.toBe("ask-all");
		expect(events.listenerCount(NETWORK_POLICY_STATE_RESPONSE_EVENT)).toBe(0);
	});

	test("resolves undefined for malformed state instead of inheriting a policy", async () => {
		const malformedStates: unknown[] = [
			undefined,
			null,
			"allow-all",
			42,
			[],
			{},
			{ configured: "allow-all-please" },
			{ configured: "ALLOW-ALL" },
			{ configured: "" },
			{ configured: null },
			// Only the derived policy is present: the configured choice is missing.
			{ effective: "allow-all", autoEffective: "allow-trusted", overriddenByParanoid: false },
		];
		for (const state of malformedStates) {
			const events = new FakeEvents();
			respondWith(events, (id) => stateResponse(id, state));
			await expect(queryNetworkPolicySnapshot(events, { requestId: "r", timeoutMs: 50 })).resolves.toBeUndefined();
			expect(events.listenerCount(NETWORK_POLICY_STATE_RESPONSE_EVENT)).toBe(0);
		}
	});

	test("resolves undefined for a malformed envelope", async () => {
		const events = new FakeEvents();
		events.on(NETWORK_POLICY_STATE_REQUEST_EVENT, () => {
			for (const payload of ["nope", 42, null, ["state"], { state: { configured: "allow-all" } }]) {
				events.emit(NETWORK_POLICY_STATE_RESPONSE_EVENT, payload);
			}
		});
		// No record response correlates, so the bounded timeout settles the query.
		await expect(queryNetworkPolicySnapshot(events, { requestId: "r", timeoutMs: 1 })).resolves.toBeUndefined();
		expect(events.listenerCount(NETWORK_POLICY_STATE_RESPONSE_EVENT)).toBe(0);
	});

	test("times out when permissions-core is absent", async () => {
		const events = new FakeEvents();
		await expect(queryNetworkPolicySnapshot(events, { timeoutMs: 1 })).resolves.toBeUndefined();
		expect(events.listenerCount(NETWORK_POLICY_STATE_RESPONSE_EVENT)).toBe(0);
	});

	test("resolves undefined when emitting the request throws", async () => {
		const events = new FakeEvents();
		events.emit = () => {
			throw new Error("bus exploded");
		};
		await expect(queryNetworkPolicySnapshot(events, { timeoutMs: 50 })).resolves.toBeUndefined();
		expect(events.listenerCount(NETWORK_POLICY_STATE_RESPONSE_EVENT)).toBe(0);
	});
});

describe("appendNetworkPolicyArgs", () => {
	test("adds the flag only when a valid setting was snapshotted", () => {
		const inherited = ["--mode", "rpc"];
		appendNetworkPolicyArgs(inherited, "allow-all");
		expect(inherited).toEqual(["--mode", "rpc", `--${NETWORK_POLICY_FLAG}`, "allow-all"]);

		const auto = ["--mode", "rpc"];
		appendNetworkPolicyArgs(auto, "auto");
		expect(auto).toEqual(["--mode", "rpc", `--${NETWORK_POLICY_FLAG}`, "auto"]);
	});

	test("omits the flag when no valid snapshot is available", () => {
		for (const setting of [undefined, "", "allow-all-please", "ALLOW-ALL", null, 1, {}, []]) {
			const args = ["--mode", "rpc"];
			appendNetworkPolicyArgs(args, setting);
			expect(args).toEqual(["--mode", "rpc"]);
		}
	});
});
