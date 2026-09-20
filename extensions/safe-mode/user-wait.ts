/**
 * Safe-mode user-wait client.
 *
 * Safe-mode owns the approval/steering UIs, so it declares and clears user
 * waits. This helper wraps an interactive action:
 *
 * 1. register a temporary listener for the matching hub acknowledgement;
 * 2. emit `hub:user-wait:set` before the action opens the UI;
 * 3. if hub acknowledged synchronously, use `hub` mode, otherwise fall back to
 *    emitting `herdr:blocked { active: true }` directly (`legacy` mode);
 * 4. clear the wait in `finally`, using exactly the same mode as the set.
 *
 * Pi's event dispatch is synchronous, so the acknowledgement is observable
 * before `emit` returns. Never emit both hub and legacy paths for one wait:
 * hub's own Herdr adapter would otherwise double-increment Herdr's counter.
 *
 * The channel constants mirror `extensions/hub/contract.ts`. They are kept
 * local so loading safe-mode does not require the hub module to be installed;
 * the hub may be absent or older than this protocol.
 */

import { HERDR_BLOCKED_EVENT } from "./herdr-blocked.ts";

/** Mirror of `HUB_USER_WAIT_CHANNELS` in `extensions/hub/contract.ts`. */
export const USER_WAIT_CHANNELS = {
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

/** Which clear path a wait selected. Fixed for the lifetime of the wait. */
export type UserWaitMode = "hub" | "legacy";

interface HubUserWaitAck {
	id: string;
	owner: string;
	operation: "set" | "clear";
}

let waitSequence = 0;

/**
 * Generate a unique wait ID. Every concrete UI wait gets its own ID so nested
 * or overlapping waits can never clear each other. The per-process sequence
 * plus a random suffix keeps IDs unique even within one millisecond.
 */
export function generateUserWaitId(): string {
	waitSequence += 1;
	const random = Math.random().toString(36).slice(2, 10);
	return `safe-mode-${Date.now().toString(36)}-${waitSequence.toString(36)}-${random}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMatchingSetAck(payload: unknown, id: string, owner: string): payload is HubUserWaitAck {
	if (!isRecord(payload)) return false;
	return payload.id === id && payload.owner === owner && payload.operation === "set";
}

/**
 * Run `action` as an interactive user wait.
 *
 * The wait is declared before `action` runs and cleared in `finally`. The
 * action's resolved value is returned untouched and a thrown error is rethrown
 * unchanged (same error object).
 */
export async function withUserWait<T>(
	events: UserWaitEventBus,
	options: UserWaitOptions,
	action: () => Promise<T> | T,
): Promise<T> {
	const id = generateUserWaitId();

	const setPayload: Record<string, unknown> = { id, owner: options.owner };
	if (options.label !== undefined) setPayload.label = options.label;
	if (options.kind !== undefined) setPayload.kind = options.kind;

	let acknowledged = false;
	const offAck = events.on(USER_WAIT_CHANNELS.ack, (payload) => {
		if (isMatchingSetAck(payload, id, options.owner)) acknowledged = true;
	});

	// Declare before the UI opens. Dispatch is synchronous, so an installed hub
	// acks here; an absent or old hub stays silent and we fall back to legacy.
	try {
		events.emit(USER_WAIT_CHANNELS.set, setPayload);
	} finally {
		offAck();
	}

	const mode: UserWaitMode = acknowledged ? "hub" : "legacy";
	if (mode === "legacy") {
		const blockedPayload: Record<string, unknown> = { active: true };
		if (options.label !== undefined) blockedPayload.label = options.label;
		events.emit(HERDR_BLOCKED_EVENT, blockedPayload);
	}

	try {
		return await action();
	} finally {
		// Exactly one clear path, matching how the wait was declared.
		if (mode === "hub") {
			events.emit(USER_WAIT_CHANNELS.clear, { id, owner: options.owner });
		} else {
			events.emit(HERDR_BLOCKED_EVENT, { active: false });
		}
	}
}
