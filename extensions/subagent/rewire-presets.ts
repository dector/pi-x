import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { THINKING_LEVELS } from "./rewire.ts";

export interface RewirePreset {
	model: string;
	thinkingLevel: ThinkingLevel;
	/** Persisted marker for the most recently applied preset. */
	lastUsed?: true;
}

const THINKING_LEVEL_SET = new Set<ThinkingLevel>(THINKING_LEVELS);

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

/** Read valid presets in file order. Missing files produce an empty list. */
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
	try {
		fs.writeFileSync(tempPath, `${JSON.stringify(presets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(tempPath, filePath);
	} finally {
		if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
	}
}

export function addRewirePreset(presets: readonly RewirePreset[], preset: RewirePreset): RewirePreset[] {
	if (presets.some((candidate) => candidate.model === preset.model && candidate.thinkingLevel === preset.thinkingLevel)) {
		return [...presets];
	}
	return [...presets, { ...preset }];
}

export function deleteRewirePreset(presets: readonly RewirePreset[], index: number): RewirePreset[] {
	return presets.filter((_preset, presetIndex) => presetIndex !== index);
}

export function markRewirePresetUsed(
	presets: readonly RewirePreset[],
	used: Pick<RewirePreset, "model" | "thinkingLevel">,
): RewirePreset[] {
	const hasUsed = presets.some(
		(preset) => preset.model === used.model && preset.thinkingLevel === used.thinkingLevel,
	);
	if (!hasUsed) return presets.map((preset) => ({ ...preset }));
	return presets.map((preset) => ({
		model: preset.model,
		thinkingLevel: preset.thinkingLevel,
		...(preset.model === used.model && preset.thinkingLevel === used.thinkingLevel ? { lastUsed: true as const } : {}),
	}));
}

export function latestUsedRewirePreset(presets: readonly RewirePreset[]): RewirePreset | undefined {
	return presets.find((preset) => preset.lastUsed === true);
}

export function formatRewirePreset(preset: RewirePreset): string {
	return `${preset.model} · ${preset.thinkingLevel}`;
}
