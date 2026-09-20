import { describe, expect, test } from "bun:test";
import {
	parseNetworkPermissionState,
	parseNetworkPolicySetting,
	parseNetworkStateChanged,
	parseNetworkStateResponse,
	parseNetworkStateSet,
} from "./contract.ts";

describe("permissions-ui contract mirror", () => {
	test("accepts valid settings and rejects malformed ones", () => {
		for (const setting of ["auto", "deny-all", "ask-all", "allow-trusted", "ask-untrusted", "allow-all"]) {
			expect(parseNetworkPolicySetting(setting)).toBe(setting);
		}
		for (const value of [undefined, null, 1, "", "allow", "AUTO", {}]) {
			expect(parseNetworkPolicySetting(value)).toBeUndefined();
		}
	});

	test("accepts consistent states", () => {
		expect(
			parseNetworkPermissionState({
				configured: "auto",
				effective: "allow-trusted",
				autoEffective: "allow-trusted",
				overriddenByParanoid: false,
			}),
		).toEqual({ configured: "auto", effective: "allow-trusted", autoEffective: "allow-trusted", overriddenByParanoid: false });
		expect(
			parseNetworkPermissionState({
				configured: "allow-all",
				effective: "allow-all",
				autoEffective: "ask-untrusted",
				overriddenByParanoid: false,
			}),
		).toEqual({ configured: "allow-all", effective: "allow-all", autoEffective: "ask-untrusted", overriddenByParanoid: false });
		expect(
			parseNetworkPermissionState({
				configured: "allow-all",
				effective: "ask-all",
				autoEffective: "ask-all",
				overriddenByParanoid: true,
			}),
		).toEqual({ configured: "allow-all", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: true });
	});

	test("rejects inconsistent states", () => {
		// Explicit choices must be effective verbatim without PARANOID.
		expect(
			parseNetworkPermissionState({
				configured: "allow-all",
				effective: "ask-all",
				autoEffective: "ask-untrusted",
				overriddenByParanoid: false,
			}),
		).toBeUndefined();
		// PARANOID must force ask-all.
		expect(
			parseNetworkPermissionState({
				configured: "allow-all",
				effective: "allow-all",
				autoEffective: "allow-all",
				overriddenByParanoid: true,
			}),
		).toBeUndefined();
		// Auto cannot derive an arbitrary policy such as deny-all.
		expect(
			parseNetworkPermissionState({
				configured: "auto",
				effective: "deny-all",
				autoEffective: "deny-all",
				overriddenByParanoid: false,
			}),
		).toBeUndefined();
		// Auto's effective policy must match its derived policy.
		expect(
			parseNetworkPermissionState({
				configured: "auto",
				effective: "ask-untrusted",
				autoEffective: "allow-trusted",
				overriddenByParanoid: false,
			}),
		).toBeUndefined();
		// A missing autoEffective is rejected.
		expect(
			parseNetworkPermissionState({ configured: "auto", effective: "ask-untrusted", overriddenByParanoid: false }),
		).toBeUndefined();
		for (const value of [undefined, null, 7, "state", [], {}]) {
			expect(parseNetworkPermissionState(value)).toBeUndefined();
		}
	});

	test("parses state responses with bounded ids and drops malformed payloads", () => {
		expect(
			parseNetworkStateResponse({
				id: "request-1",
				state: { configured: "auto", effective: "ask-untrusted", autoEffective: "ask-untrusted", overriddenByParanoid: false },
			}),
		).toEqual({
			id: "request-1",
			state: { configured: "auto", effective: "ask-untrusted", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		});
		expect(parseNetworkStateResponse({ id: "", state: {} })).toBeUndefined();
		expect(parseNetworkStateResponse({ id: "x".repeat(257), state: {} })).toBeUndefined();
		expect(parseNetworkStateResponse({ id: "request-1", state: {} })).toBeUndefined();
	});

	test("parses changed payloads with an optional bounded source", () => {
		expect(
			parseNetworkStateChanged({
				configured: "allow-all",
				effective: "ask-all",
				autoEffective: "ask-all",
				overriddenByParanoid: true,
				source: "permissions-ui",
			}),
		).toEqual({
			configured: "allow-all",
			effective: "ask-all",
			autoEffective: "ask-all",
			overriddenByParanoid: true,
			source: "permissions-ui",
		});
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
		expect(
			parseNetworkStateChanged({
				configured: "auto",
				effective: "ask-untrusted",
				autoEffective: "ask-untrusted",
				overriddenByParanoid: false,
				source: "",
			}),
		).toBeUndefined();
		expect(parseNetworkStateChanged({ configured: "auto" })).toBeUndefined();
	});

	test("parses set payloads and rejects invalid ones", () => {
		expect(parseNetworkStateSet({ setting: "allow-all" })).toEqual({ setting: "allow-all" });
		expect(parseNetworkStateSet({ setting: "auto", source: "permissions-ui" })).toEqual({
			setting: "auto",
			source: "permissions-ui",
		});
		for (const value of [undefined, null, {}, { setting: "bogus" }, { setting: "auto", source: "" }]) {
			expect(parseNetworkStateSet(value)).toBeUndefined();
		}
	});
});
