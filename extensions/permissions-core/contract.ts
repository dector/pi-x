// Validated event contract for permissions-core network state.
//
// Consumers (permissions-ui in Stage 4, status-bar in Stage 5) read and change
// state exclusively through these channels. Malformed payloads are dropped by
// the parser helpers, never applied.

import {
	parseNetworkPermissionState,
	parseNetworkPolicySetting,
	type NetworkPermissionState,
	type NetworkPolicySetting,
} from "./policy";

export const NETWORK_STATE_EVENTS = {
	request: "px:permissions-core:net:state:request",
	response: "px:permissions-core:net:state:response",
	set: "px:permissions-core:net:state:set",
	changed: "px:permissions-core:net:state:changed",
} as const;

export interface NetworkStateRequest {
	id: string;
}

export interface NetworkStateResponse {
	id: string;
	state: NetworkPermissionState;
}

export interface NetworkStateSet {
	setting: NetworkPolicySetting;
	source?: string;
}

export interface NetworkStateChanged extends NetworkPermissionState {
	source?: string;
}

const MAX_ID_LENGTH = 256;
const MAX_SOURCE_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export function parseNetworkStateRequest(value: unknown): NetworkStateRequest | undefined {
	if (!isRecord(value) || !isBoundedString(value.id, MAX_ID_LENGTH)) return undefined;
	return { id: value.id };
}

export function parseNetworkStateResponse(value: unknown): NetworkStateResponse | undefined {
	if (!isRecord(value) || !isBoundedString(value.id, MAX_ID_LENGTH)) return undefined;
	const state = parseNetworkPermissionState(value.state);
	return state ? { id: value.id, state } : undefined;
}

export function parseNetworkStateSet(value: unknown): NetworkStateSet | undefined {
	if (!isRecord(value)) return undefined;
	const setting = parseNetworkPolicySetting(value.setting);
	if (!setting) return undefined;
	if (value.source !== undefined && !isBoundedString(value.source, MAX_SOURCE_LENGTH)) return undefined;
	return { setting, source: value.source as string | undefined };
}

export function parseNetworkStateChanged(value: unknown): NetworkStateChanged | undefined {
	if (!isRecord(value)) return undefined;
	const state = parseNetworkPermissionState(value);
	if (!state) return undefined;
	if (value.source !== undefined && !isBoundedString(value.source, MAX_SOURCE_LENGTH)) return undefined;
	return { ...state, source: value.source as string | undefined };
}

export function createNetworkStateChanged(
	state: NetworkPermissionState,
	source?: string,
): NetworkStateChanged {
	return {
		configured: state.configured,
		effective: state.effective,
		overriddenByParanoid: state.overriddenByParanoid,
		source,
	};
}
