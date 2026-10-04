import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { availableThinkingLevels } from "../subagent/rewire.ts";
import { cycleModelPresets, cycleRewireModelPresets, type ModelPreset } from "./model-presets.ts";

type Direction = 1 | -1;
type RewireState = ModelPreset & { enabled?: boolean };

const modelId = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

function nextValue<T>(values: T[], current: T | undefined, direction: Direction): T | undefined {
	if (!values.length) return undefined;
	const index = values.findIndex((value) => value === current);
	if (index < 0) return values[direction === 1 ? 0 : values.length - 1];
	return values[(index + direction + values.length) % values.length];
}

function rewireState(pi: ExtensionAPI, ctx: ExtensionContext): RewireState | undefined {
	let state: RewireState | undefined;
	pi.events.emit("px:subagent:rewire:state:request", {
		ctx,
		reply: (value: RewireState | undefined) => { state = value; },
	});
	if (state?.model && state.thinkingLevel) return state;
	if (!ctx.model) return undefined;
	return { model: modelId(ctx.model), thinkingLevel: pi.getThinkingLevel() };
}

function applyRewireTarget(pi: ExtensionAPI, ctx: ExtensionContext, target: ModelPreset): boolean {
	let applied = false;
	pi.events.emit("px:subagent:rewire:target", {
		ctx,
		...target,
		onApplied: () => { applied = true; },
	});
	if (!applied) ctx.ui.notify("Could not set reviewer target. Is the subagent extension loaded?", "warning");
	return applied;
}

export async function cycleMainModel(pi: ExtensionAPI, ctx: ExtensionContext, direction: Direction): Promise<void> {
	await cycleModelPresets(pi, ctx, direction);
}

export function cycleMainThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext, direction: Direction): void {
	if (!ctx.model) {
		ctx.ui.notify("No active model to change thinking level for.", "warning");
		return;
	}
	const levels = availableThinkingLevels(ctx.model);
	const thinkingLevel = nextValue(levels, pi.getThinkingLevel(), direction);
	if (!thinkingLevel) {
		ctx.ui.notify("No thinking levels are available for the active model.", "warning");
		return;
	}
	pi.setThinkingLevel(thinkingLevel);
	ctx.ui.notify(`Thinking level: ${thinkingLevel}`, "info");
}

export function cycleReviewerModel(pi: ExtensionAPI, ctx: ExtensionContext, direction: Direction): void {
	cycleRewireModelPresets(pi, ctx, direction);
}

export function cycleReviewerThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext, direction: Direction): void {
	const current = rewireState(pi, ctx);
	if (!current) {
		ctx.ui.notify("No reviewer model is available to change thinking level for.", "warning");
		return;
	}
	const model = ctx.modelRegistry.getAvailable().find((candidate) => modelId(candidate) === current.model);
	if (!model) {
		ctx.ui.notify(`Reviewer model ${current.model} is not available.`, "warning");
		return;
	}
	const levels = availableThinkingLevels(model);
	const thinkingLevel = nextValue(levels, current.thinkingLevel, direction);
	if (!thinkingLevel) {
		ctx.ui.notify(`No thinking levels are available for ${current.model}.`, "warning");
		return;
	}
	try {
		applyRewireTarget(pi, ctx, { model: current.model, thinkingLevel });
	} catch (error) {
		ctx.ui.notify(`Could not change reviewer thinking level: ${String(error)}`, "error");
	}
}
