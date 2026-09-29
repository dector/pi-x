import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

export const REWIRE_MENU_TITLE = "Subagent rewiring";
export const REWIRE_MENU_HELP = "i inherit all • I inherit model • e enabled • ↑↓ move • enter select • esc close";

export type RewireMenuAction = "configuration" | "inherit-all" | "inherit-model" | "enabled";

export type RewireMenuResult = { type: RewireMenuAction } | { type: "cancel" };

export type RewireMenuNavigationKey =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.confirm"
	| "tui.select.cancel";

export interface RewireMenuTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export interface RewireMenuKeybindings {
	matches: (data: string, keybinding: RewireMenuNavigationKey) => boolean;
}

export interface RewireMenuViewOptions {
	enabled: boolean;
	inheritAll: boolean;
	inheritModel: boolean;
	target?: string;
	theme: RewireMenuTheme;
	keybindings: RewireMenuKeybindings;
	requestRender: () => void;
	done: (result: RewireMenuResult) => void;
}

const MENU_ITEMS: { label: string; action: RewireMenuAction }[] = [
	{ label: "Configuration", action: "configuration" },
	{ label: "Inherit All", action: "inherit-all" },
	{ label: "Inherit Model", action: "inherit-model" },
	{ label: "Enabled", action: "enabled" },
];
const TOGGLE_LABEL_WIDTH = Math.max(...MENU_ITEMS.map(({ label }) => label.length));

function rewireIndicatorTone(label: string, enabled: boolean): string {
	if (!enabled) return "muted";
	return label === "Enabled" ? "error" : "success";
}

export function formatRewireMenuToggle(
	label: string,
	enabled: boolean,
	fg?: RewireMenuTheme["fg"],
): string {
	const indicator = enabled ? "[ON]" : "[OFF]";
	return `${label.padEnd(TOGGLE_LABEL_WIDTH)}  ${fg ? fg(rewireIndicatorTone(label, enabled), indicator) : indicator}`;
}

/** Rewiring menu with aligned toggle indicators and direct keyboard shortcuts. */
export class RewireMenuView implements Component {
	private readonly options: RewireMenuViewOptions;
	private selected = 0;

	constructor(options: RewireMenuViewOptions) {
		this.options = options;
	}

	get selectedAction(): RewireMenuAction | undefined {
		return MENU_ITEMS[this.selected]?.action;
	}

	invalidate(): void {
		// No cached render state; themed strings are built on every render.
	}

	handleInput(data: string): void {
		const keybindings = this.options.keybindings;
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.options.done({ type: "cancel" });
		} else if (keybindings.matches(data, "tui.select.up") || data === "k" || data === "K") {
			this.move(-1);
		} else if (keybindings.matches(data, "tui.select.down") || data === "j" || data === "J") {
			this.move(1);
		} else if (data === "I" || matchesKey(data, "shift+i")) {
			this.options.done({ type: "inherit-model" });
		} else if (data === "i" || matchesKey(data, "i")) {
			this.options.done({ type: "inherit-all" });
		} else if (data === "e" || matchesKey(data, "e")) {
			this.options.done({ type: "enabled" });
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			const action = this.selectedAction;
			if (action) this.options.done({ type: action });
		}
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const { theme } = this.options;
		const border = truncateToWidth(theme.fg("dim", "─".repeat(w)), w);
		const lines = [border, "", truncateToWidth(` ${theme.fg("accent", theme.bold(REWIRE_MENU_TITLE))}`, w), ""];

		for (let index = 0; index < MENU_ITEMS.length; index += 1) {
			const item = MENU_ITEMS[index]!;
			const selected = index === this.selected;
			const prefix = selected ? " → " : "   ";
			if (item.action === "configuration") {
				const row = `${prefix}${item.label}`;
				lines.push(truncateToWidth(selected ? theme.fg("thinkingHigh", theme.bold(row)) : row, w));
				continue;
			}
			const enabled = item.action === "enabled"
				? this.options.enabled
				: item.action === "inherit-all"
					? this.options.inheritAll
					: this.options.inheritModel;
			const label = `${prefix}${item.label.padEnd(TOGGLE_LABEL_WIDTH)}`;
			const styledLabel = selected ? theme.fg("thinkingHigh", theme.bold(label)) : label;
			const indicator = theme.fg(rewireIndicatorTone(item.label, enabled), enabled ? "[ON]" : "[OFF]");
			lines.push(truncateToWidth(`${styledLabel}  ${indicator}`, w));
		}

		if (this.options.target) {
			lines.push("", truncateToWidth(` ${theme.fg("muted", `Rewiring to ${this.options.target}`)}`, w));
		}
		lines.push("", truncateToWidth(` ${theme.fg("dim", REWIRE_MENU_HELP)}`, w), "", border);
		return lines;
	}

	private move(delta: number): void {
		this.selected = (this.selected + delta + MENU_ITEMS.length) % MENU_ITEMS.length;
		this.options.requestRender();
	}
}
