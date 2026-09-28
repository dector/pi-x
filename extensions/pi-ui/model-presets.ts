import fs from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { availableThinkingLevels } from "../subagent/rewire.ts";

export type ModelPreset = { model: string; thinkingLevel: ReturnType<typeof availableThinkingLevels>[number] };
export const modelPresetsPath = () => path.join(getAgentDir(), "model-presets.json");
const label = (preset: ModelPreset) => `${preset.model} · ${preset.thinkingLevel}`;

export function loadModelPresets(file = modelPresetsPath()): ModelPreset[] {
	if (!fs.existsSync(file)) return [];
	const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { presets?: unknown }).presets)) throw new Error("Invalid model presets file");
	const presets = (parsed as { presets: unknown[] }).presets;
	if (!presets.every((entry) => entry && typeof entry === "object" && typeof (entry as ModelPreset).model === "string" && (entry as ModelPreset).model.includes("/") && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes((entry as ModelPreset).thinkingLevel))) throw new Error("Invalid model preset");
	return presets as ModelPreset[];
}

export function saveModelPresets(presets: ModelPreset[], file = modelPresetsPath()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(temp, JSON.stringify({ version: 1, presets }, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(temp, file);
	} finally {
		if (fs.existsSync(temp)) fs.unlinkSync(temp);
	}
}

export function moveModelPreset(presets: ModelPreset[], index: number, delta: -1 | 1): number {
	const next = index + delta;
	if (index < 0 || index >= presets.length || next < 0 || next >= presets.length) return index;
	[presets[index], presets[next]] = [presets[next]!, presets[index]!];
	return next;
}

type PickerResult = { type: "new" } | { type: "delete"; index: number } | { type: "move"; index: number; delta: -1 | 1 } | { type: "cancel" };
type PickerActions = {
	getMain: () => ModelPreset | undefined;
	getRewire: () => ModelPreset | undefined;
	onUse: (preset: ModelPreset) => Promise<void>;
	onRewire: (preset: ModelPreset) => void;
};
export async function showModelPresetList(ctx: ExtensionContext, presets: ModelPreset[], initialIndex = 0, actions?: PickerActions, temporary: ModelPreset[] = []): Promise<PickerResult> {
	return ctx.ui.custom<PickerResult>((tui, theme, kb, done) => {
		let selected = Math.max(0, initialIndex);
		let searching = false;
		let query = "";
		let previousSelected = 0;
		let applying = false;
		const display = () => {
			const main = actions?.getMain();
			const rewire = actions?.getRewire();
			for (const item of [main, rewire]) {
				if (item && !presets.some((candidate) => candidate.model === item.model && candidate.thinkingLevel === item.thinkingLevel)
					&& !temporary.some((candidate) => candidate.model === item.model && candidate.thinkingLevel === item.thinkingLevel)) temporary.push({ ...item });
			}
			// These are snapshots: a model switch moves its icon, not its temporary row.
			const items = [...presets, ...temporary.filter((item) => !presets.some((candidate) => candidate.model === item.model && candidate.thinkingLevel === item.thinkingLevel))];
			return { items, main, rewire };
		};
		// The opening selection can be a temporary (unsaved) main model.
		selected = Math.min(selected, Math.max(0, display().items.length - 1));
		const matches = (items: ModelPreset[]) => {
			const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
			return items.map((_preset, index) => index).filter((index) => {
				const text = label(items[index]!).toLowerCase();
				return terms.every((term) => text.includes(term));
			});
		};
		return {
			invalidate() {},
			render(width: number) {
				const w = Math.max(1, width);
				const { items, main, rewire } = display();
				const indices = searching ? matches(items) : items.map((_preset, index) => index);
				const lines = ["", truncateToWidth(` ${theme.fg("accent", theme.bold("Favorite model configurations"))}`, w), ""];
				if (searching) lines.push(truncateToWidth(` / ${query}`, w));
				if (!indices.length) lines.push(truncateToWidth(searching ? " No matching presets." : " No presets. Press n to create one.", w));
				const count = Math.min(12, indices.length);
				const start = Math.max(0, Math.min(selected - Math.floor(count / 2), indices.length - count));
				for (let i = start; i < start + count; i++) {
					const index = indices[i]!;
					const preset = items[index]!;
					const isMain = main?.model === preset.model && main.thinkingLevel === preset.thinkingLevel;
					const isRewire = rewire?.model === preset.model && rewire.thinkingLevel === preset.thinkingLevel;
					const icons = `${isMain ? "󰙴" : " "}${isRewire ? "󰒟" : " "}`;
					const text = `${i === selected ? " → " : "   "}${icons} ${label(preset)}`;
					lines.push(truncateToWidth(index >= presets.length ? theme.fg("muted", text) : i === selected ? theme.fg("accent", text) : text, w));
				}
				if (indices.length > count) lines.push(truncateToWidth(` ${selected + 1}/${indices.length}`, w));
				lines.push("", truncateToWidth(theme.fg("dim", " 󰙴 main · 󰒟 rewire"), w), truncateToWidth(theme.fg("dim", searching
					? " Type to filter · ↑/↓ move · Enter use · Alt+Enter rewire · Backspace edit · Esc clear"
					: " / search · j/k navigate · Shift+j/k reorder · Enter use · Alt+Enter rewire · n new · d delete · Esc back"), w), "");
				return lines;
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape) || kb.matches(data, "tui.select.cancel")) {
					if (!searching) return done({ type: "cancel" });
					searching = false;
					query = "";
					selected = previousSelected;
					tui.requestRender();
					return;
				}
				if (!searching && data === "/") {
					searching = true;
					previousSelected = selected;
					selected = 0;
					tui.requestRender();
					return;
				}
				if (searching && matchesKey(data, Key.backspace)) {
					query = Array.from(query).slice(0, -1).join("");
					selected = 0;
					tui.requestRender();
					return;
				}
				if (applying) return;
				const { items } = display();
				const indices = searching ? matches(items) : items.map((_preset, index) => index);
				const index = indices[selected];
				if (!searching && index !== undefined && index < presets.length && matchesKey(data, Key.shift("j"))) return done({ type: "move", index, delta: 1 });
				if (!searching && index !== undefined && index < presets.length && matchesKey(data, Key.shift("k"))) return done({ type: "move", index, delta: -1 });
				if (!searching && data === "n") return done({ type: "new" });
				if (!searching && data === "d" && index !== undefined && index < presets.length) return done({ type: "delete", index });
				if (matchesKey(data, Key.alt("enter")) && index !== undefined && actions) {
					actions.onRewire(items[index]!);
					tui.requestRender();
					return;
				}
				if (kb.matches(data, "tui.select.confirm") && index !== undefined && actions) {
					applying = true;
					void actions.onUse(items[index]!).catch((error) => ctx.ui.notify(`Could not select model: ${String(error)}`, "error")).finally(() => { applying = false; tui.requestRender(); });
					return;
				}
				if (indices.length && (kb.matches(data, "tui.select.down") || (!searching && data === "j"))) selected = (selected + 1) % indices.length;
				else if (indices.length && (kb.matches(data, "tui.select.up") || (!searching && data === "k"))) selected = (selected - 1 + indices.length) % indices.length;
				else if (searching && /^[^\x00-\x1f\x7f]+$/.test(data)) {
					query += data;
					selected = 0;
				} else return;
				tui.requestRender();
			},
		};
	});
}

export async function selectPresetOption(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, kb, done) => {
		let selected = 0;
		let searching = false;
		let query = "";
		let previousSelected = 0;
		const matches = () => options.map((_option, index) => index).filter((index) =>
			query.toLowerCase().trim().split(/\s+/).filter(Boolean).every((term) => options[index]!.toLowerCase().includes(term)));
		return {
			invalidate() {},
			render(width: number) {
				const w = Math.max(1, width);
				const indices = searching ? matches() : options.map((_option, index) => index);
				const count = Math.min(12, indices.length);
				const start = Math.max(0, Math.min(selected - Math.floor(count / 2), indices.length - count));
				const lines = ["", truncateToWidth(` ${theme.fg("accent", theme.bold(title))}`, w), ""];
				if (searching) lines.push(truncateToWidth(` / ${query}`, w));
				if (!indices.length) lines.push(truncateToWidth(" No matching options.", w));
				for (let i = start; i < start + count; i++) {
					const text = `${i === selected ? " → " : "   "}${options[indices[i]!]}`;
					lines.push(truncateToWidth(i === selected ? theme.fg("accent", text) : text, w));
				}
				lines.push("", truncateToWidth(theme.fg("dim", searching ? " Type to filter · ↑/↓ move · Enter select · Backspace edit · Esc clear" : " / search · j/k move · Enter select · Esc back"), w), "");
				return lines;
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape) || kb.matches(data, "tui.select.cancel")) {
					if (!searching) return done(undefined);
					searching = false;
					query = "";
					selected = previousSelected;
				} else if (!searching && data === "/") {
					searching = true;
					previousSelected = selected;
					selected = 0;
				} else if (searching && matchesKey(data, Key.backspace)) {
					query = Array.from(query).slice(0, -1).join("");
					selected = 0;
				} else {
					const indices = searching ? matches() : options.map((_option, index) => index);
					if (kb.matches(data, "tui.select.confirm") && indices[selected] !== undefined) return done(options[indices[selected]!]);
					if (indices.length && (kb.matches(data, "tui.select.down") || (!searching && data === "j"))) selected = (selected + 1) % indices.length;
					else if (indices.length && (kb.matches(data, "tui.select.up") || (!searching && data === "k"))) selected = (selected - 1 + indices.length) % indices.length;
					else if (searching && /^[^\x00-\x1f\x7f]+$/.test(data)) { query += data; selected = 0; }
					else return;
				}
				tui.requestRender();
			},
		};
	});
}

function nextAvailablePreset(ctx: ExtensionContext, presets: ModelPreset[], current?: ModelPreset): ModelPreset | undefined {
	const currentIndex = presets.findIndex((preset) => preset.model === current?.model && preset.thinkingLevel === current.thinkingLevel);
	const available = ctx.modelRegistry.getAvailable();
	for (let step = 1; step <= presets.length; step++) {
		const preset = presets[(currentIndex + step) % presets.length]!;
		const model = available.find((item) => `${item.provider}/${item.id}` === preset.model);
		if (model && availableThinkingLevels(model).includes(preset.thinkingLevel)) return preset;
	}
}

function cycleFavorites(ctx: ExtensionContext, current?: ModelPreset): ModelPreset | undefined {
	let presets: ModelPreset[];
	try { presets = loadModelPresets(); }
	catch (error) { ctx.ui.notify(`Cannot read model presets: ${String(error)}`, "error"); return; }
	if (!presets.length) { ctx.ui.notify("No favorite models. Add one with Ctrl+, then m.", "warning"); return; }
	const next = nextAvailablePreset(ctx, presets, current);
	if (!next) ctx.ui.notify("No favorite models are available.", "warning");
	return next;
}

export async function cycleModelPresets(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const current = ctx.model && { model: `${ctx.model.provider}/${ctx.model.id}`, thinkingLevel: pi.getThinkingLevel() };
	const preset = cycleFavorites(ctx, current);
	if (!preset) return;
	const model = ctx.modelRegistry.getAvailable().find((item) => `${item.provider}/${item.id}` === preset.model)!;
	try {
		if (!(await pi.setModel(model))) { ctx.ui.notify(`Could not select ${preset.model}`, "error"); return; }
		pi.setThinkingLevel(preset.thinkingLevel);
		ctx.ui.notify(`Favorite model: ${label(preset)}`, "info");
	} catch (error) { ctx.ui.notify(`Could not select ${label(preset)}: ${String(error)}`, "error"); }
}

export function cycleRewireModelPresets(pi: ExtensionAPI, ctx: ExtensionContext): void {
	let current: ModelPreset | undefined;
	pi.events.emit("px:subagent:rewire:state:request", { ctx, reply: (state: ModelPreset | undefined) => { current = state; } });
	const preset = cycleFavorites(ctx, current);
	if (!preset) return;
	let applied = false;
	pi.events.emit("px:subagent:rewire:target", { ctx, ...preset, onApplied: () => { applied = true; } });
	if (!applied) ctx.ui.notify("Could not set rewire target. Is the subagent extension loaded?", "warning");
}

export async function openModelPresets(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	let selectedIndex: number | undefined;
	let selectedMain: ModelPreset | undefined;
	const temporary: ModelPreset[] = [];
	while (true) {
		let presets: ModelPreset[];
		try { presets = loadModelPresets(); }
		catch (error) { ctx.ui.notify(`Cannot read model presets: ${String(error)}`, "error"); return; }
		const availableModels = () => ctx.modelRegistry.getAvailable();
		const rewireState = (): ModelPreset | undefined => {
			let target: ModelPreset | undefined;
			pi.events.emit("px:subagent:rewire:state:request", { ctx, reply: (state: ModelPreset | undefined) => { target = state; } });
			return target;
		};
		if (selectedIndex === undefined) {
			const main = ctx.model && { model: `${ctx.model.provider}/${ctx.model.id}`, thinkingLevel: pi.getThinkingLevel() };
			const index = main ? presets.findIndex((item) => item.model === main.model && item.thinkingLevel === main.thinkingLevel) : -1;
			selectedIndex = main ? (index >= 0 ? index : presets.length) : 0;
		}
		const result = await showModelPresetList(ctx, presets, selectedIndex, {
			// ctx.model can lag behind pi.setModel while the custom picker is open.
			// Keep the model and effort together rather than mixing the old model
			// with the newly applied thinking level.
			getMain: () => selectedMain ?? (ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}`, thinkingLevel: pi.getThinkingLevel() } : undefined),
			getRewire: rewireState,
			onUse: async (preset) => {
				const model = availableModels().find((item) => `${item.provider}/${item.id}` === preset.model);
				if (!model || !availableThinkingLevels(model).includes(preset.thinkingLevel)) { ctx.ui.notify(`Preset unavailable: ${label(preset)}`, "warning"); return; }
				const previousMain = selectedMain;
				selectedMain = { ...preset };
				try {
					if (!(await pi.setModel(model))) { selectedMain = previousMain; ctx.ui.notify(`Could not select ${preset.model}`, "error"); return; }
					pi.setThinkingLevel(preset.thinkingLevel);
					selectedMain = { model: preset.model, thinkingLevel: pi.getThinkingLevel() };
				} catch (error) {
					selectedMain = previousMain;
					throw error;
				}
			},
			onRewire: (preset) => {
				const model = availableModels().find((item) => `${item.provider}/${item.id}` === preset.model);
				if (!model || !availableThinkingLevels(model).includes(preset.thinkingLevel)) { ctx.ui.notify(`Preset unavailable: ${label(preset)}`, "warning"); return; }
				let applied = false;
				pi.events.emit("px:subagent:rewire:target", { ctx, ...preset, onApplied: () => { applied = true; } });
				if (!applied) ctx.ui.notify("Could not set rewire target. Is the subagent extension loaded?", "warning");
			},
		}, temporary);
		if (result.type === "cancel") return;
		if (result.type === "move") {
			const next = moveModelPreset(presets, result.index, result.delta);
			if (next === result.index) continue;
			try { saveModelPresets(presets); selectedIndex = next; }
			catch (error) { ctx.ui.notify(`Cannot save model presets: ${String(error)}`, "error"); return; }
			continue;
		}
		if (result.type === "new") {
			const models = availableModels();
			const choices = models.map((model) => `${model.provider}/${model.id}`);
			if (!choices.length) { ctx.ui.notify("No models available.", "warning"); continue; }
			const modelId = await selectPresetOption(ctx, "Preset model", choices);
			const model = models.find((item) => `${item.provider}/${item.id}` === modelId);
			if (!model) continue;
			const effort = await selectPresetOption(ctx, "Preset thinking level", availableThinkingLevels(model));
			if (!effort || !availableThinkingLevels(model).includes(effort as ModelPreset["thinkingLevel"])) continue;
			const preset = { model: modelId!, thinkingLevel: effort as ModelPreset["thinkingLevel"] };
			if (presets.some((item) => item.model === preset.model && item.thinkingLevel === preset.thinkingLevel)) { ctx.ui.notify("Preset already exists.", "warning"); continue; }
			presets.push(preset);
			selectedIndex = presets.length - 1;
		} else if (result.type === "delete") {
			selectedIndex = result.index;
			const preset = presets[result.index];
			if (!preset) continue;
			if (!(await ctx.ui.confirm("Remove model preset", `Remove ${label(preset)}?`))) continue;
			presets.splice(result.index, 1);
			selectedIndex = Math.min(result.index, presets.length - 1);
		}
		try { saveModelPresets(presets); }
		catch (error) { ctx.ui.notify(`Cannot save model presets: ${String(error)}`, "error"); return; }
	}
}
