/**
 * Function/level model mapping.
 *
 * Subagent profiles no longer hardcode a model. Instead an agent declares a
 * `function` (the kind of work) and a default `level` (how much effort), and
 * this module resolves `(function, level)` to a concrete model alias plus a
 * thinking level.
 *
 * The resolution is deliberately split in two:
 *
 *   - the pure selection of a matrix cell (`resolveMappedModel`) is testable
 *     without the Pi runtime;
 *   - making an alias concrete (provider scheduling, availability, thinking
 *     clamping) is injected as `resolveAlias`, because it needs the live model
 *     registry.
 *
 * A built-in default mapping ships with the extension. A user file
 * (`~/.pi/agent/subagent-models.json`) is deep-merged on top, so a user can
 * override a single cell without restating the matrix.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";

/** The closed set of work kinds. `general` is the fallback for unknown agents. */
export const SUBAGENT_FUNCTIONS = [
	"scout",
	"plan",
	"research",
	"work",
	"review",
	"test",
	"docs",
	"debug",
	"general",
] as const;
export type SubagentFunction = (typeof SUBAGENT_FUNCTIONS)[number];

/** The ordered universal effort scale. */
export const SUBAGENT_LEVELS = ["off", "xxxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl"] as const;
export type SubagentLevel = (typeof SUBAGENT_LEVELS)[number];

/** Default level used when neither the agent nor the function declares one. */
export const DEFAULT_LEVEL: SubagentLevel = "m";

/** One matrix cell: an alias plus the thinking level used with it. */
export interface MappingCell {
	alias: string;
	thinking: ThinkingLevel;
}

export type MappingRow = Partial<Record<SubagentLevel, MappingCell>>;

export interface FunctionMapping {
	/** Level used when neither a task nor the agent specifies one. */
	defaultLevel?: SubagentLevel;
	/** Lowest level this function will run at; a lower request is clamped up. */
	floor?: SubagentLevel;
	/** Sparse per-level overrides of the `general` row. */
	cells?: MappingRow;
}

export interface ModelMapping {
	/** Versioned alias identity to ordered provider/model targets. */
	aliases: Record<string, string[]>;
	/** Base row every function falls back to. */
	general: MappingRow;
	/** Per-function entry points and sparse cell overrides. */
	functions: Record<string, FunctionMapping>;
}

const FUNCTION_SET = new Set<string>(SUBAGENT_FUNCTIONS);
const LEVEL_RANK = new Map<SubagentLevel, number>(SUBAGENT_LEVELS.map((level, index) => [level, index]));
const THINKING_SET = new Set<string>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export function isSubagentFunction(value: unknown): value is SubagentFunction {
	return typeof value === "string" && FUNCTION_SET.has(value);
}

export function isSubagentLevel(value: unknown): value is SubagentLevel {
	return typeof value === "string" && LEVEL_RANK.has(value as SubagentLevel);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_SET.has(value);
}

/** Position of a level on the universal scale; higher means more effort. */
export function levelRank(level: SubagentLevel): number {
	return LEVEL_RANK.get(level) ?? 0;
}

/**
 * The built-in default mapping. Kept as data so tests and users can inspect it.
 *
 * Deepseek owns the low/mid rungs and `sol` is reserved for the hardest
 * levels; `mimo`/`luna`/`terra`/`space-bunny-free` ship as aliases for
 * per-function overrides and user config.
 */
export const DEFAULT_MODEL_MAPPING: ModelMapping = {
	aliases: {
		"deepseek-v4.1-flash": ["opencode-go/deepseek-v4.1-flash"],
		"deepseek-v4-pro": ["opencode-go/deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
		"mimo-v2.6-flash": ["opencode-go/mimo-v2.6-flash"],
		"mimo-v2.6-pro": ["opencode-go/mimo-v2.6-pro"],
		"gpt-6-luna": ["openai-codex/gpt-6-luna"],
		"gpt-6-sol": ["openai-codex/gpt-6-sol"],
		"gpt-5.6-terra": ["openai-codex/gpt-5.6-terra"],
		"space-bunny-free": ["opencode-go/space-bunny-free"],
	},
	general: {
		off: { alias: "deepseek-v4.1-flash", thinking: "low" },
		xxxs: { alias: "deepseek-v4.1-flash", thinking: "low" },
		xs: { alias: "deepseek-v4.1-flash", thinking: "low" },
		s: { alias: "deepseek-v4.1-flash", thinking: "low" },
		m: { alias: "deepseek-v4.1-flash", thinking: "high" },
		l: { alias: "deepseek-v4.1-flash", thinking: "max" },
		xl: { alias: "gpt-6-sol", thinking: "high" },
		xxl: { alias: "gpt-6-sol", thinking: "xhigh" },
		xxxl: { alias: "gpt-6-sol", thinking: "max" },
	},
	functions: {
		scout: {
			defaultLevel: "xs",
			floor: "off",
			cells: {
				off: { alias: "mimo-v2.6-flash", thinking: "low" },
				xs: { alias: "mimo-v2.6-flash", thinking: "low" },
			},
		},
		plan: { defaultLevel: "m", floor: "s" },
		research: {
			defaultLevel: "m",
			floor: "s",
			cells: {
				m: { alias: "deepseek-v4-pro", thinking: "high" },
				l: { alias: "deepseek-v4-pro", thinking: "max" },
			},
		},
		work: { defaultLevel: "m", floor: "xs" },
		review: {
			defaultLevel: "m",
			floor: "s",
			cells: {
				l: { alias: "gpt-6-sol", thinking: "xhigh" },
			},
		},
		test: { defaultLevel: "s", floor: "xs" },
		docs: {
			defaultLevel: "s",
			floor: "off",
			cells: {
				off: { alias: "mimo-v2.6-flash", thinking: "low" },
				s: { alias: "mimo-v2.6-flash", thinking: "low" },
			},
		},
		debug: {
			defaultLevel: "m",
			floor: "s",
			cells: {
				l: { alias: "gpt-6-sol", thinking: "high" },
			},
		},
		general: { defaultLevel: "m", floor: "off" },
	},
};

/** A concrete model selected for an alias. */
export interface ResolvedAliasTarget {
	/** Canonical `provider/id` string passed to the child. */
	model: string;
	/** Thinking levels the target actually supports, for clamping. */
	supportedThinkingLevels: readonly ThinkingLevel[];
}

/** Pick the first available target for an alias. Injected: needs the registry. */
export type AliasResolver = (targets: readonly string[]) => ResolvedAliasTarget | undefined;

export type MappedModelResolution =
	| {
			ok: true;
			function: SubagentFunction;
			level: SubagentLevel;
			alias: string;
			model: string;
			thinkingLevel: ThinkingLevel;
			warnings: string[];
	  }
	| { ok: false; error: string; warnings: string[] };

/** Clamp a requested thinking level to the target's supported levels. */
function clampThinking(
	requested: ThinkingLevel,
	supported: readonly ThinkingLevel[],
): { level: ThinkingLevel; clamped: boolean } {
	if (supported.length === 0 || supported.includes(requested)) return { level: requested, clamped: false };
	const requestedRank = THINKING_ORDER.indexOf(requested);
	// Prefer the highest supported level at or below the request; otherwise the
	// lowest supported level. This mirrors how Pi degrades an unsupported effort.
	let best: ThinkingLevel | undefined;
	for (const candidate of supported) {
		const rank = THINKING_ORDER.indexOf(candidate);
		if (rank <= requestedRank && (best === undefined || rank > THINKING_ORDER.indexOf(best))) best = candidate;
	}
	return { level: best ?? supported[0]!, clamped: true };
}

const THINKING_ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Resolve the effective model and thinking level for one dispatch item.
 *
 * Order: task level → agent level → function default → global default, then a
 * floor clamp, then the function cell, then the `general` row. Missing or
 * unknown functions degrade to `general` with a warning rather than failing.
 */
export function resolveMappedModel(
	mapping: ModelMapping,
	agent: { function?: SubagentFunction; level?: SubagentLevel },
	taskLevel: SubagentLevel | undefined,
	resolveAlias: AliasResolver,
): MappedModelResolution {
	const warnings: string[] = [];

	const fn: SubagentFunction = agent.function ?? "general";
	if (!agent.function) warnings.push("Agent has no `function`; using `general`.");
	const fnMapping = mapping.functions[fn] ?? {};

	let level: SubagentLevel = taskLevel ?? agent.level ?? fnMapping.defaultLevel ?? DEFAULT_LEVEL;
	if (fnMapping.floor && levelRank(level) < levelRank(fnMapping.floor)) {
		warnings.push(`Level \`${level}\` raised to \`${fnMapping.floor}\` (floor for \`${fn}\`).`);
		level = fnMapping.floor;
	}

	const cell = fnMapping.cells?.[level] ?? mapping.general[level];
	if (!cell) {
		return { ok: false, error: `No mapping cell for \`${fn}.${level}\` and no \`general.${level}\` fallback.`, warnings };
	}

	const targets = mapping.aliases[cell.alias];
	if (!targets || targets.length === 0) {
		return { ok: false, error: `Unknown model alias \`${cell.alias}\` (from \`${fn}.${level}\`).`, warnings };
	}

	const target = resolveAlias(targets);
	if (!target) {
		return {
			ok: false,
			error: `Model alias \`${cell.alias}\` has no available model (tried: ${targets.join(", ")}).`,
			warnings,
		};
	}

	const clamped = clampThinking(cell.thinking, target.supportedThinkingLevels);
	if (clamped.clamped) {
		warnings.push(
			`Thinking \`${cell.thinking}\` is not supported by \`${target.model}\`; clamped to \`${clamped.level}\`.`,
		);
	}

	return {
		ok: true,
		function: fn,
		level,
		alias: cell.alias,
		model: target.model,
		thinkingLevel: clamped.level,
		warnings,
	};
}

/** Read one cell from an untrusted value. Returns `undefined` when malformed. */
function parseCell(value: unknown): MappingCell | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as { alias?: unknown; thinking?: unknown };
	if (typeof record.alias !== "string" || record.alias.trim().length === 0) return undefined;
	if (!isThinkingLevel(record.thinking)) return undefined;
	return { alias: record.alias.trim(), thinking: record.thinking };
}

function parseRow(value: unknown): MappingRow {
	const row: MappingRow = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return row;
	for (const [key, cell] of Object.entries(value as Record<string, unknown>)) {
		if (!isSubagentLevel(key)) continue;
		const parsed = parseCell(cell);
		if (parsed) row[key] = parsed;
	}
	return row;
}

/**
 * Parse a user mapping file. Unknown fields are ignored and malformed cells are
 * dropped rather than throwing, so one typo cannot disable the whole override.
 */
export function parseModelMapping(value: unknown): Partial<ModelMapping> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const record = value as { aliases?: unknown; general?: unknown; functions?: unknown };
	const result: Partial<ModelMapping> = {};

	if (record.aliases && typeof record.aliases === "object" && !Array.isArray(record.aliases)) {
		const aliases: Record<string, string[]> = {};
		for (const [alias, targets] of Object.entries(record.aliases as Record<string, unknown>)) {
			const list = (Array.isArray(targets) ? targets : typeof targets === "string" ? [targets] : [])
				.filter((target): target is string => typeof target === "string")
				.map((target) => target.trim())
				.filter(Boolean);
			if (list.length > 0) aliases[alias] = list;
		}
		result.aliases = aliases;
	}

	if (record.general !== undefined) result.general = parseRow(record.general);

	if (record.functions && typeof record.functions === "object" && !Array.isArray(record.functions)) {
		const functions: Record<string, FunctionMapping> = {};
		for (const [name, raw] of Object.entries(record.functions as Record<string, unknown>)) {
			if (!isSubagentFunction(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
			const entry = raw as { defaultLevel?: unknown; floor?: unknown; cells?: unknown };
			const parsed: FunctionMapping = {};
			if (isSubagentLevel(entry.defaultLevel)) parsed.defaultLevel = entry.defaultLevel;
			if (isSubagentLevel(entry.floor)) parsed.floor = entry.floor;
			if (entry.cells !== undefined) parsed.cells = parseRow(entry.cells);
			functions[name] = parsed;
		}
		result.functions = functions;
	}

	return result;
}

/** Deep-merge a user override over a base mapping without mutating either. */
export function mergeModelMapping(base: ModelMapping, override: Partial<ModelMapping>): ModelMapping {
	const merged: ModelMapping = {
		aliases: { ...base.aliases },
		general: { ...base.general },
		functions: {},
	};

	for (const [alias, targets] of Object.entries(override.aliases ?? {})) {
		if (targets.length > 0) merged.aliases[alias] = [...targets];
	}
	for (const [level, cell] of Object.entries(override.general ?? {})) {
		if (cell) merged.general[level as SubagentLevel] = cell;
	}
	for (const [name, fn] of Object.entries(base.functions)) {
		merged.functions[name] = { ...fn, ...(fn.cells ? { cells: { ...fn.cells } } : {}) };
	}
	for (const [name, fn] of Object.entries(override.functions ?? {})) {
		const existing = merged.functions[name] ?? {};
		merged.functions[name] = {
			...existing,
			...(fn.defaultLevel !== undefined ? { defaultLevel: fn.defaultLevel } : {}),
			...(fn.floor !== undefined ? { floor: fn.floor } : {}),
			...(fn.cells !== undefined ? { cells: { ...existing.cells, ...fn.cells } } : {}),
		};
	}

	return merged;
}

export function modelMappingPath(agentDir: string): string {
	return path.join(agentDir, "subagent-models.json");
}

/**
 * Load and merge the user mapping file over the built-in default. A missing
 * file yields the default; a malformed file throws so the caller can decide
 * whether to warn and continue with the default.
 */
export function loadModelMapping(filePath: string, base: ModelMapping = DEFAULT_MODEL_MAPPING): ModelMapping {
	if (!fs.existsSync(filePath)) return base;
	const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
	return mergeModelMapping(base, parseModelMapping(parsed));
}
