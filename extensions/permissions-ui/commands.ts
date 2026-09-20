// `/px:net` command flow.
//
// The flow is split from the pi wiring so it can be tested with fakes. It reads
// the current state, lets the user pick a setting, and applies the change only
// through the permissions-core `set` event. Every failure path notifies the
// user and makes no change.

import { settingFromSelection, settingLabel } from "./options";
import type { NetworkPermissionState, NetworkPolicySetting } from "./contract";

export type NetworkNotifyType = "info" | "warning" | "error";

export type NetworkNotify = (message: string, type: NetworkNotifyType) => void;

export interface NetworkCommandDeps {
	queryState(): Promise<NetworkPermissionState | undefined>;
	selectSetting(state: NetworkPermissionState): Promise<NetworkPolicySetting | null>;
	setSetting(setting: NetworkPolicySetting): Promise<boolean>;
	notify: NetworkNotify;
}

export async function runNetworkCommand(deps: NetworkCommandDeps): Promise<void> {
	const state = await deps.queryState();
	if (!state) {
		deps.notify("permissions-core is unavailable; network policy cannot be changed.", "warning");
		return;
	}

	const selection = await deps.selectSetting(state);
	if (selection === null) return;

	const setting = settingFromSelection(selection);
	if (!setting) {
		deps.notify("Invalid network policy selection; no change was made.", "error");
		return;
	}

	if (setting === state.configured) {
		deps.notify(`Network policy already ${settingLabel(setting)}.`, "info");
		return;
	}

	const accepted = await deps.setSetting(setting);
	if (!accepted) {
		deps.notify("Network policy update was not accepted; permissions-core may be unavailable.", "warning");
		return;
	}

	const suffix = state.overriddenByParanoid ? " (PARANOID still forces NET?)" : "";
	deps.notify(`Network policy: ${settingLabel(setting)}${suffix}`, "info");
}
