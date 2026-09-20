import { describe, expect, test } from "bun:test";
import {
	createAuthorizationStore,
	fingerprintValue,
	parseToolAuthorized,
	stableStringify,
} from "./authorization.ts";

describe("network authorization store", () => {
	test("parseToolAuthorized accepts only bounded id + tool name", () => {
		expect(parseToolAuthorized({ toolCallId: "call-1", toolName: "http" })).toEqual({
			toolCallId: "call-1",
			toolName: "http",
		});
		expect(parseToolAuthorized({ toolCallId: "call-1", toolName: "http", source: "safe-mode" })).toEqual({
			toolCallId: "call-1",
			toolName: "http",
			source: "safe-mode",
		});
		for (const value of [
			null,
			[],
			{},
			{ toolCallId: "", toolName: "http" },
			{ toolCallId: "call-1" },
			{ toolCallId: "call-1", toolName: "" },
			{ toolCallId: "call-1", toolName: "http", source: 7 },
		]) {
			expect(parseToolAuthorized(value)).toBeUndefined();
		}
	});

	test("stableStringify and fingerprintValue are order-independent and deterministic", () => {
		expect(stableStringify({ b: 2, a: [1, { d: 4, c: 3 }] })).toBe(stableStringify({ a: [1, { c: 3, d: 4 }], b: 2 }));
		expect(fingerprintValue({ a: 1, b: 2 })).toBe(fingerprintValue({ b: 2, a: 1 }));
		expect(fingerprintValue({ a: 1 })).not.toBe(fingerprintValue({ a: 2 }));
		expect(fingerprintValue(null)).toHaveLength(64);
	});

	test("preflight -> authorize -> consume succeeds once", () => {
		const store = createAuthorizationStore();
		expect(store.preflight("call-1", "http", "fp-1")).toBe(true);
		expect(store.size()).toBe(1);

		// Not authorized yet.
		expect(store.consume("call-1", "http", "fp-1").ok).toBe(false);

		// Re-preflight then authorize.
		store.preflight("call-1", "http", "fp-1");
		expect(store.authorize("call-1", "http")).toBe(true);
		expect(store.consume("call-1", "http", "fp-1").ok).toBe(true);
		expect(store.size()).toBe(0);
	});

	test("consume fails without preflight, when unauthorized, on tool mismatch, or on changed params", () => {
		const store = createAuthorizationStore();
		expect(store.consume("missing", "http", "fp").ok).toBe(false);

		store.preflight("call-1", "http", "fp-1");
		expect(store.consume("call-1", "http", "fp-1").ok).toBe(false);

		store.preflight("call-2", "http", "fp-2");
		store.authorize("call-2", "http");
		expect(store.consume("call-2", "http_md", "fp-2").ok).toBe(false);

		store.preflight("call-3", "http", "fp-3");
		store.authorize("call-3", "http");
		const mismatch = store.consume("call-3", "http", "fp-changed");
		expect(mismatch.ok).toBe(false);
		expect(mismatch.reason).toContain("changed");
	});

	test("authorize rejects unknown tickets and tool mismatches", () => {
		const store = createAuthorizationStore();
		expect(store.authorize("missing", "http")).toBe(false);
		store.preflight("call-1", "http", "fp-1");
		expect(store.authorize("call-1", "web_search")).toBe(false);
		expect(store.consume("call-1", "http", "fp-1").ok).toBe(false);
	});

	test("consumption is replay-safe", () => {
		const store = createAuthorizationStore();
		store.preflight("call-1", "http", "fp-1");
		store.authorize("call-1", "http");
		expect(store.consume("call-1", "http", "fp-1").ok).toBe(true);

		// The ticket is gone; a replayed consume must fail closed.
		expect(store.consume("call-1", "http", "fp-1").ok).toBe(false);
	});

	test("revoke drops a pending ticket without authorizing it", () => {
		const store = createAuthorizationStore();
		store.preflight("call-1", "http", "fp-1");
		expect(store.revoke("call-1")).toBe(true);
		expect(store.size()).toBe(0);
		expect(store.authorize("call-1", "http")).toBe(false);
		expect(store.consume("call-1", "http", "fp-1").ok).toBe(false);
		expect(store.revoke("call-1")).toBe(false);
	});

	test("authorize refreshes the ticket TTL from the final decision", () => {
		let now = 1_000;
		const store = createAuthorizationStore({ ttlMs: 100, now: () => now });
		store.preflight("call-1", "http", "fp-1");
		now += 90; // Still alive, but close to the original expiry.
		expect(store.authorize("call-1", "http")).toBe(true);
		now += 90; // Past createdAt + 100, but within the refreshed expiry.
		expect(store.consume("call-1", "http", "fp-1").ok).toBe(true);
	});

	test("expired tickets are pruned and cannot be consumed", () => {
		let now = 1_000;
		const store = createAuthorizationStore({ ttlMs: 100, now: () => now });
		store.preflight("call-1", "http", "fp-1");
		store.authorize("call-1", "http");

		now += 1_000;
		expect(store.consume("call-1", "http", "fp-1").ok).toBe(false);
		expect(store.size()).toBe(0);
	});

	test("the store is bounded and drops the oldest tickets", () => {
		let now = 1_000;
		const store = createAuthorizationStore({ maxEntries: 2, now: () => now });
		store.preflight("call-1", "http", "fp-1");
		now += 1;
		store.preflight("call-2", "http", "fp-2");
		now += 1;
		store.preflight("call-3", "http", "fp-3");
		expect(store.size()).toBe(2);
		// Oldest was evicted.
		expect(store.authorize("call-1", "http")).toBe(false);
		expect(store.authorize("call-3", "http")).toBe(true);
	});

	test("reset clears all tickets", () => {
		const store = createAuthorizationStore();
		store.preflight("call-1", "http", "fp-1");
		store.preflight("call-2", "web_search", "fp-2");
		store.reset();
		expect(store.size()).toBe(0);
		expect(store.consume("call-1", "http", "fp-1").ok).toBe(false);
	});

	test("preflight rejects malformed keys and fingerprints", () => {
		const store = createAuthorizationStore();
		expect(store.preflight("", "http", "fp")).toBe(false);
		expect(store.preflight("call-1", "", "fp")).toBe(false);
		expect(store.preflight("call-1", "http", "")).toBe(false);
		expect(store.size()).toBe(0);
	});
});
