// Minimal safe-mode observation used for Auto derivation and PARANOID.
//
// Safe-mode already publishes its state on `px:safe-mode:state:*`. We only need
// the mode, so this mirrors the small read-only surface (the same approach the
// subagent extension takes) instead of importing across extension folders.

import { parseNetworkSafeMode, type NetworkSafeMode } from "./policy";

export const SAFE_MODE_STATE_REQUEST_EVENT = "px:safe-mode:state:request";
export const SAFE_MODE_STATE_RESPONSE_EVENT = "px:safe-mode:state:response";
export const SAFE_MODE_STATE_CHANGED_EVENT = "px:safe-mode:state:changed";

const MAX_ID_LENGTH = 256;
const MAX_SOURCE_LENGTH = 128;
const DEFAULT_QUERY_TIMEOUT_MS = 200;

export interface SafeModeSnapshot {
	mode: NetworkSafeMode;
	outerAccess: boolean;
}

export interface EventBusLike {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSafeModeSnapshot(value: unknown): SafeModeSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	const mode = parseNetworkSafeMode(value.mode);
	if (!mode || typeof value.outerAccess !== "boolean") return undefined;
	return { mode, outerAccess: value.outerAccess };
}

export function parseSafeModeChangedSource(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const source = value.source;
	if (typeof source !== "string" || source.trim().length === 0 || source.length > MAX_SOURCE_LENGTH) return undefined;
	return source;
}

function isBoundedId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;
}

/**
 * Ask safe-mode for its current state. Resolves `undefined` on timeout, absent
 * provider, or malformed response. Never throws and never goes through the hub.
 */
export function querySafeModeSnapshot(
	events: EventBusLike,
	options?: { timeoutMs?: number; requestId?: string },
): Promise<SafeModeSnapshot | undefined> {
	const id = options?.requestId ?? `permissions-core-safe-mode-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

	return new Promise((resolve) => {
		let settled = false;
		const finish = (snapshot: SafeModeSnapshot | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off();
			resolve(snapshot);
		};

		const off = events.on(SAFE_MODE_STATE_RESPONSE_EVENT, (payload) => {
			if (!isRecord(payload) || !isBoundedId(payload.id) || payload.id !== id) return;
			finish(parseSafeModeSnapshot(payload.state));
		});

		const timer = setTimeout(() => finish(undefined), timeoutMs);

		try {
			events.emit(SAFE_MODE_STATE_REQUEST_EVENT, { id });
		} catch {
			finish(undefined);
		}
	});
}
