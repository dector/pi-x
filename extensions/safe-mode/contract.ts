import { parseSafeMode, type SafeMode } from "./policy.ts";

export const SAFE_MODE_STATE_EVENTS = {
	request: "px:safe-mode:state:request",
	response: "px:safe-mode:state:response",
	set: "px:safe-mode:state:set",
	changed: "px:safe-mode:state:changed",
} as const;

// Emitted only after safe-mode reaches a final `allow` (provider allow or a
// successful user approval) for a tool call. Capability consumers use it as a
// one-time execution handoff keyed by `toolCallId`. Blocked, denied, non-UI,
// timed-out, or changed calls never produce it.
export const TOOL_AUTHORIZED_EVENT = "px:safe-mode:tool-authorized";

export interface ToolAuthorized {
	toolCallId: string;
	toolName: string;
	source?: string;
}

export interface SafeModeSnapshot {
	mode: SafeMode;
	outerAccess: boolean;
}

export interface SafeModeStateRequest {
	id: string;
}

export interface SafeModeStateResponse {
	id: string;
	state: SafeModeSnapshot;
}

export interface SafeModeStateSet {
	state: SafeModeSnapshot;
	source?: string;
}

export interface SafeModeStateChanged extends SafeModeSnapshot {
	source?: string;
}

const MAX_ID_LENGTH = 256;
const MAX_SOURCE_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export function parseSafeModeSnapshot(value: unknown): SafeModeSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	const mode = parseSafeMode(value.mode);
	if (!mode || typeof value.outerAccess !== "boolean") return undefined;
	return { mode, outerAccess: value.outerAccess };
}

export function parseSafeModeStateRequest(value: unknown): SafeModeStateRequest | undefined {
	if (!isRecord(value) || !isBoundedString(value.id, MAX_ID_LENGTH)) return undefined;
	return { id: value.id };
}

export function parseSafeModeStateResponse(value: unknown): SafeModeStateResponse | undefined {
	if (!isRecord(value) || !isBoundedString(value.id, MAX_ID_LENGTH)) return undefined;
	const state = parseSafeModeSnapshot(value.state);
	return state ? { id: value.id, state } : undefined;
}

export function parseSafeModeStateSet(value: unknown): SafeModeStateSet | undefined {
	if (!isRecord(value)) return undefined;
	const state = parseSafeModeSnapshot(value.state);
	if (!state || (value.source !== undefined && !isBoundedString(value.source, MAX_SOURCE_LENGTH))) return undefined;
	return { state, source: value.source as string | undefined };
}

const MAX_TOOL_CALL_ID_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 64;

/** Narrow validation for the one-time tool authorization handoff. */
export function parseToolAuthorized(value: unknown): ToolAuthorized | undefined {
	if (!isRecord(value)) return undefined;
	if (!isBoundedString(value.toolCallId, MAX_TOOL_CALL_ID_LENGTH)) return undefined;
	if (!isBoundedString(value.toolName, MAX_TOOL_NAME_LENGTH)) return undefined;
	if (value.source !== undefined && !isBoundedString(value.source, MAX_SOURCE_LENGTH)) return undefined;
	return { toolCallId: value.toolCallId, toolName: value.toolName, source: value.source as string | undefined };
}
