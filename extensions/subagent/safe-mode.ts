export const SAFE_MODE_STATE_REQUEST_EVENT = "px:safe-mode:state:request";
export const SAFE_MODE_STATE_RESPONSE_EVENT = "px:safe-mode:state:response";

export const SAFE_MODES = ["paranoid", "reader", "smart", "yolo"] as const;
export type SafeMode = (typeof SAFE_MODES)[number];

export interface SafeModeSnapshot {
	mode: SafeMode;
	outerAccess: boolean;
}

interface EventBusLike {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function isSnapshot(value: unknown): value is SafeModeSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const state = value as { mode?: unknown; outerAccess?: unknown };
	return SAFE_MODES.includes(state.mode as SafeMode) && typeof state.outerAccess === "boolean";
}

export function appendSafeModeArgs(args: string[], snapshot: SafeModeSnapshot | undefined): void {
	if (!snapshot) return;
	args.push("--safe-mode", snapshot.mode, "--safe-mode-outer-access", String(snapshot.outerAccess));
}

export function querySafeModeSnapshot(
	events: EventBusLike,
	options?: { timeoutMs?: number; requestId?: string },
): Promise<SafeModeSnapshot | undefined> {
	const id = options?.requestId ?? `subagent-safe-mode-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const timeoutMs = options?.timeoutMs ?? 150;

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
			if (typeof payload !== "object" || payload === null) return;
			const response = payload as { id?: unknown; state?: unknown };
			if (response.id !== id || !isSnapshot(response.state)) return;
			finish({ ...response.state });
		});
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		try {
			events.emit(SAFE_MODE_STATE_REQUEST_EVENT, { id });
		} catch {
			finish(undefined);
		}
	});
}
