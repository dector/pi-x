import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { DispatchDefaults, SubagentRewireConfig } from "./types.ts";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

interface RewireModel {
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/** Thinking levels exposed by Pi for a selected override model. */
export function availableThinkingLevels(model: RewireModel): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	const map = model.thinkingLevelMap;
	if (!map) return ["off", "minimal", "low", "medium", "high"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		return level === "xhigh" || level === "max" ? mapped !== undefined : true;
	});
}

/** Resolve the child argv model and effort, applying a session rewire first. */
export function resolveSubagentModel(
	agent: { model?: string; thinking?: ThinkingLevel },
	defaults: DispatchDefaults,
	rewire?: SubagentRewireConfig,
): { model?: string; thinkingLevel?: ThinkingLevel } {
	if (rewire?.enabled) {
		return { model: rewire.model, thinkingLevel: rewire.thinkingLevel };
	}
	const inheritsDispatchConfig = !agent.model;
	return {
		model: agent.model ?? defaults.model,
		thinkingLevel: agent.thinking ?? (inheritsDispatchConfig ? defaults.thinkingLevel : undefined),
	};
}
