import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	REWIRE_INHERIT_ALL_LABEL,
	REWIRE_INHERIT_ALL_MODEL,
	REWIRE_INHERIT_MODEL,
	REWIRE_INHERIT_MODEL_LABEL,
	THINKING_LEVELS,
} from "./rewire.ts";

export interface RewirePreset {
	model: string;
	thinkingLevel: ThinkingLevel;
	/** Persisted marker for the most recently applied preset. */
	lastUsed?: true;
}

/** Built-in, non-persisted preset that follows the parent model. */
export const INHERIT_MODEL_REWIRE_PRESET: RewirePreset = Object.freeze({
	model: REWIRE_INHERIT_MODEL,
	thinkingLevel: "off",
});

/** Built-in, non-persisted preset that follows the parent model and effort. */
export const INHERIT_ALL_REWIRE_PRESET: RewirePreset = Object.freeze({
	model: REWIRE_INHERIT_ALL_MODEL,
	thinkingLevel: "off",
});

/** Backwards-compatible alias for the original built-in model preset. */
export const INHERIT_REWIRE_PRESET = INHERIT_MODEL_REWIRE_PRESET;

const THINKING_LEVEL_SET = new Set<ThinkingLevel>(THINKING_LEVELS);

/** Whether a preset represents either built-in inherited target. */
export function isInheritRewirePreset(value: Pick<RewirePreset, "model"> | undefined): boolean {
	if (typeof value?.model !== "string") return false;
	const model = value.model.trim().toLowerCase();
	return model === REWIRE_INHERIT_MODEL || model === REWIRE_INHERIT_ALL_MODEL;
}

/** Whether a preset represents the Inherit All target. */
export function isInheritAllRewirePreset(value: Pick<RewirePreset, "model"> | undefined): boolean {
	return typeof value?.model === "string" && value.model.trim().toLowerCase() === REWIRE_INHERIT_ALL_MODEL;
}

/** Return the UI preset list with the two locked Inherit entries always first. */
export function withInheritRewirePreset(presets: readonly RewirePreset[]): RewirePreset[] {
	return [
		INHERIT_MODEL_REWIRE_PRESET,
		INHERIT_ALL_REWIRE_PRESET,
		...presets.filter((preset) => !isInheritRewirePreset(preset)),
	];
}

export function rewirePresetsPath(agentDir: string): string {
	return path.join(agentDir, "subagent-rewire-presets.json");
}

export function isRewirePreset(value: unknown): value is RewirePreset {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { model?: unknown; thinkingLevel?: unknown; lastUsed?: unknown };
	return (
		typeof candidate.model === "string" &&
		candidate.model.trim().length > 0 &&
		typeof candidate.thinkingLevel === "string" &&
		THINKING_LEVEL_SET.has(candidate.thinkingLevel as ThinkingLevel)
	);
}

/** Read valid user presets in file order. Missing files produce an empty list. */
export function loadRewirePresets(filePath: string): RewirePreset[] {
	if (!fs.existsSync(filePath)) return [];
	const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (!Array.isArray(parsed)) throw new Error("Expected a JSON array.");
	const presets: RewirePreset[] = [];
	for (const value of parsed) {
		if (!isRewirePreset(value)) continue;
		const preset: RewirePreset = {
			model: value.model.trim(),
			thinkingLevel: value.thinkingLevel,
			...(value.lastUsed === true ? { lastUsed: true } : {}),
		};
		// Inherit entries are built-in UI entries, never user data. Ignore
		// hand-edited copies so they cannot become removable or reorder the list.
		if (isInheritRewirePreset(preset)) continue;
		const existing = presets.find(
			(candidate) => candidate.model === preset.model && candidate.thinkingLevel === preset.thinkingLevel,
		);
		if (!existing) presets.push(preset);
		else if (preset.lastUsed) existing.lastUsed = true;
	}
	const marked = presets.flatMap((preset, index) => (preset.lastUsed ? [index] : []));
	for (const index of marked.slice(0, -1)) {
		const preset = presets[index];
		if (preset) delete preset.lastUsed;
	}
	return presets;
}

/** Write presets atomically so an interrupted save does not truncate the config. */
export function saveRewirePresets(filePath: string, presets: readonly RewirePreset[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	// Never persist the locked built-in entry, even if a caller passes the UI
	// list back to the storage layer.
	const stored = presets.filter((preset) => !isInheritRewirePreset(preset));
	try {
		fs.writeFileSync(tempPath, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(tempPath, filePath);
	} finally {
		if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
	}
}

export function addRewirePreset(presets: readonly RewirePreset[], preset: RewirePreset): RewirePreset[] {
	if (isInheritRewirePreset(preset)) return [...presets];
	if (presets.some((candidate) => candidate.model === preset.model && candidate.thinkingLevel === preset.thinkingLevel)) {
		return [...presets];
	}
	return [...presets, { ...preset }];
}

export function deleteRewirePreset(presets: readonly RewirePreset[], index: number): RewirePreset[] {
	if (isInheritRewirePreset(presets[index])) return [...presets];
	return presets.filter((_preset, presetIndex) => presetIndex !== index);
}

export function markRewirePresetUsed(
	presets: readonly RewirePreset[],
	used: Pick<RewirePreset, "model" | "thinkingLevel">,
): RewirePreset[] {
	if (isInheritRewirePreset(used)) return presets.map((preset) => ({ ...preset }));
	const hasUsed = presets.some(
		(preset) => preset.model === used.model && preset.thinkingLevel === used.thinkingLevel,
	);
	if (!hasUsed) return presets.map((preset) => ({ ...preset }));
	return presets.map((preset) => {
		const { lastUsed: _lastUsed, ...value } = preset;
		return {
			...value,
			...(preset.model === used.model && preset.thinkingLevel === used.thinkingLevel ? { lastUsed: true as const } : {}),
		};
	});
}

export function latestUsedRewirePreset(presets: readonly RewirePreset[]): RewirePreset | undefined {
	return presets.find((preset) => !isInheritRewirePreset(preset) && preset.lastUsed === true);
}

export function formatRewirePreset(preset: RewirePreset): string {
	if (isInheritAllRewirePreset(preset)) return REWIRE_INHERIT_ALL_LABEL;
	if (isInheritRewirePreset(preset)) return REWIRE_INHERIT_MODEL_LABEL;
	return `${preset.model} · ${preset.thinkingLevel}`;
}
