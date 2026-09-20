// Pure option construction for the `/px:net` selector.
//
// This module has no UI or event dependencies. It maps the validated network
// state to selector rows (label, effective token, color, description) and maps
// a selected row back to a `NetworkPolicySetting`. `ui.ts` renders these rows
// and `commands.ts` applies the mapped setting through the core contract.

import {
	NETWORK_POLICY_SETTINGS,
	parseNetworkPolicySetting,
	type NetworkPermissionState,
	type NetworkPolicy,
	type NetworkPolicySetting,
} from "./contract";

export type NetworkStatusToken = "NET" | "NET?" | "NET+";

// Theme color names ("muted" = gray, "text" = normal/white). Kept as strings so
// this module stays free of the pi theme type and can be tested purely.
export type NetworkStatusColor = "muted" | "text";

export const POLICY_TOKENS: Record<NetworkPolicy, NetworkStatusToken> = {
	"deny-all": "NET",
	"ask-all": "NET?",
	"allow-trusted": "NET",
	"ask-untrusted": "NET?",
	"allow-all": "NET+",
};

export const POLICY_COLORS: Record<NetworkPolicy, NetworkStatusColor> = {
	"deny-all": "muted",
	"ask-all": "muted",
	"allow-trusted": "text",
	"ask-untrusted": "text",
	"allow-all": "text",
};

export const POLICY_LABELS: Record<NetworkPolicy, string> = {
	"deny-all": "Deny all",
	"ask-all": "Ask for all",
	"allow-trusted": "Allow trusted",
	"ask-untrusted": "Ask if untrusted",
	"allow-all": "Allow all",
};

export const POLICY_SUMMARIES: Record<NetworkPolicy, string> = {
	"deny-all": "Block every valid network request",
	"ask-all": "Ask before every valid network request",
	"allow-trusted": "Allow GET/HEAD/OPTIONS and search; block other methods",
	"ask-untrusted": "Allow read-only and search; ask for other methods",
	"allow-all": "Allow every valid network request",
};

export const AUTO_LABEL = "Auto";

export function tokenForPolicy(policy: NetworkPolicy): NetworkStatusToken {
	return POLICY_TOKENS[policy];
}

export function colorForPolicy(policy: NetworkPolicy): NetworkStatusColor {
	return POLICY_COLORS[policy];
}

export interface NetworkPolicyOption {
	setting: NetworkPolicySetting;
	label: string;
	token: NetworkStatusToken;
	color: NetworkStatusColor;
	description: string;
	isCurrent: boolean;
}

export function settingLabel(setting: NetworkPolicySetting): string {
	return setting === "auto" ? AUTO_LABEL : POLICY_LABELS[setting];
}

/**
 * Build the selector rows in stable order: Auto, then the five policies.
 *
 * Auto shows the inner effective token/color so the current Auto-derivation is
 * visible. Explicit rows show the token/color that policy always produces.
 */
export function buildNetworkPolicyOptions(state: NetworkPermissionState): NetworkPolicyOption[] {
	return NETWORK_POLICY_SETTINGS.map((setting) => {
		if (setting === "auto") {
			// The Auto row shows the safe-mode-derived policy, which is
			// independent of the configured explicit choice.
			return {
				setting,
				label: AUTO_LABEL,
				token: tokenForPolicy(state.autoEffective),
				color: colorForPolicy(state.autoEffective),
				description: `Follow safe mode (${POLICY_LABELS[state.autoEffective]})`,
				isCurrent: state.configured === "auto",
			};
		}
		return {
			setting,
			label: POLICY_LABELS[setting],
			token: tokenForPolicy(setting),
			color: colorForPolicy(setting),
			description: POLICY_SUMMARIES[setting],
			isCurrent: state.configured === setting,
		};
	});
}

/** Map a selector value back to a setting; rejects anything not in the contract. */
export function settingFromSelection(value: unknown): NetworkPolicySetting | undefined {
	return parseNetworkPolicySetting(value);
}

/**
 * PARANOID override notice, or `undefined` when PARANOID is not forcing the
 * effective policy. The forced token is always `NET?` (ask-all).
 */
export function buildParanoidNotice(state: NetworkPermissionState): string[] | undefined {
	if (!state.overriddenByParanoid) return undefined;

	const forcedToken = tokenForPolicy(state.effective);
	const lines = [`PARANOID currently forces: ${forcedToken} (${POLICY_LABELS[state.effective]})`];

	if (state.configured === "auto") {
		lines.push(`Your saved network policy: ${AUTO_LABEL}`);
	} else {
		const savedToken = tokenForPolicy(state.configured);
		lines.push(`Your saved network policy: ${savedToken} (${POLICY_LABELS[state.configured]})`);
	}

	return lines;
}
