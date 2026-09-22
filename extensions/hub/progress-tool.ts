/**
 * Model-facing `progress` tool for the hub extension.
 *
 * The tool exposes four read-friendly actions (`start`, `update`, `finish`,
 * `clear`) over the internal `hub:progress:*` mutation protocol. It is a thin,
 * synchronous direct client:
 *
 * 1. validate the action-specific arguments;
 * 2. build one mutation payload with a fixed owner and a fresh request ID;
 * 3. install a temporary `ack` listener;
 * 4. emit exactly one mutation event (so observers cannot be spammed);
 * 5. read the matching acknowledgement before unsubscribing.
 *
 * `owner` and `requestId` are hidden from the model. `trackerId` and
 * `trackerToken` are returned because later calls (and delegated children) need
 * them. When `PI_SUBAGENT_CHILD === "1"` the tool is running in a subagent
 * process whose local hub is not the parent UI: it then serializes one
 * `hub:progress:*` envelope into an extension UI `setStatus` relay instead of
 * mutating anything locally. See `extensions/hub/idea-progress.md` section 9.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	HUB_PROGRESS_CHANNELS,
	PROGRESS_CHUNK_STATES,
	PROGRESS_OUTCOMES,
	type HubProgressAckPayload,
	type ProgressChunkDefinition,
	type ProgressChunkState,
	type ProgressCreatePayload,
	type ProgressFinishPayload,
	type ProgressOperation,
	type ProgressOutcome,
	type ProgressRemovePayload,
	type ProgressUpdatePayload,
} from "./contract";
import { isProgressChunkState, isProgressOutcome } from "./progress";

// ---------------------------------------------------------------------------
// Public identity
// ---------------------------------------------------------------------------

export const PROGRESS_TOOL_NAME = "progress";

/** Fixed owner for every tracker the model-facing tool creates or mutates. */
export const PROGRESS_TOOL_OWNER = "progress-tool";

/**
 * Child-to-parent relay status key.
 *
 * Mirrors the wire constant in `extensions/subagent/progress-relay.ts`;
 * protocol: `extensions/hub/idea-progress.md` section 9 (subagent relay
 * protocol). The hub and subagent extensions must not import each other's
 * runtime modules, so this small constant is copied on both sides.
 */
export const PROGRESS_RELAY_STATUS_KEY = "px:hub-progress-relay";

/** Minimal `ctx.ui` slice the child relay sender needs. */
export interface ProgressChildRelayUi {
	setStatus(key: string, text: string | undefined): void;
}

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

export const PROGRESS_TOOL_ACTIONS = ["start", "update", "finish", "clear"] as const;
export type ProgressToolAction = (typeof PROGRESS_TOOL_ACTIONS)[number];

export interface ProgressToolInput {
	action: ProgressToolAction;
	title?: string;
	unit?: string;
	trackerId?: string;
	trackerToken?: string;
	chunks?: ProgressChunkDefinition[];
	chunkId?: string;
	state?: ProgressChunkState;
	phase?: string;
	detail?: string;
	outcome?: ProgressOutcome;
	summary?: string;
}

/** Structured tool details. Never contains `owner` or `requestId`. */
export interface ProgressToolDetails {
	action: ProgressToolAction;
	operation: ProgressOperation;
	trackerId: string;
	trackerToken: string;
	chunkId?: string;
	chunkCount?: number;
}

export interface ProgressToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: ProgressToolDetails;
}

/** Minimal slice of the Pi event bus the direct client needs. */
export interface ProgressToolEventBus {
	on(event: string, handler: (payload: unknown) => void): () => void;
	emit(event: string, payload: unknown): void;
}

// ---------------------------------------------------------------------------
// TypeBox schema: one object with optional action-specific fields
// ---------------------------------------------------------------------------

const ProgressChunkSchema = Type.Object({
	id: Type.String({ description: "Stable unique node id within the tracker." }),
	label: Type.Optional(Type.String({ description: "Optional human-readable node label." })),
	parentId: Type.Optional(Type.String({ description: "Optional earlier parent node id; omission creates a root." })),
	childUnit: Type.Optional(Type.String({ description: "Optional singular noun for this node's direct children." })),
});

export const ProgressToolParams = Type.Object({
	action: StringEnum(PROGRESS_TOOL_ACTIONS, {
		description:
			"start creates a tracker; update reports one chunk; finish sets a terminal outcome; clear removes the tracker.",
	}),
	title: Type.Optional(Type.String({ description: "start: tracker title, for example the task name." })),
	unit: Type.Optional(
		Type.String({
			description:
				"start: singular display noun for root nodes; match the work size (Milestone for a large multi-session feature, Phase for a normal multi-step task, Step for smaller steps).",
		}),
	),
	trackerId: Type.Optional(
		Type.String({ description: "start: optional stable id; update/finish/clear: required id from start." }),
	),
	trackerToken: Type.Optional(
		Type.String({ description: "Opaque token from start; required for update, finish, and clear." }),
	),
	chunks: Type.Optional(
		Type.Array(ProgressChunkSchema, { description: "start: ordered, non-empty node list; every parent must appear before its children." }),
	),
	chunkId: Type.Optional(Type.String({ description: "update: chunk id to report." })),
	state: Type.Optional(
		StringEnum(PROGRESS_CHUNK_STATES, {
			description: "update: lifecycle state; use phase for workflow words such as reviewing.",
		}),
	),
	phase: Type.Optional(
		Type.String({ description: "update: optional display phase, valid only with state active." }),
	),
	detail: Type.Optional(Type.String({ description: "update: optional short display detail." })),
	outcome: Type.Optional(
		StringEnum(PROGRESS_OUTCOMES, { description: "finish: completed, failed, or cancelled." }),
	),
	summary: Type.Optional(Type.String({ description: "finish: optional short outcome summary." })),
});

// ---------------------------------------------------------------------------
// Tool description (behavioral guidance from section 8.2)
// ---------------------------------------------------------------------------

export const PROGRESS_TOOL_DESCRIPTION = [
	"Report semantic progress for a multi-step plan through the hub.",
	"Chunks are an immutable ordered tree created once; parentId refers to an earlier node and childUnit names its direct children.",
	"",
	"Guidance:",
	"1. Start a tracker only when there are multiple known chunks; do not use it for a single trivial task.",
	"2. Report meaningful transitions, not every tool call.",
	"3. Use `phase` for workflow words such as `reviewing`, `implementing`, or `testing` while a chunk is active.",
	"4. Update leaves only; container nodes aggregate their descendant leaves automatically.",
	"5. Mark each leaf terminal (`done`, `failed`, or `skipped`) when its work settles.",
	"6. Call `finish` once the whole tracker has an outcome; `completed` requires every leaf done or skipped.",
	"7. Match the noun to the work size: Milestone > Stage for a large feature spanning sessions, Phase > Step for a multi-step task in one session; deeper nesting is supported.",
	"8. Pass `trackerId`, `trackerToken`, and a leaf `chunkId` in a subagent task when that subagent owns the leaf.",
].join("\n");

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function randomSuffix(): string {
	return Math.random().toString(36).slice(2, 10);
}

function timePart(): string {
	return Date.now().toString(36);
}

export function generateProgressTrackerId(): string {
	return `progress-${timePart()}-${randomSuffix()}`;
}

export function generateProgressTrackerToken(): string {
	return `pt-${timePart()}-${randomSuffix()}`;
}

export function generateProgressRequestId(): string {
	return `progress-tool-${timePart()}-${randomSuffix()}`;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function requireStringField(record: Record<string, unknown>, field: string, action: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`progress ${action}: \`${field}\` is required and must be a non-empty string.`);
	}
	return value;
}

function optionalStringField(record: Record<string, unknown>, field: string, action: string): string | undefined {
	const value = record[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error(`progress ${action}: \`${field}\` must be a string when provided.`);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Mutation preparation
// ---------------------------------------------------------------------------

interface PreparedMutation {
	action: ProgressToolAction;
	operation: ProgressOperation;
	channel: string;
	payload:
		| ProgressCreatePayload
		| ProgressUpdatePayload
		| ProgressFinishPayload
		| ProgressRemovePayload;
	visible: string;
	details: ProgressToolDetails;
}

/**
 * Build exactly one validated mutation payload. Throws `Error` for invalid
 * action-specific arguments, before any event is emitted.
 */
export function prepareProgressMutation(params: unknown, requestId: string): PreparedMutation {
	const record = asRecord(params);
	if (!record) {
		throw new Error("progress: arguments must be an object with an `action`.");
	}

	const action = record.action;
	if (action !== "start" && action !== "update" && action !== "finish" && action !== "clear") {
		throw new Error(
			`progress: \`action\` must be one of ${PROGRESS_TOOL_ACTIONS.join(", ")}.`,
		);
	}

	if (action === "start") return prepareStart(record, requestId);
	if (action === "update") return prepareUpdate(record, requestId);
	if (action === "finish") return prepareFinish(record, requestId);
	return prepareClear(record, requestId);
}

function prepareStart(record: Record<string, unknown>, requestId: string): PreparedMutation {
	const title = requireStringField(record, "title", "start");

	const rawChunks = record.chunks;
	if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
		throw new Error("progress start: `chunks` must be a non-empty array of node objects.");
	}

	const chunks: ProgressChunkDefinition[] = [];
	const seen = new Set<string>();
	for (const raw of rawChunks) {
		const chunk = asRecord(raw);
		if (!chunk) throw new Error("progress start: each chunk must be an object with an `id`.");
		const id = requireStringField(chunk, "id", "start");
		if (seen.has(id)) throw new Error(`progress start: duplicate chunk id \`${id}\`.`);

		const label = optionalStringField(chunk, "label", "start");
		const parentId = optionalStringField(chunk, "parentId", "start");
		const childUnit = optionalStringField(chunk, "childUnit", "start");
		if (parentId !== undefined && (!parentId || !seen.has(parentId))) {
			throw new Error(`progress start: parent \`${parentId}\` for \`${id}\` must appear earlier.`);
		}
		const definition: ProgressChunkDefinition = { id };
		if (label !== undefined) definition.label = label;
		if (parentId !== undefined) definition.parentId = parentId;
		if (childUnit !== undefined) definition.childUnit = childUnit;
		chunks.push(definition);
		seen.add(id);
	}

	const unit = optionalStringField(record, "unit", "start");
	const suppliedTrackerId = optionalStringField(record, "trackerId", "start");
	if (suppliedTrackerId !== undefined && suppliedTrackerId.length === 0) {
		throw new Error("progress start: `trackerId` must be a non-empty string when provided.");
	}
	const trackerId = suppliedTrackerId ?? generateProgressTrackerId();
	const trackerToken = generateProgressTrackerToken();

	const payload: ProgressCreatePayload = {
		requestId,
		trackerId,
		trackerToken,
		owner: PROGRESS_TOOL_OWNER,
		title,
		chunks,
	};
	if (unit !== undefined) payload.unit = unit;

	const chunkWord = chunks.length === 1 ? "chunk" : "chunks";
	return {
		action: "start",
		operation: "create",
		channel: HUB_PROGRESS_CHANNELS.create,
		payload,
		visible: `progress start: ${trackerId} (${chunks.length} ${chunkWord}) — ${title}\ntrackerToken: ${trackerToken}`,
		details: { action: "start", operation: "create", trackerId, trackerToken, chunkCount: chunks.length },
	};
}

function prepareUpdate(record: Record<string, unknown>, requestId: string): PreparedMutation {
	const trackerId = requireStringField(record, "trackerId", "update");
	const trackerToken = requireStringField(record, "trackerToken", "update");
	const chunkId = requireStringField(record, "chunkId", "update");

	const state = record.state;
	if (!isProgressChunkState(state)) {
		throw new Error(`progress update: \`state\` must be one of ${PROGRESS_CHUNK_STATES.join(", ")}.`);
	}

	const phase = optionalStringField(record, "phase", "update");
	const detail = optionalStringField(record, "detail", "update");

	const payload: ProgressUpdatePayload = {
		requestId,
		trackerId,
		trackerToken,
		owner: PROGRESS_TOOL_OWNER,
		chunkId,
		state,
	};
	// Omission clears the previous value, so only include the keys when given.
	if (phase !== undefined) payload.phase = phase;
	if (detail !== undefined) payload.detail = detail;

	const phaseSuffix = phase !== undefined && phase.length > 0 ? ` (${phase})` : "";
	return {
		action: "update",
		operation: "update",
		channel: HUB_PROGRESS_CHANNELS.update,
		payload,
		visible: `progress update: ${trackerId}/${chunkId} -> ${state}${phaseSuffix}`,
		details: { action: "update", operation: "update", trackerId, trackerToken, chunkId },
	};
}

function prepareFinish(record: Record<string, unknown>, requestId: string): PreparedMutation {
	const trackerId = requireStringField(record, "trackerId", "finish");
	const trackerToken = requireStringField(record, "trackerToken", "finish");

	const outcome = record.outcome;
	if (!isProgressOutcome(outcome)) {
		throw new Error(`progress finish: \`outcome\` must be one of ${PROGRESS_OUTCOMES.join(", ")}.`);
	}

	const summary = optionalStringField(record, "summary", "finish");

	const payload: ProgressFinishPayload = {
		requestId,
		trackerId,
		trackerToken,
		owner: PROGRESS_TOOL_OWNER,
		outcome,
	};
	if (summary !== undefined) payload.summary = summary;

	return {
		action: "finish",
		operation: "finish",
		channel: HUB_PROGRESS_CHANNELS.finish,
		payload,
		visible: `progress finish: ${trackerId} -> ${outcome}`,
		details: { action: "finish", operation: "finish", trackerId, trackerToken },
	};
}

function prepareClear(record: Record<string, unknown>, requestId: string): PreparedMutation {
	const trackerId = requireStringField(record, "trackerId", "clear");
	const trackerToken = requireStringField(record, "trackerToken", "clear");

	const payload: ProgressRemovePayload = {
		requestId,
		trackerId,
		trackerToken,
		owner: PROGRESS_TOOL_OWNER,
	};

	return {
		action: "clear",
		operation: "remove",
		channel: HUB_PROGRESS_CHANNELS.remove,
		payload,
		visible: `progress clear: ${trackerId}`,
		details: { action: "clear", operation: "remove", trackerId, trackerToken },
	};
}

// ---------------------------------------------------------------------------
// Direct hub client
// ---------------------------------------------------------------------------

function isMatchingAck(payload: unknown, requestId: string): payload is HubProgressAckPayload {
	if (typeof payload !== "object" || payload === null) return false;
	const record = payload as Record<string, unknown>;
	return record.requestId === requestId && typeof record.ok === "boolean";
}

/**
 * Emit one mutation and wait for its synchronous acknowledgement.
 *
 * Pi event dispatch is synchronous, so the matching ack arrives during
 * `bus.emit`. The listener is always removed, on success and on every throw.
 * Invalid arguments throw before an event is emitted. A negative ack, or no
 * matching ack at all, throws `Error` so Pi marks the tool call failed.
 */
export async function runProgressAction(
	bus: ProgressToolEventBus,
	params: unknown,
): Promise<ProgressToolResult> {
	const requestId = generateProgressRequestId();
	const mutation = prepareProgressMutation(params, requestId);

	let ack: HubProgressAckPayload | undefined;
	const off = bus.on(HUB_PROGRESS_CHANNELS.ack, (payload) => {
		if (isMatchingAck(payload, requestId)) ack = payload;
	});

	try {
		bus.emit(mutation.channel, mutation.payload);

		if (!ack) throw new Error("progress hub unavailable");
		if (!ack.ok) {
			throw new Error(`progress ${mutation.action} rejected by hub: ${ack.error ?? "unknown error"}`);
		}

		return { content: [{ type: "text", text: mutation.visible }], details: mutation.details };
	} finally {
		off();
	}
}

// ---------------------------------------------------------------------------
// Child relay sender
// ---------------------------------------------------------------------------

interface ProgressChildRelayEnvelope {
	version: 1;
	channel: string;
	payload: Record<string, unknown>;
}

/**
 * Child side of the relay. Validates the same arguments as the direct client,
 * then hands one serialized envelope to the parent over `setStatus`. The local
 * hub is never touched.
 *
 * `setStatus` is fire-and-forget, so the returned text says only that the
 * update was sent: the parent may still reject the transition.
 */
export function runProgressRelay(ui: ProgressChildRelayUi, params: unknown): ProgressToolResult {
	const requestId = generateProgressRequestId();
	const mutation = prepareProgressMutation(params, requestId);

	const envelope: ProgressChildRelayEnvelope = {
		version: 1,
		channel: mutation.channel,
		payload: mutation.payload as unknown as Record<string, unknown>,
	};
	ui.setStatus(PROGRESS_RELAY_STATUS_KEY, JSON.stringify(envelope));

	return {
		content: [
			{
				type: "text",
				text: `${mutation.visible}\nsent to parent (best-effort relay; acceptance not confirmed)`,
			},
		],
		details: mutation.details,
	};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function renderProgressCall(args: ProgressToolInput, theme: Theme): Text {
	const action = typeof args?.action === "string" ? args.action : "progress";
	let text = theme.fg("toolTitle", `${theme.bold("progress")} `);
	text += theme.fg("muted", action);
	if (typeof args?.trackerId === "string" && args.trackerId.length > 0) {
		text += theme.fg("muted", ` ${args.trackerId}`);
	}
	if (typeof args?.chunkId === "string" && args.chunkId.length > 0) {
		text += theme.fg("muted", `/${args.chunkId}`);
	}
	if (typeof args?.state === "string" && args.state.length > 0) {
		text += theme.fg("muted", ` -> ${args.state}`);
	}
	return new Text(text, 0, 0);
}

export function registerProgressTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: PROGRESS_TOOL_NAME,
		label: "Progress",
		description: PROGRESS_TOOL_DESCRIPTION,
		promptSnippet: "Use the progress tool to report semantic plan progress.",
		parameters: ProgressToolParams,
		renderCall(args, theme) {
			return renderProgressCall(args as ProgressToolInput, theme);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (process.env.PI_SUBAGENT_CHILD === "1") {
				return runProgressRelay(ctx.ui, params);
			}
			return await runProgressAction(pi.events, params);
		}
	});
}
