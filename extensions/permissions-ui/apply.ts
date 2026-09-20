// Bounded `set` -> `changed` round trip for `/px:net`.
//
// Emits `set` through the permissions-core contract and resolves `true` when
// the core confirms a matching `changed`. If no confirmation arrives before
// the timeout, it re-queries the current state and accepts the request when
// the configured setting already equals it. That closes the no-op race: when
// the core already has the requested setting it emits no `changed`, but the
// update is still effectively applied.
//
// A `changed` event is only accepted immediately when it carries no source or
// the source of our own `set`. An event from another source is confirmed by
// the re-query fallback instead, so a concurrent writer cannot fake our ack.

import {
	NETWORK_STATE_EVENTS,
	parseNetworkStateChanged,
	type NetworkPermissionState,
	type NetworkPolicySetting,
} from "./contract";
import type { EventBusLike } from "./query";

const DEFAULT_SET_TIMEOUT_MS = 1000;

export interface ApplyNetworkSettingOptions {
	queryState(): Promise<NetworkPermissionState | undefined>;
	timeoutMs?: number;
}

export function applyNetworkSetting(
	events: EventBusLike,
	setting: NetworkPolicySetting,
	source: string,
	options: ApplyNetworkSettingOptions,
): Promise<boolean> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_SET_TIMEOUT_MS;

	return new Promise((resolve) => {
		let settled = false;
		const finish = (accepted: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off();
			resolve(accepted);
		};

		const off = events.on(NETWORK_STATE_EVENTS.changed, (payload) => {
			const changed = parseNetworkStateChanged(payload);
			if (!changed || changed.configured !== setting) return;
			if (changed.source !== undefined && changed.source !== source) return;
			finish(true);
		});

		const timer = setTimeout(() => {
			void options.queryState().then(
				(state) => finish(state?.configured === setting),
				() => finish(false),
			);
		}, timeoutMs);

		try {
			events.emit(NETWORK_STATE_EVENTS.set, { setting, source });
		} catch {
			finish(false);
		}
	});
}
