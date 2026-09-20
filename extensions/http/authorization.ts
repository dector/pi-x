// One-time authorization handoff for HTTP network operations.
//
// The nested `perm:tool -> perm:net` flow classifies a request, but it only
// runs when safe-mode *and* the hub are present. Enforcement must not depend on
// that: the actual `execute()` path independently requires a ticket that was
// created during a successful preflight and then authorized by safe-mode after
// its final decision (an `allow` or a user approval).
//
// Flow:
//   1. safe-mode asks hub `perm:tool` with `toolCallId`.
//   2. http revokes any stale ticket for that id, normalizes the request, asks
//      `perm:net`, merges the network and filesystem decisions, and only for an
//      allow/confirm result stores a ticket (authorized=false) immediately
//      before its provider reply. A block stores nothing.
//   3. safe-mode reaches a final allow/user-approval and emits
//      `TOOL_AUTHORIZED_EVENT` with the same `toolCallId` and
//      `source: "safe-mode"`, which refreshes the ticket TTL.
//   4. http flips the ticket to authorized.
//   5. `execute()` consumes the ticket exactly once, after re-normalizing the
//      params and confirming they did not change.
//
// Missing hub, missing safe-mode, timeout, denied/non-UI confirmation, replay,
// changed params, or a timeout-fallback handoff emitted before the ticket was
// stored therefore all fail closed at execution.

import { createHash } from "node:crypto";

export const TOOL_AUTHORIZED_EVENT = "px:safe-mode:tool-authorized";

const MAX_ID_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_FINGERPRINT_LENGTH = 256;
const MAX_FINGERPRINT_INPUT_DEPTH = 64;

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 256;

export interface ToolAuthorizedPayload {
	toolCallId: string;
	toolName: string;
	source?: string;
}

interface NetworkTicket {
	toolCallId: string;
	toolName: string;
	fingerprint: string;
	createdAt: number;
	authorized: boolean;
}

export interface ConsumeTicketResult {
	ok: boolean;
	reason?: string;
}

export interface AuthorizationStore {
	preflight(toolCallId: string, toolName: string, fingerprint: string): boolean;
	revoke(toolCallId: string): boolean;
	authorize(toolCallId: string, toolName: string): boolean;
	consume(toolCallId: string, toolName: string, fingerprint: string): ConsumeTicketResult;
	reset(): void;
	size(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

/**
 * Validate an authorization payload. `toolCallId` and `toolName` are required
 * and bounded; anything else is dropped so a malformed event can never grant a
 * ticket.
 */
export function parseToolAuthorized(value: unknown): ToolAuthorizedPayload | undefined {
	if (!isRecord(value)) return undefined;
	if (!isBoundedString(value.toolCallId, MAX_ID_LENGTH)) return undefined;
	if (!isBoundedString(value.toolName, MAX_TOOL_NAME_LENGTH)) return undefined;
	if (value.source !== undefined && !isBoundedString(value.source, MAX_ID_LENGTH)) return undefined;
	return { toolCallId: value.toolCallId, toolName: value.toolName, source: value.source as string | undefined };
}

/**
 * Deterministic JSON encoding with sorted object keys. Used only to derive a
 * change-detection fingerprint, never to store or display input.
 */
export function stableStringify(value: unknown, maxDepth = MAX_FINGERPRINT_INPUT_DEPTH): string {
	const seen = new WeakSet<object>();

	const encode = (input: unknown, depth: number): string => {
		if (input === null) return "null";
		switch (typeof input) {
			case "string":
				return JSON.stringify(input);
			case "number":
				return Number.isFinite(input) ? String(input) : `"${String(input)}"`;
			case "boolean":
				return input ? "true" : "false";
			case "bigint":
				return `"${input.toString()}"`;
			case "undefined":
				return "\"[undefined]\"";
			case "function":
			case "symbol":
				return "\"[unserializable]\"";
		}

		if (depth >= maxDepth) return "\"[max-depth]\"";
		if (Array.isArray(input)) {
			if (seen.has(input)) return "\"[circular]\"";
			seen.add(input);
			const encoded = `[${input.map((item) => encode(item, depth + 1)).join(",")}]`;
			seen.delete(input);
			return encoded;
		}

		const object = input as Record<string, unknown>;
		if (seen.has(object)) return "\"[circular]\"";
		seen.add(object);
		const encoded = `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${encode(object[key], depth + 1)}`)
			.join(",")}}`;
		seen.delete(object);
		return encoded;
	};

	return encode(value, 0);
}

/** SHA-256 of the stable encoding, so fingerprints are bounded and collision-safe. */
export function fingerprintValue(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function createAuthorizationStore(options?: {
	ttlMs?: number;
	maxEntries?: number;
	now?: () => number;
}): AuthorizationStore {
	const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
	const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const now = options?.now ?? Date.now;
	const tickets = new Map<string, NetworkTicket>();

	// Bounded cleanup: drop expired tickets, then the oldest if still over cap.
	const prune = (): void => {
		const current = now();
		for (const [id, ticket] of tickets) {
			if (current - ticket.createdAt > ttlMs) tickets.delete(id);
		}
		while (tickets.size > maxEntries) {
			const oldest = tickets.keys().next().value;
			if (oldest === undefined) break;
			tickets.delete(oldest);
		}
	};

	return {
		preflight(toolCallId, toolName, fingerprint) {
			if (!isBoundedString(toolCallId, MAX_ID_LENGTH)) return false;
			if (!isBoundedString(toolName, MAX_TOOL_NAME_LENGTH)) return false;
			if (!isBoundedString(fingerprint, MAX_FINGERPRINT_LENGTH)) return false;
			tickets.set(toolCallId, {
				toolCallId,
				toolName,
				fingerprint,
				createdAt: now(),
				authorized: false,
			});
			prune();
			return true;
		},

		revoke(toolCallId) {
			prune();
			return tickets.delete(toolCallId);
		},

		authorize(toolCallId, toolName) {
			prune();
			const ticket = tickets.get(toolCallId);
			if (!ticket || ticket.toolName !== toolName) return false;
			ticket.authorized = true;
			// Refresh the TTL from the final decision so an approved request does not
			// expire while a delayed tool call is still waiting to execute.
			ticket.createdAt = now();
			return true;
		},

		consume(toolCallId, toolName, fingerprint) {
			prune();
			const ticket = tickets.get(toolCallId);
			// Delete on every attempt: consumption is one-time and replay-safe.
			if (ticket) tickets.delete(toolCallId);
			if (!ticket) return { ok: false, reason: "no authorization for this network request" };
			if (ticket.toolName !== toolName) {
				return { ok: false, reason: "authorization is for a different tool" };
			}
			if (!ticket.authorized) {
				return { ok: false, reason: "this network request was not approved" };
			}
			if (ticket.fingerprint !== fingerprint) {
				return { ok: false, reason: "request parameters changed after approval" };
			}
			return { ok: true };
		},

		reset() {
			tickets.clear();
		},

		size() {
			return tickets.size;
		},
	};
}
