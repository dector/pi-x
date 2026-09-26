import { describe, expect, test } from "bun:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_MODEL_MAPPING,
	SUBAGENT_FUNCTIONS,
	SUBAGENT_LEVELS,
	type AliasResolver,
	loadModelMapping,
	mergeModelMapping,
	parseModelMapping,
	resolveMappedModel,
} from "./model-mapping.ts";

/** A resolver that accepts every target and reports the full thinking scale. */
const permissive: AliasResolver = (targets) =>
	targets[0]
		? {
				model: targets[0],
				supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
			}
		: undefined;

const unavailable: AliasResolver = () => undefined;

describe("resolveMappedModel", () => {
	test("resolves a per-function override cell", () => {
		const result = resolveMappedModel(DEFAULT_MODEL_MAPPING, { function: "review", level: "l" }, undefined, permissive);
		expect(result).toMatchObject({ ok: true, model: "openai-codex/gpt-6-sol", thinkingLevel: "xhigh", level: "l" });
	});

	test("falls through to the general row for a function with no cell at that level", () => {
		const result = resolveMappedModel(DEFAULT_MODEL_MAPPING, { function: "review", level: "m" }, undefined, permissive);
		expect(result).toMatchObject({ ok: true, model: "opencode-go/deepseek-v4.1-flash", thinkingLevel: "high" });
	});

	test("clamps a requested level up to the function floor", () => {
		const result = resolveMappedModel(DEFAULT_MODEL_MAPPING, { function: "review" }, "xs", permissive);
		expect(result).toMatchObject({ ok: true, level: "s", model: "opencode-go/deepseek-v4.1-flash" });
		if (result.ok) expect(result.warnings.join(" ")).toContain("floor");
	});

	test("task level overrides the agent level", () => {
		const result = resolveMappedModel(DEFAULT_MODEL_MAPPING, { function: "scout", level: "xs" }, "off", permissive);
		expect(result).toMatchObject({ ok: true, level: "off", model: "opencode-go/mimo-v2.6-flash" });
	});

	test("falls back to the general row for a function without an override", () => {
		const result = resolveMappedModel(DEFAULT_MODEL_MAPPING, { function: "docs" }, "m", permissive);
		expect(result).toMatchObject({ ok: true, model: "opencode-go/deepseek-v4.1-flash", thinkingLevel: "high" });
	});

	test("uses general with a warning when the agent has no function", () => {
		const result = resolveMappedModel(DEFAULT_MODEL_MAPPING, {}, undefined, permissive);
		expect(result).toMatchObject({ ok: true, function: "general", level: "m" });
		if (result.ok) expect(result.warnings.join(" ")).toContain("general");
	});

	test("warns and clamps when thinking is unsupported by the model", () => {
		const resolver: AliasResolver = (targets) => ({ model: targets[0]!, supportedThinkingLevels: ["off", "low"] });
		const result = resolveMappedModel(DEFAULT_MODEL_MAPPING, { function: "general" }, "m", resolver);
		expect(result).toMatchObject({ ok: true, thinkingLevel: "low" });
		if (result.ok) expect(result.warnings.join(" ")).toContain("clamped");
	});

	test("hard-errors when the alias has no available model", () => {
		const result = resolveMappedModel(DEFAULT_MODEL_MAPPING, { function: "review" }, "m", unavailable);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("no available model");
	});

	test("hard-errors on an unknown alias", () => {
		const mapping = mergeModelMapping(DEFAULT_MODEL_MAPPING, {
			general: { m: { alias: "does-not-exist", thinking: "high" } },
		});
		const result = resolveMappedModel(mapping, { function: "general" }, "m", permissive);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Unknown model alias");
	});

	test("every default function/level pair resolves", () => {
		for (const fn of SUBAGENT_FUNCTIONS) {
			for (const level of SUBAGENT_LEVELS) {
				const fnMapping = DEFAULT_MODEL_MAPPING.functions[fn] ?? {};
				// Levels below the floor are intentionally clamped; skip those.
				if (fnMapping.floor && SUBAGENT_LEVELS.indexOf(level) < SUBAGENT_LEVELS.indexOf(fnMapping.floor)) continue;
				const result = resolveMappedModel(DEFAULT_MODEL_MAPPING, { function: fn }, level, permissive);
				expect(result.ok, `${fn}.${level} should resolve`).toBe(true);
			}
		}
	});

	test("no default cell requests an unsupported thinking level", () => {
		// Mirrors the real model metadata for the models the default matrix uses.
		const supportedByModel: Record<string, readonly ThinkingLevel[]> = {
			"opencode-go/deepseek-v4.1-flash": ["low", "high", "max"],
			"opencode-go/deepseek-v4-pro": ["off", "high", "max"],
			"deepseek/deepseek-v4-pro": ["off", "high", "max"],
			"opencode-go/mimo-v2.6-flash": ["off", "minimal", "low", "medium", "high"],
			"opencode-go/mimo-v2.6-pro": ["off", "minimal", "low", "medium", "high"],
			"openai-codex/gpt-6-sol": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		};
		const resolver: AliasResolver = (targets) => {
			const model = targets[0]!;
			const supported = supportedByModel[model];
			return supported ? { model, supportedThinkingLevels: supported } : undefined;
		};
		for (const fn of SUBAGENT_FUNCTIONS) {
			const fnMapping = DEFAULT_MODEL_MAPPING.functions[fn] ?? {};
			for (const level of SUBAGENT_LEVELS) {
				if (fnMapping.floor && SUBAGENT_LEVELS.indexOf(level) < SUBAGENT_LEVELS.indexOf(fnMapping.floor)) continue;
				const result = resolveMappedModel(DEFAULT_MODEL_MAPPING, { function: fn }, level, resolver);
				expect(result.ok, `${fn}.${level} should resolve`).toBe(true);
				if (result.ok) expect(result.warnings, `${fn}.${level}: ${result.warnings.join("; ")}`).toEqual([]);
			}
		}
	});
});

describe("model mapping config", () => {
	test("parses a partial user mapping and drops malformed cells", () => {
		const parsed = parseModelMapping({
			aliases: { mine: ["p/m", "q/m"], bad: [] },
			general: { m: { alias: "mine", thinking: "high" }, nope: { alias: "x", thinking: "high" } },
			functions: {
				review: { defaultLevel: "l", floor: "m", cells: { l: { alias: "mine", thinking: "max" } } },
				unknown: { defaultLevel: "m" },
			},
		});
		expect(parsed.aliases).toEqual({ mine: ["p/m", "q/m"] });
		expect(parsed.general).toEqual({ m: { alias: "mine", thinking: "high" } });
		expect(parsed.functions?.review).toEqual({
			defaultLevel: "l",
			floor: "m",
			cells: { l: { alias: "mine", thinking: "max" } },
		});
		expect(parsed.functions?.unknown).toBeUndefined();
	});

	test("merges per-cell without restating the whole row", () => {
		const merged = mergeModelMapping(DEFAULT_MODEL_MAPPING, {
			functions: { review: { cells: { l: { alias: "mimo-v2.6-pro", thinking: "high" } } } },
		});
		// Overridden cell changes...
		expect(merged.functions.review?.cells?.l).toEqual({ alias: "mimo-v2.6-pro", thinking: "high" });
		// ...while the base mapping is unchanged and the function defaults survive.
		expect(merged.functions.review?.defaultLevel).toBe("m");
		// The base mapping is not mutated.
		expect(DEFAULT_MODEL_MAPPING.functions.review?.cells?.l).toEqual({ alias: "gpt-6-sol", thinking: "xhigh" });
	});

	test("loadModelMapping returns the default when the file is absent", () => {
		expect(loadModelMapping("/nonexistent/subagent-models.json")).toEqual(DEFAULT_MODEL_MAPPING);
	});
});
