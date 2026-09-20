import { describe, expect, test } from "bun:test";
import { NETWORK_STATE_EVENTS } from "./contract.ts";
import {
	HUB_REGISTER_EVENT,
	HUB_REPLY_EVENT,
	HUB_ASK_EVENT,
	HUB_UNREGISTER_EVENT,
	PERM_NET,
	PERMISSIONS_CORE_ENTRY_TYPE,
	PERMISSIONS_CORE_ID,
	createNetworkPermissionService,
} from "./provider.ts";

type Emitted = { channel: string; payload: unknown };

function createHarness() {
	const emitted: Emitted[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const service = createNetworkPermissionService({
		emit: (channel, payload) => emitted.push({ channel, payload }),
		appendEntry: (customType, data) => entries.push({ customType, data }),
	});
	return {
		service,
		emitted,
		entries,
		clearEmitted: () => {
			emitted.length = 0;
		},
		changed: () => emitted.filter((event) => event.channel === NETWORK_STATE_EVENTS.changed),
		responses: () => emitted.filter((event) => event.channel === NETWORK_STATE_EVENTS.response),
		replies: () => emitted.filter((event) => event.channel === HUB_REPLY_EVENT),
	};
}

function httpRequest(method: string, url = "https://example.com") {
	return { toolName: "http", operation: "request", url, method };
}

function hubRequest(data: unknown, overrides?: { id?: string; targets?: unknown; cap?: unknown }) {
	return {
		id: overrides?.id ?? "req-1",
		targets: overrides?.targets ?? [PERMISSIONS_CORE_ID],
		cap: overrides?.cap ?? [{ what: PERM_NET, data }],
	};
}

function lastReply(harness: ReturnType<typeof createHarness>) {
	const replies = harness.replies();
	expect(replies.length).toBeGreaterThan(0);
	return replies[replies.length - 1]?.payload as {
		id: string;
		from: string;
		results: Array<{ what: string; action: string; reason?: string; summary?: string }>;
	};
}

describe("permissions-core hub provider", () => {
	test("register/unregister announce the perm:net capability", () => {
		const harness = createHarness();
		harness.service.register();
		expect(harness.emitted[0]).toEqual({
			channel: HUB_REGISTER_EVENT,
			payload: { id: PERMISSIONS_CORE_ID, caps: { provide: [PERM_NET] } },
		});
		harness.service.unregister();
		expect(harness.emitted[1]).toEqual({
			channel: HUB_UNREGISTER_EVENT,
			payload: { id: PERMISSIONS_CORE_ID },
		});
	});

	test("answers trusted and untrusted requests through the effective policy", () => {
		const harness = createHarness();
		harness.service.observeSafeMode("smart");

		expect(harness.service.handleHubRequest(hubRequest(httpRequest("GET")))).toBe(true);
		expect(lastReply(harness).results).toEqual([
			{ what: PERM_NET, action: "allow", reason: undefined, summary: "http: GET https://example.com/" },
		]);

		expect(harness.service.handleHubRequest(hubRequest(httpRequest("POST"), { id: "req-2" }))).toBe(true);
		const confirmed = lastReply(harness);
		expect(confirmed.results[0]?.action).toBe("confirm");
		expect(confirmed.results[0]?.summary).toBe("http: POST https://example.com/");

		harness.service.observeSafeMode("yolo");
		expect(harness.service.handleHubRequest(hubRequest(httpRequest("POST"), { id: "req-3" }))).toBe(true);
		expect(lastReply(harness).results[0]?.action).toBe("block");

		harness.service.setConfigured("allow-all");
		expect(harness.service.handleHubRequest(hubRequest(httpRequest("POST"), { id: "req-4" }))).toBe(true);
		expect(lastReply(harness).results[0]?.action).toBe("allow");
	});

	test("malformed requests block and are never turned into approval prompts", () => {
		const harness = createHarness();
		harness.service.setConfigured("allow-all");

		const malformed: unknown[] = [
			undefined,
			null,
			{},
			"http",
			{ toolName: "curl", operation: "request", url: "https://example.com" },
			{ toolName: "http", operation: "request" },
			{ toolName: "http", operation: "request", url: "ftp://example.com" },
			{ toolName: "http", operation: "request", url: "https://user:pass@example.com" },
			{ toolName: "http", operation: "request", url: "https://example.com", method: "GE T" },
			{ toolName: "web_search", operation: "request", query: "pi" },
		];

		for (const data of malformed) {
			expect(harness.service.handleHubRequest(hubRequest(data))).toBe(true);
			const reply = lastReply(harness);
			expect(reply.results[0]?.action).toBe("block");
			expect(reply.results[0]?.reason).toBeDefined();
			expect(reply.results[0]?.summary).toBeUndefined();
		}
	});

	test("ignores requests that are not targeted at permissions-core", () => {
		const harness = createHarness();
		harness.service.observeSafeMode("yolo");

		expect(harness.service.handleHubRequest(hubRequest(httpRequest("GET"), { targets: ["safe-mode"] }))).toBe(false);
		expect(harness.replies().length).toBe(0);

		expect(
			harness.service.handleHubRequest(
				hubRequest({}, { cap: [{ what: "perm:tool", data: {} }] }),
			),
		).toBe(false);
		expect(harness.replies().length).toBe(0);
	});

	test("ignores malformed envelopes without throwing", () => {
		const harness = createHarness();
		for (const payload of [undefined, null, 42, "x", [], {}, { id: 7 }, { id: "x", cap: "nope" }]) {
			expect(harness.service.handleHubRequest(payload)).toBe(false);
		}
		expect(harness.replies().length).toBe(0);
	});

	test("provider never asks the hub itself (no recursive deadlock)", () => {
		const harness = createHarness();
		harness.service.observeSafeMode("smart");
		harness.service.handleHubRequest(hubRequest(httpRequest("POST")));
		harness.service.handleHubRequest(hubRequest(httpRequest("GET"), { id: "req-2" }));
		expect(harness.emitted.some((event) => event.channel === HUB_ASK_EVENT)).toBe(false);
	});
});

describe("permissions-core network state", () => {
	test("state request returns the current validated state", () => {
		const harness = createHarness();
		harness.service.observeSafeMode("smart");
		expect(harness.service.handleStateRequest({ id: "state-1" })).toBe(true);
		expect(harness.responses()[0]).toEqual({
			channel: NETWORK_STATE_EVENTS.response,
			payload: {
				id: "state-1",
				state: { configured: "auto", effective: "ask-untrusted", overriddenByParanoid: false },
			},
		});

		expect(harness.service.handleStateRequest({ id: "" })).toBe(false);
		expect(harness.responses().length).toBe(1);
	});

	test("valid state sets update, persist, and emit a changed event", () => {
		const harness = createHarness();
		harness.service.observeSafeMode("smart");
		harness.clearEmitted();
		expect(harness.service.handleStateSet({ setting: "allow-all", source: "permissions-ui" })).toBe(true);

		expect(harness.service.getState()).toEqual({
			configured: "allow-all",
			effective: "allow-all",
			overriddenByParanoid: false,
		});
		expect(harness.entries).toEqual([
			{ customType: PERMISSIONS_CORE_ENTRY_TYPE, data: { configured: "allow-all" } },
		]);
		expect(harness.changed().length).toBe(1);
		expect(harness.changed()[0]?.payload).toEqual({
			configured: "allow-all",
			effective: "allow-all",
			overriddenByParanoid: false,
			source: "permissions-ui",
		});
	});

	test("invalid state sets are ignored without changing or persisting state", () => {
		const harness = createHarness();
		harness.service.observeSafeMode("smart");
		const before = harness.service.getState();
		harness.clearEmitted();

		for (const payload of [undefined, null, {}, { setting: "bogus" }, { setting: 42 }, { setting: "ask-all", source: 5 }]) {
			expect(harness.service.handleStateSet(payload)).toBe(false);
		}

		expect(harness.service.getState()).toEqual(before);
		expect(harness.entries.length).toBe(0);
		expect(harness.changed().length).toBe(0);
	});

	test("no-op sets do not persist or emit", () => {
		const harness = createHarness();
		harness.service.observeSafeMode("smart");
		harness.clearEmitted();
		expect(harness.service.handleStateSet({ setting: "auto" })).toBe(false);
		expect(harness.entries.length).toBe(0);
		expect(harness.changed().length).toBe(0);
	});

	test("safe-mode transitions recompute Auto and PARANOID overrides", () => {
		const harness = createHarness();
		harness.service.observeSafeMode("smart");
		expect(harness.service.getState().effective).toBe("ask-untrusted");

		harness.service.observeSafeMode("paranoid");
		expect(harness.service.getState()).toEqual({
			configured: "auto",
			effective: "ask-all",
			overriddenByParanoid: true,
		});

		// Saving an explicit policy under PARANOID persists it but stays overridden.
		expect(harness.service.handleStateSet({ setting: "allow-all" })).toBe(true);
		expect(harness.service.getState()).toEqual({
			configured: "allow-all",
			effective: "ask-all",
			overriddenByParanoid: true,
		});
		expect(harness.entries).toEqual([
			{ customType: PERMISSIONS_CORE_ENTRY_TYPE, data: { configured: "allow-all" } },
		]);

		// Leaving PARANOID restores the retained explicit choice.
		harness.service.observeSafeMode("smart");
		expect(harness.service.getState()).toEqual({
			configured: "allow-all",
			effective: "allow-all",
			overriddenByParanoid: false,
		});
	});

	test("unknown safe modes fail closed to ask-all", () => {
		const harness = createHarness();
		harness.service.observeSafeMode("yolo");
		harness.service.observeSafeMode("YOLO+");
		expect(harness.service.getState()).toEqual({
			configured: "auto",
			effective: "ask-all",
			overriddenByParanoid: true,
		});
	});

	test("session reset returns to Auto and resume restores the explicit choice", () => {
		const harness = createHarness();
		harness.service.restore({ present: true, configured: "allow-trusted" });
		harness.service.observeSafeMode("smart");
		expect(harness.service.getState()).toEqual({
			configured: "allow-trusted",
			effective: "allow-trusted",
			overriddenByParanoid: false,
		});

		// New session: no persisted entry means Auto.
		harness.service.resetSession();
		harness.service.restore({ present: false });
		harness.service.observeSafeMode("smart");
		expect(harness.service.getState()).toEqual({
			configured: "auto",
			effective: "ask-untrusted",
			overriddenByParanoid: false,
		});
	});

	test("session reset emits a validated changed event when it changes state", () => {
		const harness = createHarness();
		harness.service.observeSafeMode("smart");
		harness.service.handleStateSet({ setting: "allow-all", source: "test" });
		harness.clearEmitted();

		harness.service.resetSession();

		expect(harness.service.getState()).toEqual({
			configured: "auto",
			effective: "ask-all",
			overriddenByParanoid: true,
		});
		expect(harness.changed().length).toBe(1);
		expect(harness.changed()[0]?.payload).toEqual({
			configured: "auto",
			effective: "ask-all",
			overriddenByParanoid: true,
			source: "session-reset",
		});
	});

	test("session reset stays silent when the state is already the reset state", () => {
		const harness = createHarness();
		harness.service.observeSafeMode(undefined);
		harness.clearEmitted();

		harness.service.resetSession();

		expect(harness.changed().length).toBe(0);
	});

	test("corrupt persisted state fails closed instead of reverting to Auto", () => {
		const harness = createHarness();
		harness.service.restore({ present: true, configured: "bogus" });
		harness.service.observeSafeMode("yolo");
		expect(harness.service.getState()).toEqual({
			configured: "ask-all",
			effective: "ask-all",
			overriddenByParanoid: false,
		});
	});
});
