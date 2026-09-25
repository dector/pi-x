import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_BIAS, DEFAULT_WIDTH, clampBias, clampWidth } from "./viewport";

export interface FocusModeStateV1 {
	version: 1;
	enabled: boolean;
	width: number;
	/** Percent of the leftover space to slide the column sideways. */
	bias: number;
}

const STATE_FILE = "space.dector-focus-mode.json";
/** The name this extension had before the rename. */
const LEGACY_STATE_FILE = "space.dector-narrow.json";

/** Where the preference lives. */
export function globalStatePath(): string {
	return process.env.PI_FOCUS_MODE_STATE_PATH ?? defaultStatePath(STATE_FILE);
}

function defaultStatePath(name: string): string {
	return join(homedir(), ".pi", "agent", name);
}

/**
 * The pre-rename path, next to the current one: a redirect points at a
 * directory, so the old name in that same directory is the one to look for.
 */
function legacyStatePath(): string {
	const override = process.env.PI_FOCUS_MODE_STATE_PATH;
	return override ? join(dirname(override), LEGACY_STATE_FILE) : defaultStatePath(LEGACY_STATE_FILE);
}

/** Focus mode reading column is on by default; it is a no-op on a narrow screen. */
const DEFAULT_STATE: FocusModeStateV1 = {
	version: 1,
	enabled: true,
	width: DEFAULT_WIDTH,
	bias: DEFAULT_BIAS,
};

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function sanitizeState(input: unknown): FocusModeStateV1 {
	if (!input || typeof input !== "object") return { ...DEFAULT_STATE };

	const raw = input as Partial<FocusModeStateV1>;
	return {
		version: 1,
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_STATE.enabled,
		width: typeof raw.width === "number" ? clampWidth(raw.width) : DEFAULT_STATE.width,
		bias: typeof raw.bias === "number" ? clampBias(raw.bias) : DEFAULT_STATE.bias,
	};
}

export function loadGlobalState(path?: string): { state: FocusModeStateV1; error?: string } {
	// A caller that names a path wants that path, not a migration next door.
	const target = path ?? globalStatePath();
	try {
		return { state: sanitizeState(JSON.parse(readFileSync(target, "utf-8"))) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			return { state: { ...DEFAULT_STATE }, error: `Failed to load ${target}: ${toErrorMessage(error)}` };
		}
		// Nothing at the new name yet. A `narrow` file from before the rename
		// is still the user's answer, so carry it over instead of resetting.
		const legacy = path === undefined ? migrateLegacyState(target) : undefined;
		return legacy ? { state: legacy.state, ...(legacy.error ? { error: legacy.error } : {}) } : { state: { ...DEFAULT_STATE } };
	}
}

/** Copy a pre-rename state file to the new name. Best effort. */
function migrateLegacyState(path: string): { state: FocusModeStateV1; error?: string } | undefined {
	const legacy = legacyStatePath();
	if (path === legacy || !existsSync(legacy)) return undefined;

	const { state, error: loadError } = loadGlobalState(legacy);
	const saved = saveGlobalState(state, path);
	return { state, error: loadError ?? (saved.ok ? undefined : saved.error) };
}

export function saveGlobalState(state: FocusModeStateV1, path: string = globalStatePath()): { ok: true } | { ok: false; error: string } {
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
