import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const THINKING_MODES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingMode = (typeof THINKING_MODES)[number];

export interface SwitchThinkingGlobalStateV1 {
	version: 1;
	favorites: ThinkingMode[];
}

export const GLOBAL_STATE_PATH = join(homedir(), ".pi", "agent", "space.dector-switch-thinking.json");

const DEFAULT_STATE: SwitchThinkingGlobalStateV1 = {
	version: 1,
	favorites: [],
};

function isThinkingMode(value: unknown): value is ThinkingMode {
	return typeof value === "string" && (THINKING_MODES as readonly string[]).includes(value);
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function uniqueModes(modes: ThinkingMode[]): ThinkingMode[] {
	const seen = new Set<ThinkingMode>();
	const out: ThinkingMode[] = [];
	for (const mode of modes) {
		if (seen.has(mode)) continue;
		seen.add(mode);
		out.push(mode);
	}
	return out;
}

export function sanitizeState(input: unknown): SwitchThinkingGlobalStateV1 {
	if (!input || typeof input !== "object") return { ...DEFAULT_STATE };

	const raw = input as Partial<SwitchThinkingGlobalStateV1>;
	const favorites = Array.isArray(raw.favorites)
		? uniqueModes(raw.favorites.filter((value): value is ThinkingMode => isThinkingMode(value)))
		: [];

	return {
		version: 1,
		favorites,
	};
}

export function loadGlobalState(): { state: SwitchThinkingGlobalStateV1; error?: string } {
	try {
		const content = readFileSync(GLOBAL_STATE_PATH, "utf-8");
		const parsed = JSON.parse(content);
		return { state: sanitizeState(parsed) };
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError?.code === "ENOENT") {
			return { state: { ...DEFAULT_STATE } };
		}

		return {
			state: { ...DEFAULT_STATE },
			error: `Failed to load ${GLOBAL_STATE_PATH}: ${toErrorMessage(error)}`,
		};
	}
}

export function saveGlobalState(state: SwitchThinkingGlobalStateV1): { ok: true } | { ok: false; error: string } {
	let tempPath = "";
	try {
		const sanitized = sanitizeState(state);
		mkdirSync(dirname(GLOBAL_STATE_PATH), { recursive: true });
		tempPath = `${GLOBAL_STATE_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		writeFileSync(tempPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf-8");
		renameSync(tempPath, GLOBAL_STATE_PATH);
		return { ok: true };
	} catch (error) {
		if (tempPath) {
			try {
				rmSync(tempPath, { force: true });
			} catch {
				// Ignore cleanup error.
			}
		}
		return {
			ok: false,
			error: `Failed to save ${GLOBAL_STATE_PATH}: ${toErrorMessage(error)}`,
		};
	}
}
