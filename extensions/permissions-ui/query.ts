// Bounded, read-only state query against permissions-core.
//
// Never throws and never goes through the hub. Resolves `undefined` on timeout,
// malformed response, or absent provider so `/px:net` can notify the user
// instead of silently failing.

import {
	NETWORK_STATE_EVENTS,
	parseNetworkStateResponse,
	type NetworkPermissionState,
} from "./contract";

const DEFAULT_QUERY_TIMEOUT_MS = 300;

export interface EventBusLike {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export function queryNetworkState(
	events: EventBusLike,
	options?: { timeoutMs?: number; requestId?: string },
): Promise<NetworkPermissionState | undefined> {
	const id = options?.requestId ?? `permissions-ui-net-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

	return new Promise((resolve) => {
		let settled = false;
		const finish = (state: NetworkPermissionState | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off();
			resolve(state);
		};

		const off = events.on(NETWORK_STATE_EVENTS.response, (payload) => {
			const response = parseNetworkStateResponse(payload);
			if (!response || response.id !== id) return;
			finish(response.state);
		});

		const timer = setTimeout(() => finish(undefined), timeoutMs);

		try {
			events.emit(NETWORK_STATE_EVENTS.request, { id });
		} catch {
			finish(undefined);
		}
	});
}
