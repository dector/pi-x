import { describe, expect, test } from "bun:test";
import { runNetworkCommand, type NetworkCommandDeps, type NetworkNotifyType } from "./commands.ts";
import type { NetworkPermissionState, NetworkPolicySetting } from "./contract.ts";

function state(overrides: Partial<NetworkPermissionState> = {}): NetworkPermissionState {
	return { configured: "auto", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: false, ...overrides };
}

function harness(config: {
	state?: NetworkPermissionState | undefined;
	selection?: NetworkPolicySetting | null;
	accepted?: boolean;
}) {
	const notifications: Array<{ message: string; type: NetworkNotifyType }> = [];
	const setCalls: NetworkPolicySetting[] = [];
	const deps: NetworkCommandDeps = {
		queryState: async () => config.state,
		selectSetting: async () => config.selection ?? null,
		setSetting: async (setting) => {
			setCalls.push(setting);
			return config.accepted ?? true;
		},
		notify: (message, type) => notifications.push({ message, type }),
	};
	return { deps, notifications, setCalls };
}

describe("runNetworkCommand", () => {
	test("notifies and stops when the core is unavailable", async () => {
		const { deps, notifications, setCalls } = harness({ state: undefined });
		await runNetworkCommand(deps);
		expect(notifications).toEqual([
			{ message: "permissions-core is unavailable; network policy cannot be changed.", type: "warning" },
		]);
		expect(setCalls).toEqual([]);
	});

	test("does nothing when the selector is cancelled", async () => {
		const { deps, notifications, setCalls } = harness({ state: state(), selection: null });
		await runNetworkCommand(deps);
		expect(notifications).toEqual([]);
		expect(setCalls).toEqual([]);
	});

	test("notifies on an invalid selection without changing state", async () => {
		const { deps, notifications, setCalls } = harness({ state: state(), selection: "bogus" as NetworkPolicySetting });
		await runNetworkCommand(deps);
		expect(notifications).toEqual([
			{ message: "Invalid network policy selection; no change was made.", type: "error" },
		]);
		expect(setCalls).toEqual([]);
	});

	test("reports already-set without emitting a change", async () => {
		const { deps, notifications, setCalls } = harness({
			state: state({ configured: "ask-untrusted", effective: "ask-untrusted" }),
			selection: "ask-untrusted",
		});
		await runNetworkCommand(deps);
		expect(notifications).toEqual([{ message: "Network policy already Ask if untrusted.", type: "info" }]);
		expect(setCalls).toEqual([]);
	});

	test("applies an accepted change through setSetting and notifies", async () => {
		const { deps, notifications, setCalls } = harness({
			state: state({ configured: "auto", effective: "allow-trusted" }),
			selection: "allow-all",
		});
		await runNetworkCommand(deps);
		expect(setCalls).toEqual(["allow-all"]);
		expect(notifications).toEqual([{ message: "Network policy: Allow all", type: "info" }]);
	});

	test("notifies when the update is not accepted", async () => {
		const { deps, notifications, setCalls } = harness({
			state: state(),
			selection: "deny-all",
			accepted: false,
		});
		await runNetworkCommand(deps);
		expect(setCalls).toEqual(["deny-all"]);
		expect(notifications).toEqual([
			{
				message: "Network policy update was not accepted; permissions-core may be unavailable.",
				type: "warning",
			},
		]);
	});

	test("explains the PARANOID override in the success notification", async () => {
		const { deps, notifications } = harness({
			state: state({ configured: "auto", effective: "ask-all", overriddenByParanoid: true }),
			selection: "allow-all",
		});
		await runNetworkCommand(deps);
		expect(notifications).toEqual([
			{ message: "Network policy: Allow all (PARANOID still forces NET?)", type: "info" },
		]);
	});
});
