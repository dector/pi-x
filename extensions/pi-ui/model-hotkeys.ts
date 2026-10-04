import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { availableThinkingLevels } from "../subagent/rewire.ts";
import type { ModelPreset } from "./model-presets.ts";

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
	const models = ctx.modelRegistry.getAvailable();
	if (!models.length) {
		ctx.ui.notify("No models are available.", "warning");
		return;
	}
	const currentId = ctx.model ? modelId(ctx.model) : undefined;
	const currentIndex = models.findIndex((model) => modelId(model) === currentId);
	const index = currentIndex < 0
		? (direction === 1 ? 0 : models.length - 1)
		: (currentIndex + direction + models.length) % models.length;
	const model = models[index]!;
	const levels = availableThinkingLevels(model);
	const currentLevel = pi.getThinkingLevel();
	const thinkingLevel = levels.includes(currentLevel) ? currentLevel : levels[0];
	try {
		if (!(await pi.setModel(model))) {
			ctx.ui.notify(`Could not select ${modelId(model)}.`, "error");
			return;
		}
		if (thinkingLevel) pi.setThinkingLevel(thinkingLevel);
		ctx.ui.notify(`Model: ${modelId(model)} · ${thinkingLevel ?? currentLevel}`, "info");
	} catch (error) {
		ctx.ui.notify(`Could not select ${modelId(model)}: ${String(error)}`, "error");
	}
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
	const models = ctx.modelRegistry.getAvailable();
	if (!models.length) {
		ctx.ui.notify("No models are available for the reviewer.", "warning");
		return;
	}
	const current = rewireState(pi, ctx);
	const currentIndex = models.findIndex((model) => modelId(model) === current?.model);
	const index = currentIndex < 0
		? (direction === 1 ? 0 : models.length - 1)
		: (currentIndex + direction + models.length) % models.length;
	const model = models[index]!;
	const levels = availableThinkingLevels(model);
	const currentLevel = current?.thinkingLevel;
	const thinkingLevel = currentLevel && levels.includes(currentLevel) ? currentLevel : levels[0];
	if (!thinkingLevel) {
		ctx.ui.notify(`No thinking levels are available for ${modelId(model)}.`, "warning");
		return;
	}
	try {
		applyRewireTarget(pi, ctx, { model: modelId(model), thinkingLevel });
	} catch (error) {
		ctx.ui.notify(`Could not select reviewer model ${modelId(model)}: ${String(error)}`, "error");
	}
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
