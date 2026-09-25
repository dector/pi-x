import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_BIAS, DEFAULT_WIDTH, clampBias, clampWidth } from "./viewport";

export interface NarrowStateV1 {
	version: 1;
	enabled: boolean;
	width: number;
	/** Percent of the leftover space to slide the column sideways. */
	bias: number;
}

/**
 * Where the preference lives.
 *
 * `PI_NARROW_STATE_PATH` exists so tests (and parallel setups) can redirect it.
 * It is read per call, not at import time, so a late override still applies.
 */
export function globalStatePath(): string {
	return process.env.PI_NARROW_STATE_PATH ?? join(homedir(), ".pi", "agent", "space.dector-narrow.json");
}

/** Narrow reading column is on by default; it is a no-op on a narrow screen. */
const DEFAULT_STATE: NarrowStateV1 = {
	version: 1,
	enabled: true,
	width: DEFAULT_WIDTH,
	bias: DEFAULT_BIAS,
};

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function sanitizeState(input: unknown): NarrowStateV1 {
	if (!input || typeof input !== "object") return { ...DEFAULT_STATE };

	const raw = input as Partial<NarrowStateV1>;
	return {
		version: 1,
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_STATE.enabled,
		width: typeof raw.width === "number" ? clampWidth(raw.width) : DEFAULT_STATE.width,
		bias: typeof raw.bias === "number" ? clampBias(raw.bias) : DEFAULT_STATE.bias,
	};
}

export function loadGlobalState(path: string = globalStatePath()): { state: NarrowStateV1; error?: string } {
	try {
		return { state: sanitizeState(JSON.parse(readFileSync(path, "utf-8"))) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { state: { ...DEFAULT_STATE } };
		return { state: { ...DEFAULT_STATE }, error: `Failed to load ${path}: ${toErrorMessage(error)}` };
	}
}

export function saveGlobalState(state: NarrowStateV1, path: string = globalStatePath()): { ok: true } | { ok: false; error: string } {
	let tempPath = "";
	try {
		const sanitized = sanitizeState(state);
		mkdirSync(dirname(path), { recursive: true });
		tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		writeFileSync(tempPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf-8");
		renameSync(tempPath, path);
		return { ok: true };
	} catch (error) {
		if (tempPath) {
			try {
				rmSync(tempPath, { force: true });
			} catch {
				// Ignore cleanup error.
			}
		}
		return { ok: false, error: `Failed to save ${path}: ${toErrorMessage(error)}` };
	}
}
