export const HUB_CHANNELS = {
	register: "hub:register",
	unregister: "hub:unregister",
	ask: "hub:ask",
	request: "hub:request",
	reply: "hub:reply",
	answer: "hub:answer",
} as const;

/**
 * Explicit user-wait protocol. The extension that opens the UI declares a wait
 * with `set` and clears it with `clear`; hub stores the declarations and emits
 * the aggregate on `changed`. Pending `hub:ask` requests are never inferred as
 * waits. `ack` lets a client detect synchronously whether this hub supports the
 * protocol (pi event dispatch is synchronous).
 */
export const HUB_USER_WAIT_CHANNELS = {
	set: "hub:user-wait:set",
	clear: "hub:user-wait:clear",
	changed: "hub:user-wait:changed",
	ack: "hub:user-wait:ack",
} as const;

/**
 * External Herdr compatibility event. Herdr's managed Pi integration counts
 * `active: true` / `active: false` to derive its own blocked state, so hub must
 * emit exactly one enter when the aggregate leaves zero and one exit when the
 * last wait clears.
 */
export const HERDR_BLOCKED_EVENT = "herdr:blocked";

// The registry module owns the wait payload/snapshot shapes; re-export them so
// protocol consumers have a single import surface.
export type {
	UserWaitClearPayload,
	UserWaitEntry,
	UserWaitKind,
	UserWaitSetPayload,
	UserWaitSnapshot,
} from "./user-wait";

/** Registry operation acknowledged on `HUB_USER_WAIT_CHANNELS.ack`. */
export type UserWaitOperation = "set" | "clear";

/** Acknowledgement that hub accepted a `set` or `clear` declaration. */
export type HubUserWaitAckPayload = {
	id: string;
	owner: string;
	operation: UserWaitOperation;
};

export const HUB_PERMISSIONS = {
	shell: "perm:shell",
	io: "perm:io",
	net: "perm:net",
	agent: "perm:agent",
} as const;

export type PermissionAction = "allow" | "confirm" | "block";

export type CapRequest = {
	what: string;
	data: Record<string, unknown>;
};

export type CapResult = {
	what: string;
	action: PermissionAction;
	reason?: string;
	// Optional human-readable one-line description of the classified call.
	// Requesters (e.g. safe-mode) may use it for approval prompts.
	summary?: string;
};

export type HubRegisterPayload = {
	id: string;
	caps: { provide: string[] };
};

export type HubUnregisterPayload = {
	id: string;
};

export type HubAskPayload = {
	id: string;
	from?: string;
	ctx?: unknown;
	cap: CapRequest[];
};

export type HubRequestPayload = HubAskPayload & {
	targets: string[];
};

export type HubReplyPayload = {
	id: string;
	from?: string;
	results: CapResult[];
};

export type HubAnswerPayload = {
	id: string;
	results: CapResult[];
};
