import { describe, expect, test } from "bun:test";
import { availableThinkingLevels, resolveSubagentModel } from "./rewire.ts";

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
