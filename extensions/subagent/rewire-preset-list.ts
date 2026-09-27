import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatRewirePreset, isInheritRewirePreset, type RewirePreset } from "./rewire-presets.ts";

export const REWIRE_PRESET_LIST_TITLE = "Rewire presets";
export const REWIRE_PRESET_LIST_HELP = "/ search • ↑↓ move • enter apply • n new • d delete • esc back";
export const DEFAULT_REWIRE_PRESET_LIST_VISIBLE = 12;

export type RewirePresetListResult =
	| { type: "select"; index: number }
	| { type: "create" }
	| { type: "delete"; index: number }
	| { type: "cancel" };

export type RewirePresetListNavigationKey =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.confirm"
	| "tui.select.cancel";

export interface RewirePresetListTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export interface RewirePresetListKeybindings {
	matches: (data: string, keybinding: RewirePresetListNavigationKey) => boolean;
}

export interface RewirePresetListViewOptions {
	presets: readonly RewirePreset[];
	theme: RewirePresetListTheme;
	keybindings: RewirePresetListKeybindings;
	requestRender: () => void;
	done: (result: RewirePresetListResult) => void;
	maxVisible?: number;
}

export class RewirePresetListView implements Component {
	private readonly options: RewirePresetListViewOptions;
	private selected = 0;
	private searching = false;
	private query = "";
	private previousSelected = 0;

	private matchingIndices(): number[] {
		const terms = this.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
		return this.options.presets.map((_preset, index) => index).filter((index) => {
			const text = formatRewirePreset(this.options.presets[index]!).toLowerCase();
			return terms.every((term) => text.includes(term));
		});
	}

	constructor(options: RewirePresetListViewOptions) {
		this.options = options;
	}

	get selectedIndex(): number | undefined {
		return this.matchingIndices()[this.selected];
	}

	invalidate(): void {
		// No cached render state; themed strings are built on every render.
	}

	handleInput(data: string): void {
		const keybindings = this.options.keybindings;
		if (keybindings.matches(data, "tui.select.cancel")) {
			if (!this.searching) return this.options.done({ type: "cancel" });
			this.searching = false;
			this.query = "";
			this.selected = this.previousSelected;
			this.options.requestRender();
		} else if (!this.searching && data === "/") {
			this.searching = true;
			this.previousSelected = this.selected;
			this.selected = 0;
			this.options.requestRender();
		} else if (this.searching && matchesKey(data, "backspace")) {
			this.query = Array.from(this.query).slice(0, -1).join("");
			this.selected = 0;
			this.options.requestRender();
		} else if (keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.move(1);
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			const index = this.selectedIndex;
			if (index !== undefined) this.options.done({ type: "select", index });
		} else if (!this.searching && matchesKey(data, "n")) {
			this.options.done({ type: "create" });
		} else if (!this.searching && matchesKey(data, "d")) {
			const index = this.selectedIndex;
			const preset = index === undefined ? undefined : this.options.presets[index];
			// Inherit is a built-in, always-first preset and cannot be removed.
			if (index !== undefined && preset && !isInheritRewirePreset(preset)) {
				this.options.done({ type: "delete", index });
			}
		} else if (this.searching && /^[^\x00-\x1f\x7f]+$/.test(data)) {
			this.query += data;
			this.selected = 0;
			this.options.requestRender();
		}
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const theme = this.options.theme;
		const border = truncateToWidth(theme.fg("dim", "─".repeat(w)), w);
		const lines = [border, "", truncateToWidth(` ${theme.fg("accent", theme.bold(REWIRE_PRESET_LIST_TITLE))}`, w), ""];
		if (this.searching) lines.push(truncateToWidth(` / ${this.query}`, w));
		const indices = this.matchingIndices();
		if (indices.length === 0) {
			lines.push(truncateToWidth(` ${theme.fg("muted", this.searching ? "No matching presets." : "No presets. Press n to create one.")}`, w));
		} else {
			const { start, end } = this.visibleRange(indices.length);
			for (let position = start; position < end; position++) {
				const preset = this.options.presets[indices[position]!]!;
				const selected = position === this.selected;
				const baseLabel = formatRewirePreset(preset);
				const label = isInheritRewirePreset(preset) ? `${baseLabel} (built-in)` : baseLabel;
				const text = `${selected ? " → " : "   "}${label}`;
				lines.push(truncateToWidth(selected ? theme.fg("accent", text) : text, w));
			}
			if (start > 0 || end < indices.length) {
				lines.push(truncateToWidth(theme.fg("dim", `   (${this.selected + 1}/${indices.length})`), w));
			}
		}

		lines.push("", truncateToWidth(` ${theme.fg("dim", this.searching ? "Type to filter • ↑↓ move • enter apply • backspace edit • esc clear" : REWIRE_PRESET_LIST_HELP)}`, w), "", border);
		return lines;
	}

	private move(delta: number): void {
		const count = this.matchingIndices().length;
		if (count === 0) return;
		this.selected = (this.selected + delta + count) % count;
		this.options.requestRender();
	}

	private visibleRange(count: number): { start: number; end: number } {
		const maxVisible = Math.max(1, this.options.maxVisible ?? DEFAULT_REWIRE_PRESET_LIST_VISIBLE);
		if (count <= maxVisible) return { start: 0, end: count };
		const start = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), count - maxVisible));
		return { start, end: start + maxVisible };
	}
}
