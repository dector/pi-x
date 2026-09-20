// permissions-core network service: validated hub provider + state contract.
//
// Pure-ish wiring: all side effects go through injected `emit`/`appendEntry`.
// `index.ts` binds those to `pi.events` / `pi.appendEntry`. Keeping the logic
// here makes the request/response and state flows testable without the pi
// runtime, and guarantees the provider never emits a `hub:ask` of its own
// (which is what avoids recursive hub deadlock).

import {
	NETWORK_STATE_EVENTS,
	createNetworkStateChanged,
	parseNetworkStateRequest,
	parseNetworkStateSet,
} from "./contract";
import {
	evaluateNetworkPermission,
	parseNetworkPolicySetting,
	resolveNetworkPermissionState,
	type NetworkPermissionState,
	type NetworkPolicySetting,
} from "./policy";

export const PERMISSIONS_CORE_ID = "permissions-core";
export const PERMISSIONS_CORE_ENTRY_TYPE = "permissions-core-net";
export const PERM_NET = "perm:net";

export const HUB_REGISTER_EVENT = "hub:register";
export const HUB_UNREGISTER_EVENT = "hub:unregister";
export const HUB_REQUEST_EVENT = "hub:request";
export const HUB_REPLY_EVENT = "hub:reply";
export const HUB_ASK_EVENT = "hub:ask";

export interface NetworkPermissionServiceDeps {
	emit: (channel: string, payload: unknown) => void;
	appendEntry: (customType: string, data: unknown) => void;
}

export interface PersistedNetworkSetting {
	present: boolean;
	configured?: unknown;
}

export interface NetworkPermissionService {
	register(): void;
	unregister(): void;
	getState(): NetworkPermissionState;
	resetSession(): void;
	restore(persisted: PersistedNetworkSetting): void;
	observeSafeMode(safeMode: unknown, source?: string): void;
	setConfigured(setting: unknown, source?: string): boolean;
	handleHubRequest(payload: unknown): boolean;
	handleStateRequest(payload: unknown): boolean;
	handleStateSet(payload: unknown): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameState(a: NetworkPermissionState, b: NetworkPermissionState): boolean {
	return (
		a.configured === b.configured &&
		a.effective === b.effective &&
		a.overriddenByParanoid === b.overriddenByParanoid
	);
}

export function createNetworkPermissionService(deps: NetworkPermissionServiceDeps): NetworkPermissionService {
	let configured: NetworkPolicySetting = "auto";
	// Unknown until safe-mode reports in; this fails closed to ask-all.
	let safeMode: unknown = undefined;
	let state: NetworkPermissionState = resolveNetworkPermissionState({ configured, safeMode });

	const getState = (): NetworkPermissionState => ({ ...state });

	const recompute = (source?: string): boolean => {
		const next = resolveNetworkPermissionState({ configured, safeMode });
		if (sameState(state, next)) return false;
		state = next;
		deps.emit(NETWORK_STATE_EVENTS.changed, createNetworkStateChanged(state, source));
		return true;
	};

	const setConfiguredInternal = (setting: NetworkPolicySetting, source?: string): boolean => {
		if (setting === configured) return false;
		configured = setting;
		// Persist even when PARANOID keeps the effective policy unchanged: the
		// configured choice must survive resume for use after leaving PARANOID.
		deps.appendEntry(PERMISSIONS_CORE_ENTRY_TYPE, { configured });
		recompute(source);
		return true;
	};

	return {
		register: () => {
			deps.emit(HUB_REGISTER_EVENT, { id: PERMISSIONS_CORE_ID, caps: { provide: [PERM_NET] } });
		},

		unregister: () => {
			deps.emit(HUB_UNREGISTER_EVENT, { id: PERMISSIONS_CORE_ID });
		},

		getState,

		resetSession: () => {
			configured = "auto";
			safeMode = undefined;
			// Emit when the reset actually changes state so consumers can never keep
			// rendering a previous session's policy (e.g. resume with no persisted
			// entry and an unavailable safe mode leaves the same effective ask-all).
			recompute("session-reset");
		},

		restore: (persisted) => {
			if (!persisted.present) return;
			// A present but malformed persisted choice fails closed rather than
			// silently reverting to Auto (which could be more permissive).
			configured = parseNetworkPolicySetting(persisted.configured) ?? "ask-all";
			recompute("restore");
		},

		observeSafeMode: (safeModeValue, source) => {
			safeMode = safeModeValue;
			recompute(source);
		},

		setConfigured: (setting, source) => {
			const parsed = parseNetworkPolicySetting(setting);
			if (!parsed) return false;
			return setConfiguredInternal(parsed, source);
		},

		handleHubRequest: (payload) => {
			if (!isRecord(payload)) return false;
			const id = payload.id;
			if (typeof id !== "string") return false;

			const targets = payload.targets;
			if (Array.isArray(targets) && !targets.includes(PERMISSIONS_CORE_ID)) return false;

			const cap = payload.cap;
			if (!Array.isArray(cap)) return false;

			const results: Array<{
				what: string;
				action: "allow" | "confirm" | "block";
				reason?: string;
				summary?: string;
			}> = [];

			for (const item of cap) {
				if (!isRecord(item) || item.what !== PERM_NET) continue;
				const decision = evaluateNetworkPermission({ request: item.data, policy: state.effective });
				results.push({
					what: PERM_NET,
					action: decision.action,
					reason: decision.reason,
					summary: decision.summary,
				});
			}

			if (results.length === 0) return false;
			deps.emit(HUB_REPLY_EVENT, { id, from: PERMISSIONS_CORE_ID, results });
			return true;
		},

		handleStateRequest: (payload) => {
			const request = parseNetworkStateRequest(payload);
			if (!request) return false;
			deps.emit(NETWORK_STATE_EVENTS.response, { id: request.id, state: getState() });
			return true;
		},

		handleStateSet: (payload) => {
			const request = parseNetworkStateSet(payload);
			if (!request) return false;
			return setConfiguredInternal(request.setting, request.source);
		},
	};
}
