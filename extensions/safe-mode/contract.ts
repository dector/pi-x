import { parseSafeMode, type SafeMode } from "./policy.ts";

export const SAFE_MODE_STATE_EVENTS = {
	request: "px:safe-mode:state:request",
	response: "px:safe-mode:state:response",
	set: "px:safe-mode:state:set",
	changed: "px:safe-mode:state:changed",
} as const;

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
