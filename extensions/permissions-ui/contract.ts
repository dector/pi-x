// Mirror of the permissions-core network state contract.
//
// ui must not import across extension directories (the same convention
// permissions-core follows for safe-mode). The event names and payload shapes
// are duplicated here so `/px:net` can only read and change state through the
// validated contract. Malformed payloads are dropped by the parsers, never
// applied.

export const NETWORK_STATE_EVENTS = {
	request: "px:permissions-core:net:state:request",
	response: "px:permissions-core:net:state:response",
	set: "px:permissions-core:net:state:set",
	changed: "px:permissions-core:net:state:changed",
} as const;

export const NETWORK_POLICIES = [
	"deny-all",
	"ask-all",
	"allow-trusted",
	"ask-untrusted",
	"allow-all",
] as const;

export type NetworkPolicy = (typeof NETWORK_POLICIES)[number];

export const NETWORK_POLICY_SETTINGS = ["auto", ...NETWORK_POLICIES] as const;

export type NetworkPolicySetting = (typeof NETWORK_POLICY_SETTINGS)[number];

export interface NetworkPermissionState {
	configured: NetworkPolicySetting;
	effective: NetworkPolicy;
	// Safe-mode-derived Auto policy, independent of `configured`. Under
	// PARANOID (or an unknown safe mode) it is always `ask-all`.
	autoEffective: NetworkPolicy;
	overriddenByParanoid: boolean;
}

// Auto derivation can only produce these policies (paranoid/reader -> ask-all,
// smart -> ask-untrusted, yolo -> allow-trusted).
const AUTO_DERIVABLE_POLICIES: ReadonlySet<NetworkPolicy> = new Set([
	"ask-all",
	"ask-untrusted",
	"allow-trusted",
]);

const MAX_ID_LENGTH = 256;
const MAX_SOURCE_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
	return typeof value === "string" && (options as readonly string[]).includes(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export function parseNetworkPolicy(value: unknown): NetworkPolicy | undefined {
	return isOneOf(value, NETWORK_POLICIES) ? value : undefined;
}

export function parseNetworkPolicySetting(value: unknown): NetworkPolicySetting | undefined {
	return isOneOf(value, NETWORK_POLICY_SETTINGS) ? value : undefined;
}

/**
 * Validate a full network permission state. Rejects inconsistent combinations
 * so the UI never renders a state the core could not have produced.
 */
export function parseNetworkPermissionState(value: unknown): NetworkPermissionState | undefined {
	if (!isRecord(value)) return undefined;

	const configured = parseNetworkPolicySetting(value.configured);
	const effective = parseNetworkPolicy(value.effective);
	const autoEffective = parseNetworkPolicy(value.autoEffective);
	if (!configured || !effective || !autoEffective || typeof value.overriddenByParanoid !== "boolean") {
		return undefined;
	}

	// Auto can only derive the policies reachable from canonical safe modes.
	if (!AUTO_DERIVABLE_POLICIES.has(autoEffective)) return undefined;

	if (value.overriddenByParanoid) {
		if (effective !== "ask-all" || autoEffective !== "ask-all") return undefined;
	} else if (configured === "auto") {
		if (effective !== autoEffective) return undefined;
	} else if (effective !== configured) {
		return undefined;
	}

	return { configured, effective, autoEffective, overriddenByParanoid: value.overriddenByParanoid };
}

export interface NetworkStateResponse {
	id: string;
	state: NetworkPermissionState;
}

export function parseNetworkStateResponse(value: unknown): NetworkStateResponse | undefined {
	if (!isRecord(value) || !isBoundedString(value.id, MAX_ID_LENGTH)) return undefined;
	const state = parseNetworkPermissionState(value.state);
	return state ? { id: value.id, state } : undefined;
}

export interface NetworkStateChanged extends NetworkPermissionState {
	source?: string;
}

export function parseNetworkStateChanged(value: unknown): NetworkStateChanged | undefined {
	if (!isRecord(value)) return undefined;
	const state = parseNetworkPermissionState(value);
	if (!state) return undefined;
	if (value.source !== undefined && !isBoundedString(value.source, MAX_SOURCE_LENGTH)) return undefined;
	return { ...state, source: value.source as string | undefined };
}

export interface NetworkStateSet {
	setting: NetworkPolicySetting;
	source?: string;
}

export function parseNetworkStateSet(value: unknown): NetworkStateSet | undefined {
	if (!isRecord(value)) return undefined;
	const setting = parseNetworkPolicySetting(value.setting);
	if (!setting) return undefined;
	if (value.source !== undefined && !isBoundedString(value.source, MAX_SOURCE_LENGTH)) return undefined;
	return { setting, source: value.source as string | undefined };
}
