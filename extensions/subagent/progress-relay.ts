/**
 * Child-to-parent progress relay wire helpers.
 *
 * A subagent runs in its own Pi process, so its local `pi.events` bus and hub
 * registry cannot reach the parent UI. Instead the child-side `progress` tool
 * serializes one mutation into a `ProgressRelayEnvelope` and sends it through
 * the existing fire-and-forget extension UI `setStatus` RPC. The parent
 * subagent extension recognizes the exact status key, validates the envelope
 * here, and re-emits the mutation on the parent bus.
 *
 * Protocol: `extensions/hub/idea-progress.md` section 9 (subagent relay
 * protocol). The status key and envelope are mirrored by the hub
 * `progress-tool.ts`. This module must not import the hub extension, and hub
 * must not import this module, so either extension still loads alone.
 *
 * This module is pure: no Pi runtime imports.
 */

/** Wire status key; mirrored locally in `extensions/hub/progress-tool.ts`. */
export const PROGRESS_RELAY_STATUS_KEY = "px:hub-progress-relay";

/** One serialized envelope is capped at 256 KiB. Mirrors hub `progress.ts`. */
export const MAX_PROGRESS_RELAY_BYTES = 256 * 1024;

/** The only mutation channels a child may relay upward. */
export const PROGRESS_RELAY_CHANNELS = [
	"hub:progress:create",
	"hub:progress:update",
	"hub:progress:finish",
	"hub:progress:remove",
] as const;

export type ProgressRelayChannel = (typeof PROGRESS_RELAY_CHANNELS)[number];

/** Relayed mutations always belong to the tool owner, never the child. */
export const PROGRESS_RELAY_OWNER = "progress-tool";

/** Concise diagnostic appended once when a relayed status is rejected. */
export const PROGRESS_RELAY_DIAGNOSTIC = "Malformed progress relay";

export interface ProgressRelayEnvelope {
	version: 1;
	channel: ProgressRelayChannel;
	payload: Record<string, unknown>;
}

export type ProgressRelayParseResult =
	| { ok: true; channel: ProgressRelayChannel; payload: Record<string, unknown> }
	| { ok: false; reason: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function isRelayChannel(value: unknown): value is ProgressRelayChannel {
	return typeof value === "string" && (PROGRESS_RELAY_CHANNELS as readonly string[]).includes(value);
}

/**
 * Validate one relayed `setStatus` text. Never throws and never echoes the raw
 * payload back: failures return only a short stable reason string.
 *
 * On success the relayed `owner` is overwritten with `PROGRESS_RELAY_OWNER`;
 * a child must not be able to impersonate another protocol owner.
 */
export function parseProgressRelay(statusText: unknown): ProgressRelayParseResult {
	if (typeof statusText !== "string") return { ok: false, reason: "not-a-string" };
	if (Buffer.byteLength(statusText, "utf8") > MAX_PROGRESS_RELAY_BYTES) {
		return { ok: false, reason: "too-large" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(statusText);
	} catch {
		return { ok: false, reason: "malformed-json" };
	}

	const envelope = asRecord(parsed);
	if (!envelope) return { ok: false, reason: "not-an-object" };
	if (envelope.version !== 1) return { ok: false, reason: "unsupported-version" };
	if (!isRelayChannel(envelope.channel)) return { ok: false, reason: "unknown-channel" };

	const payload = asRecord(envelope.payload);
	if (!payload) return { ok: false, reason: "invalid-payload" };

	return { ok: true, channel: envelope.channel, payload: { ...payload, owner: PROGRESS_RELAY_OWNER } };
}

export type ProgressRelayEmit = (channel: ProgressRelayChannel, payload: Record<string, unknown>) => void;

/**
 * Apply one relayed status text without ever throwing out of the parent RPC
 * handler. A malformed or unusable envelope is reported through `onMalformed`
 * (the caller bounds that diagnostic); a throwing parent listener is swallowed.
 *
 * Returns true only when a validated mutation was handed to `emit`.
 */
export function applyProgressRelay(
	statusText: unknown,
	emit: ProgressRelayEmit,
	onMalformed: () => void,
): boolean {
	let parsed: ProgressRelayParseResult;
	try {
		parsed = parseProgressRelay(statusText);
	} catch {
		onMalformed();
		return false;
	}

	if (!parsed.ok) {
		onMalformed();
		return false;
	}

	try {
		emit(parsed.channel, parsed.payload);
	} catch {
		// A parent bus listener must never break the child RPC handler.
	}
	return true;
}

/**
 * Build the child `--tools` list for one agent.
 *
 * Appends `progress` only when the parent has the tool registered, the agent
 * has a non-empty explicit list, and `progress` is not already present. Any
 * other case returns the original list (including `undefined`) unchanged.
 */
export function withProgressTool(tools: string[] | undefined, hasProgress: boolean): string[] | undefined {
	if (!hasProgress) return tools;
	if (!tools || tools.length === 0) return tools;
	if (tools.includes("progress")) return tools;
	return [...tools, "progress"];
}

/**
 * Teach every child when it owns a parent progress leaf without requiring the
 * coordinator to repeat lifecycle rules in each task. The guidance is present
 * only when the parent exposes `progress`; otherwise children must not be told
 * to call a tool that may not exist.
 */
export function withProgressGuidance(systemPrompt: string, hasProgress: boolean): string {
	if (!hasProgress) return systemPrompt;

	const guidance = [
		"## Delegated progress reporting",
		"",
		"When your task explicitly provides `trackerId`, `trackerToken`, and `chunkId`, you own that parent progress leaf:",
		"- Call `progress update` to mark only that leaf `active` when meaningful work begins. Add a short phase such as `reviewing`, `implementing`, or `testing` when useful.",
		"- Mark it `done` after successful completion, `failed` after permanent failure, or `blocked` when an external change is required before work can continue.",
		"- Do not start, finish, or clear the parent tracker. Do not update containers or other leaves.",
		"- Child delivery is best-effort. Report the tool result accurately and never claim that the parent accepted an update.",
		"- If any of the three identifiers is absent, do not use `progress` for the parent task.",
	].join("\n");

	const trimmed = systemPrompt.trimEnd();
	return trimmed ? `${trimmed}\n\n${guidance}\n` : `${guidance}\n`;
}
