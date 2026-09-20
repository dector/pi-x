import { describe, expect, test } from "bun:test";
import {
	createNetworkStateChanged,
	parseNetworkStateChanged,
	parseNetworkStateRequest,
	parseNetworkStateResponse,
	parseNetworkStateSet,
} from "./contract.ts";

describe("permissions-core network state contract", () => {
	test("accepts valid messages", () => {
		expect(parseNetworkStateRequest({ id: "request-1" })).toEqual({ id: "request-1" });
		expect(parseNetworkStateSet({ setting: "allow-all" })).toEqual({ setting: "allow-all" });
		expect(parseNetworkStateSet({ setting: "auto", source: "permissions-ui" })).toEqual({
			setting: "auto",
			source: "permissions-ui",
		});
		expect(
			parseNetworkStateResponse({
				id: "request-1",
				state: { configured: "auto", effective: "ask-untrusted", autoEffective: "ask-untrusted", overriddenByParanoid: false },
			}),
		).toEqual({
			id: "request-1",
			state: { configured: "auto", effective: "ask-untrusted", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		});
	});

	test("rejects malformed messages", () => {
		for (const value of [undefined, null, 42, "request", [], {}]) {
			expect(parseNetworkStateRequest(value)).toBeUndefined();
		}
		expect(parseNetworkStateRequest({ id: "" })).toBeUndefined();
		expect(parseNetworkStateRequest({ id: "x".repeat(257) })).toBeUndefined();

		for (const value of [undefined, null, {}, { setting: "bogus" }, { setting: 7 }]) {
			expect(parseNetworkStateSet(value)).toBeUndefined();
		}
		expect(parseNetworkStateSet({ setting: "ask-all", source: 7 })).toBeUndefined();
		expect(parseNetworkStateSet({ setting: "ask-all", source: "" })).toBeUndefined();

		expect(parseNetworkStateResponse({ id: "r", state: { configured: "auto" } })).toBeUndefined();
		expect(
			parseNetworkStateResponse({
				id: "r",
				state: { configured: "allow-all", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: false },
			}),
		).toBeUndefined();
		expect(
			parseNetworkStateResponse({
				id: "r",
				state: { configured: "allow-all", effective: "allow-all", autoEffective: "allow-all", overriddenByParanoid: false },
			}),
		).toBeUndefined();
	});

	test("createNetworkStateChanged flattens validated state with an optional source", () => {
		expect(
			createNetworkStateChanged(
				{ configured: "auto", effective: "allow-trusted", autoEffective: "allow-trusted", overriddenByParanoid: false },
				"safe-mode",
			),
		).toEqual({
			configured: "auto",
			effective: "allow-trusted",
			autoEffective: "allow-trusted",
			overriddenByParanoid: false,
			source: "safe-mode",
		});
	});

	test("parseNetworkStateChanged round-trips changed payloads and rejects malformed ones", () => {
		const changed = createNetworkStateChanged(
			{ configured: "allow-all", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: true },
			"session-reset",
		);
		expect(parseNetworkStateChanged(changed)).toEqual(changed);
		expect(
			parseNetworkStateChanged({
				configured: "auto",
				effective: "ask-untrusted",
				autoEffective: "ask-untrusted",
				overriddenByParanoid: false,
			}),
		).toEqual({
			configured: "auto",
			effective: "ask-untrusted",
			autoEffective: "ask-untrusted",
			overriddenByParanoid: false,
			source: undefined,
		});

		for (const value of [undefined, null, 42, "x", [], {}]) {
			expect(parseNetworkStateChanged(value)).toBeUndefined();
		}
		// Inconsistent state and invalid sources are rejected.
		expect(
			parseNetworkStateChanged({
				configured: "allow-all",
				effective: "ask-all",
				autoEffective: "ask-all",
				overriddenByParanoid: false,
			}),
		).toBeUndefined();
		expect(
			parseNetworkStateChanged({
				configured: "auto",
				effective: "ask-untrusted",
				autoEffective: "ask-untrusted",
				overriddenByParanoid: false,
				source: "",
			}),
		).toBeUndefined();
		expect(
			parseNetworkStateChanged({
				configured: "auto",
				effective: "ask-untrusted",
				autoEffective: "ask-untrusted",
				overriddenByParanoid: false,
				source: "x".repeat(129),
			}),
		).toBeUndefined();
	});
});
