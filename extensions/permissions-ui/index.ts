// permissions-ui: `/px:net` network policy selector.
//
// Reads and changes state only through the validated permissions-core event
// contract. When the core is unavailable or rejects an update, the command
// notifies the user and makes no local change.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NetworkPolicySetting } from "./contract";
import { applyNetworkSetting } from "./apply";
import { runNetworkCommand } from "./commands";
import { queryNetworkState } from "./query";
import { showNetworkPolicyPicker } from "./ui";

const SET_SOURCE = "permissions-ui";

export default function permissionsUiExtension(pi: ExtensionAPI): void {
	const queryState = () => queryNetworkState(pi.events);

	/**
	 * Emit a `set` through the contract and resolve once the core confirms a
	 * matching `changed`. On timeout, re-query the current state and accept the
	 * request when the configured setting already equals it (the no-op race).
	 * Resolves `false` only when the update cannot be confirmed at all.
	 */
	const setSetting = (setting: NetworkPolicySetting): Promise<boolean> =>
		applyNetworkSetting(pi.events, setting, SET_SOURCE, { queryState });

	pi.registerCommand("px:net", {
		description: "Choose the session network permission policy",
		handler: async (_args, ctx) => {
			const notify = (message: string, type: "info" | "warning" | "error" = "info"): void => {
				if (ctx.hasUI) ctx.ui.notify(message, type);
			};

			await runNetworkCommand({
				queryState,
				selectSetting: (state) => showNetworkPolicyPicker(ctx, { state }),
				setSetting,
				notify,
			});
		},
	});
}
