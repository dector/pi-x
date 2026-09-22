import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatRewirePreset, type RewirePreset } from "./rewire-presets.ts";

export const REWIRE_PRESET_LIST_TITLE = "Rewire presets";
export const REWIRE_PRESET_LIST_HELP = "↑↓ move • enter apply • n new • d delete • esc back";
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

	constructor(options: RewirePresetListViewOptions) {
		this.options = options;
	}

	get selectedIndex(): number | undefined {
		return this.options.presets.length > 0 ? this.selected : undefined;
	}

	invalidate(): void {
		// No cached render state; themed strings are built on every render.
	}

	handleInput(data: string): void {
		const keybindings = this.options.keybindings;
		if (keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.move(1);
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			const index = this.selectedIndex;
			if (index !== undefined) this.options.done({ type: "select", index });
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.options.done({ type: "cancel" });
		} else if (matchesKey(data, "n")) {
			this.options.done({ type: "create" });
		} else if (matchesKey(data, "d")) {
			const index = this.selectedIndex;
			if (index !== undefined) this.options.done({ type: "delete", index });
		}
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const theme = this.options.theme;
		const border = truncateToWidth(theme.fg("dim", "─".repeat(w)), w);
		const lines = [border, "", truncateToWidth(` ${theme.fg("accent", theme.bold(REWIRE_PRESET_LIST_TITLE))}`, w), ""];

		if (this.options.presets.length === 0) {
			lines.push(truncateToWidth(` ${theme.fg("muted", "No presets. Press n to create one.")}`, w));
		} else {
			const { start, end } = this.visibleRange();
			for (let index = start; index < end; index++) {
				const preset = this.options.presets[index];
				if (!preset) continue;
				const selected = index === this.selected;
				const text = `${selected ? " → " : "   "}${formatRewirePreset(preset)}`;
				lines.push(truncateToWidth(selected ? theme.fg("accent", text) : text, w));
			}
			if (start > 0 || end < this.options.presets.length) {
				lines.push(truncateToWidth(theme.fg("dim", `   (${this.selected + 1}/${this.options.presets.length})`), w));
			}
		}

		lines.push("", truncateToWidth(` ${theme.fg("dim", REWIRE_PRESET_LIST_HELP)}`, w), "", border);
		return lines;
	}

	private move(delta: number): void {
		const count = this.options.presets.length;
		if (count === 0) return;
		this.selected = (this.selected + delta + count) % count;
		this.options.requestRender();
	}

	private visibleRange(): { start: number; end: number } {
		const maxVisible = Math.max(1, this.options.maxVisible ?? DEFAULT_REWIRE_PRESET_LIST_VISIBLE);
		if (this.options.presets.length <= maxVisible) return { start: 0, end: this.options.presets.length };
		const start = Math.max(
			0,
			Math.min(this.selected - Math.floor(maxVisible / 2), this.options.presets.length - maxVisible),
		);
		return { start, end: start + maxVisible };
	}
}
