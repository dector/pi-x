/**
 * Subagent user-wait client.
 *
 * The subagent extension owns the parent-facing dialogs that relay a child's
 * approval/input request. While such a dialog is open the user is waiting, so
 * declare a hub user wait (falling back to `herdr:blocked` when hub is absent),
 * exactly like safe-mode does. Without it the parent Herdr pane keeps reporting
 * `working` during a child approval instead of `blocked`.
 *
 * The channel constants mirror `extensions/hub/contract.ts` and
 * `extensions/safe-mode/user-wait.ts`. They stay local so loading subagent does
 * not require hub or safe-mode to be installed. See `extensions/hub/PROTOCOL.md`.
 */

/** Mirror of `HERDR_BLOCKED_EVENT` in `extensions/safe-mode/herdr-blocked.ts`. */
const HERDR_BLOCKED_EVENT = "herdr:blocked";

/** Mirror of `HUB_USER_WAIT_CHANNELS` in `extensions/hub/contract.ts`. */
const USER_WAIT_CHANNELS = {
	set: "hub:user-wait:set",
	clear: "hub:user-wait:clear",
	ack: "hub:user-wait:ack",
} as const;

/** Why the user is being waited on. Purely descriptive metadata. */
export type UserWaitKind = "approval" | "input" | "other";

/** Minimal event-bus surface needed by the helper (`pi.events`). */
export interface UserWaitEventBus {
	emit(channel: string, payload: unknown): void;
	on(channel: string, handler: (payload: unknown) => void): () => void;
}

export interface UserWaitOptions {
	owner: string;
	label?: string;
	kind?: UserWaitKind;
}

let waitSequence = 0;

/** Every concrete UI wait gets its own id so overlapping waits cannot clear each other. */
function nextUserWaitId(owner: string): string {
	waitSequence += 1;
	const random = Math.random().toString(36).slice(2, 10);
	return `${owner}-${Date.now().toString(36)}-${waitSequence.toString(36)}-${random}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Run `action` as an interactive user wait. Declared before `action` and
 * cleared in `finally`; the action's value/error passes through unchanged.
 * Exactly one clear path is used, matching how the wait was declared.
 */
export async function withUserWait<T>(
	events: UserWaitEventBus,
	options: UserWaitOptions,
	action: () => Promise<T> | T,
): Promise<T> {
	const id = nextUserWaitId(options.owner);
	const setPayload: Record<string, unknown> = { id, owner: options.owner };
	if (options.label !== undefined) setPayload.label = options.label;
	if (options.kind !== undefined) setPayload.kind = options.kind;

	let acknowledged = false;
	const offAck = events.on(USER_WAIT_CHANNELS.ack, (payload) => {
		if (!isRecord(payload)) return;
		if (payload.id === id && payload.owner === options.owner && payload.operation === "set") acknowledged = true;
	});
	// Pi event dispatch is synchronous, so an installed hub acks before emit returns.
	try {
		events.emit(USER_WAIT_CHANNELS.set, setPayload);
	} finally {
		offAck();
	}

	const mode = acknowledged ? "hub" : "legacy";
	if (mode === "legacy") {
		const blockedPayload: Record<string, unknown> = { active: true };
		if (options.label !== undefined) blockedPayload.label = options.label;
		events.emit(HERDR_BLOCKED_EVENT, blockedPayload);
	}

	try {
		return await action();
	} finally {
		if (mode === "hub") {
			events.emit(USER_WAIT_CHANNELS.clear, { id, owner: options.owner });
		} else {
			events.emit(HERDR_BLOCKED_EVENT, { active: false });
		}
	}
}
