import { describe, expect, test } from "bun:test";
import { availableThinkingLevels, isInheritedRewire, isInheritAllRewire, resolveSubagentModel } from "./rewire.ts";

describe("subagent rewiring", () => {
	test("preserves agent model and effort while rewiring is disabled", () => {
		expect(
			resolveSubagentModel(
				{ model: "agent/model", thinking: "high" },
				{ model: "parent/model", thinkingLevel: "low" },
				{ enabled: false, model: "override/model", thinkingLevel: "minimal" },
			),
		).toEqual({ model: "agent/model", thinkingLevel: "high" });
	});

	test("overrides every agent profile while rewiring is enabled", () => {
		expect(
			resolveSubagentModel(
				{ model: "agent/model", thinking: "high" },
				{ model: "parent/model", thinkingLevel: "low" },
				{ enabled: true, model: "override/model", thinkingLevel: "minimal" },
			),
		).toEqual({ model: "override/model", thinkingLevel: "minimal" });
	});

	test("keeps the existing inheritance behavior without a rewire", () => {
		expect(resolveSubagentModel({}, { model: "parent/model", thinkingLevel: "low" })).toEqual({
			model: "parent/model",
			thinkingLevel: "low",
		});
		expect(resolveSubagentModel({ model: "agent/model" }, { thinkingLevel: "high" })).toEqual({
			model: "agent/model",
			thinkingLevel: undefined,
		});
	});

	test("resolves an inherited rewire from the model current at child start", () => {
		const rewire = { enabled: true, model: "parent/fallback", thinkingLevel: "minimal", inherit: true } as const;
		expect(
			resolveSubagentModel(
				{ model: "agent/model", thinking: "high" },
				{ model: "parent/dispatch", thinkingLevel: "low" },
				rewire,
				{ model: "parent/current", thinkingLevel: "high" },
			),
		).toEqual({ model: "parent/current", thinkingLevel: "minimal" });
	});

	test("Inherit All follows the parent effort and takes priority over model-only inheritance", () => {
		const rewire = {
			enabled: true,
			model: "parent/fallback",
			thinkingLevel: "minimal",
			inherit: true,
			inheritAll: true,
		} as const;
		expect(isInheritAllRewire(rewire)).toBe(true);
		expect(
			resolveSubagentModel(
				{ model: "agent/model", thinking: "high" },
				{ model: "parent/dispatch", thinkingLevel: "low" },
				rewire,
				{ model: "parent/current", thinkingLevel: "high" },
			),
		).toEqual({ model: "parent/current", thinkingLevel: "high" });
	});

	test("recognizes the compact inherit sentinel and leaves fixed rewires unchanged", () => {
		expect(isInheritedRewire({ model: " inherit " })).toBe(true);
		expect(isInheritedRewire({ model: "inherit-all" })).toBe(true);
		expect(isInheritedRewire({ model: "inherit", inherit: false })).toBe(false);
		expect(
			resolveSubagentModel(
				{},
				{ model: "parent/dispatch" },
				{ enabled: true, model: "inherit", thinkingLevel: "off", inherit: false },
			),
		).toEqual({ model: undefined, thinkingLevel: "off" });
		expect(
			resolveSubagentModel(
				{},
				{ model: "parent/dispatch" },
				{ enabled: true, model: "inherit", thinkingLevel: "off" },
				{ model: "parent/current" },
			),
		).toEqual({ model: "parent/current", thinkingLevel: "off" });
		expect(isInheritedRewire({ model: "provider/model" })).toBe(false);
		expect(
			resolveSubagentModel(
				{},
				{},
				{ enabled: true, model: "parent/fallback", thinkingLevel: "off", inherit: true },
				{},
			),
		).toEqual({ model: "parent/fallback", thinkingLevel: "off" });
		expect(
			resolveSubagentModel(
				{},
				{},
				{ enabled: true, model: "inherit-all", thinkingLevel: "off", inheritAll: true },
				{},
			),
		).toEqual({ model: undefined, thinkingLevel: "off" });
	});

	test("lists only effort levels supported by the selected model", () => {
		expect(availableThinkingLevels({ reasoning: false })).toEqual(["off"]);
		expect(availableThinkingLevels({ reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(
			availableThinkingLevels({
				reasoning: true,
				thinkingLevelMap: { low: null, xhigh: "xhigh", max: null },
			}),
		).toEqual(["off", "minimal", "medium", "high", "xhigh"]);
	});
});
