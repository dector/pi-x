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

/** User-facing status label shared by both inherited modes. */
export const REWIRE_INHERIT_LABEL = "Inherit";
/** User-facing labels for the two inherited targets. */
export const REWIRE_INHERIT_MODEL_LABEL = "Inherit model";
export const REWIRE_INHERIT_ALL_LABEL = "Inherit All";
/** Compact values accepted for session-local/session-handoff rewire state. */
export const REWIRE_INHERIT_MODEL = "inherit";
export const REWIRE_INHERIT_ALL_MODEL = "inherit-all";

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

/** Whether a rewire inherits the parent thinking level as well as its model. */
function isInheritSentinel(model: string): boolean {
	const normalized = model.trim().toLowerCase();
	return normalized === REWIRE_INHERIT_MODEL || normalized === REWIRE_INHERIT_ALL_MODEL;
}

export function isInheritAllRewire(
	rewire: Pick<SubagentRewireConfig, "model" | "inheritAll"> | undefined,
): boolean {
	if (!rewire) return false;
	// An explicit boolean is authoritative, matching the model-only mode.
	if (rewire.inheritAll !== undefined) return rewire.inheritAll;
	return typeof rewire.model === "string" && rewire.model.trim().toLowerCase() === REWIRE_INHERIT_ALL_MODEL;
}

/** Whether a rewire follows the parent model's current selection. */
export function isInheritedRewire(
	rewire: Pick<SubagentRewireConfig, "model" | "inherit" | "inheritAll"> | undefined,
): boolean {
	if (!rewire) return false;
	// Inherit All wins if a legacy/hand-edited state contains both markers.
	if (isInheritAllRewire(rewire)) return true;
	// An explicit boolean is authoritative. This lets an old `model: "inherit"`
	// state be turned off without the sentinel immediately re-enabling itself.
	if (rewire.inherit !== undefined) return rewire.inherit;
	return typeof rewire.model === "string" && rewire.model.trim().toLowerCase() === REWIRE_INHERIT_MODEL;
}

/**
 * Resolve the child argv model and effort, applying a session rewire first.
 *
 * `currentDefaults` is deliberately separate from the dispatch snapshot. An
 * inherited rewire must observe the parent model at child start (which matters
 * for queued parallel/chain work), while fixed rewires remain stable for the
 * whole accepted dispatch.
 */
export function resolveSubagentModel(
	agent: { model?: string; thinking?: ThinkingLevel },
	defaults: DispatchDefaults,
	rewire?: SubagentRewireConfig,
	currentDefaults: DispatchDefaults = defaults,
): { model?: string; thinkingLevel?: ThinkingLevel } {
	if (rewire?.enabled) {
		if (isInheritedRewire(rewire)) {
			const configuredModel = typeof rewire.model === "string" ? rewire.model.trim() : "";
			const fallbackModel = isInheritSentinel(configuredModel) ? undefined : configuredModel || undefined;
			const model = currentDefaults.model ?? defaults.model ?? fallbackModel;
			if (isInheritAllRewire(rewire)) {
				return {
					// Inherit All takes priority and follows the parent's effort too.
					model,
					thinkingLevel: currentDefaults.thinkingLevel ?? defaults.thinkingLevel ?? rewire.thinkingLevel,
				};
			}
			return {
				// If the parent temporarily has no model, retain the dispatch-time
				// model, then the configured fallback, rather than passing the UI
				// sentinel to the child process.
				model,
				// Inherit model keeps the configured effort, which Pi clamps for the
				// detected model.
				thinkingLevel: rewire.thinkingLevel,
			};
		}
		const fixedModel =
			typeof rewire.model !== "string" || isInheritSentinel(rewire.model) ? undefined : rewire.model.trim();
		return { model: fixedModel, thinkingLevel: rewire.thinkingLevel };
	}
	const inheritsDispatchConfig = !agent.model;
	return {
		model: agent.model ?? defaults.model,
		thinkingLevel: agent.thinking ?? (inheritsDispatchConfig ? defaults.thinkingLevel : undefined),
	};
}
