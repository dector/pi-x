import { describe, expect, test } from "bun:test";
import {
	POLICY_COLORS,
	POLICY_LABELS,
	POLICY_TOKENS,
	buildNetworkPolicyOptions,
	buildParanoidNotice,
	colorForPolicy,
	settingFromSelection,
	tokenForPolicy,
} from "./options.ts";
import type { NetworkPermissionState, NetworkPolicy } from "./contract.ts";

const ALL_POLICIES: NetworkPolicy[] = [
	"deny-all",
	"ask-all",
	"allow-trusted",
	"ask-untrusted",
	"allow-all",
];

function state(overrides: Partial<NetworkPermissionState> = {}): NetworkPermissionState {
	return { configured: "auto", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: false, ...overrides };
}

describe("permissions-ui option tokens and colors", () => {
	test("maps every policy to the documented token", () => {
		expect(POLICY_TOKENS).toEqual({
			"deny-all": "NET",
			"ask-all": "NET?",
			"allow-trusted": "NET",
			"ask-untrusted": "NET?",
			"allow-all": "NET+",
		});
	});

	test("maps every policy to the documented color", () => {
		expect(POLICY_COLORS).toEqual({
			"deny-all": "muted",
			"ask-all": "muted",
			"allow-trusted": "text",
			"ask-untrusted": "text",
			"allow-all": "text",
		});
	});

	test("tokenForPolicy/colorForPolicy cover all five policies", () => {
		for (const policy of ALL_POLICIES) {
			expect(tokenForPolicy(policy)).toBe(POLICY_TOKENS[policy]);
			expect(colorForPolicy(policy)).toBe(POLICY_COLORS[policy]);
			expect(POLICY_LABELS[policy]).toBeTruthy();
		}
	});
});

describe("buildNetworkPolicyOptions", () => {
	test("builds Auto plus the five policies in stable order", () => {
		const options = buildNetworkPolicyOptions(state());
		expect(options.map((option) => option.setting)).toEqual([
			"auto",
			"deny-all",
			"ask-all",
			"allow-trusted",
			"ask-untrusted",
			"allow-all",
		]);
		expect(options.map((option) => option.label)).toEqual([
			"Auto",
			"Deny all",
			"Ask for all",
			"Allow trusted",
			"Ask if untrusted",
			"Allow all",
		]);
	});

	test("Auto shows the derived autoEffective token and color", () => {
		for (const policy of ALL_POLICIES) {
			const options = buildNetworkPolicyOptions(state({ configured: "auto", effective: policy, autoEffective: policy }));
			const auto = options.find((option) => option.setting === "auto")!;
			expect(auto.token).toBe(POLICY_TOKENS[policy]);
			expect(auto.color).toBe(POLICY_COLORS[policy]);
		}
	});

	test("Auto shows autoEffective even when an explicit policy is configured", () => {
		// SMART derives ask-untrusted, so Auto must show NET? even though the
		// configured explicit choice (allow-all) makes effective NET+.
		const options = buildNetworkPolicyOptions(
			state({ configured: "allow-all", effective: "allow-all", autoEffective: "ask-untrusted" }),
		);
		const auto = options.find((option) => option.setting === "auto")!;
		expect(auto).toMatchObject({
			token: "NET?",
			color: "text",
			description: "Follow safe mode (Ask if untrusted)",
			isCurrent: false,
		});
		expect(options.find((option) => option.setting === "allow-all")).toMatchObject({
			token: "NET+",
			color: "text",
			isCurrent: true,
		});
	});

	test("explicit rows show their own token and color regardless of effective state", () => {
		const options = buildNetworkPolicyOptions(state({ configured: "allow-all", effective: "ask-all" }));
		expect(options.find((option) => option.setting === "deny-all")).toMatchObject({
			token: "NET",
			color: "muted",
		});
		expect(options.find((option) => option.setting === "ask-all")).toMatchObject({
			token: "NET?",
			color: "muted",
		});
		expect(options.find((option) => option.setting === "allow-trusted")).toMatchObject({
			token: "NET",
			color: "text",
		});
		expect(options.find((option) => option.setting === "ask-untrusted")).toMatchObject({
			token: "NET?",
			color: "text",
		});
		expect(options.find((option) => option.setting === "allow-all")).toMatchObject({
			token: "NET+",
			color: "text",
		});
	});

	test("isCurrent marks the configured setting only", () => {
		const auto = buildNetworkPolicyOptions(state({ configured: "auto" }));
		expect(auto.filter((option) => option.isCurrent).map((option) => option.setting)).toEqual(["auto"]);

		const explicit = buildNetworkPolicyOptions(state({ configured: "ask-untrusted", effective: "ask-untrusted" }));
		expect(explicit.filter((option) => option.isCurrent).map((option) => option.setting)).toEqual(["ask-untrusted"]);

		// Under PARANOID the effective policy is ask-all, but the saved choice is
		// still highlighted so the user can see what will resume.
		const paranoid = buildNetworkPolicyOptions(
			state({ configured: "allow-all", effective: "ask-all", overriddenByParanoid: true }),
		);
		expect(paranoid.filter((option) => option.isCurrent).map((option) => option.setting)).toEqual(["allow-all"]);
	});
});

describe("settingFromSelection", () => {
	test("accepts every valid setting", () => {
		expect(settingFromSelection("auto")).toBe("auto");
		for (const policy of ALL_POLICIES) {
			expect(settingFromSelection(policy)).toBe(policy);
		}
	});

	test("rejects unknown or malformed selections", () => {
		for (const value of [undefined, null, 42, "", "allow", "ALLOW-ALL", "auto ", []]) {
			expect(settingFromSelection(value)).toBeUndefined();
		}
	});
});

describe("buildParanoidNotice", () => {
	test("returns undefined when PARANOID is not forcing the policy", () => {
		expect(buildParanoidNotice(state({ overriddenByParanoid: false }))).toBeUndefined();
	});

	test("reports the forced policy and an explicit saved choice", () => {
		expect(
			buildParanoidNotice(
				state({ configured: "allow-all", effective: "ask-all", overriddenByParanoid: true }),
			),
		).toEqual(["PARANOID currently forces: NET? (Ask for all)", "Your saved network policy: NET+ (Allow all)"]);
	});

	test("reports Auto when the saved choice is auto", () => {
		expect(
			buildParanoidNotice(state({ configured: "auto", effective: "ask-all", overriddenByParanoid: true })),
		).toEqual(["PARANOID currently forces: NET? (Ask for all)", "Your saved network policy: Auto"]);
	});
});
