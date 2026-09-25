import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Key, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { FocusModeStateV1 } from "./state";
import { DEFAULT_BIAS, DEFAULT_WIDTH, MAX_BIAS, MAX_WIDTH, MIN_BIAS, MIN_WIDTH, resolveGeometry } from "./viewport";

/** Quick jumps offered on `↵`. The live value is merged in, so nothing is lost. */
export const WIDTH_PRESETS = [80, 100, 120];
export const BIAS_PRESETS = [-100, -80, -25, 0, 25, 80, 100];

/** `h`/`l` move by one step, `H`/`L` by one fine step. */
export const WIDTH_STEP = 5;
export const WIDTH_FINE_STEP = 1;
export const BIAS_STEP = 25;
export const BIAS_FINE_STEP = 5;

/**
 * Frame language copied from the pi-ui quick actions dialog
 * (`extensions/pi-ui/index.ts`): white heavy lines, a truecolor black
 * background on the selected row, three columns of padding either side, and a
 * full width background row above and below the frame. Keep the two in sync.
 */
const MAX_FRAME_WIDTH = 47;
const borderOf = (text: string): string => `\x1b[97m${text}\x1b[39m`;
const SELECTED_BG = "\x1b[48;2;0;0;0m";
const SELECTED_FG = "\x1b[97m";
const RESET_BG = "\x1b[49m";

const ROWS = ["enabled", "width", "bias", "reset", "apply", "apply-session"] as const;
type Row = (typeof ROWS)[number];
type Mode = "edit" | "preset" | "confirm";
type Scroller = { field: "width" | "bias"; values: number[]; index: number };

/** The preset list, with `current` spliced in when it is not already a preset. */
export function mergePreset(current: number, presets: readonly number[]): number[] {
	return [...new Set([...presets, current])].sort((a, b) => a - b);
}

export function step(current: number, delta: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, current + delta));
}

export interface Preview {
	realWidth: number;
	enabled: boolean;
	margin: number;
	effective: number;
	right: number;
	/** Enabled, but the column does not fit: the layout is the full screen. */
	inert: boolean;
}

/** What the draft would produce on a screen this wide. */
export function previewFor(realWidth: number, draft: FocusModeStateV1): Preview {
	const geometry = resolveGeometry(realWidth, draft.enabled, draft.width, draft.bias);
	return {
		realWidth: geometry.realWidth,
		enabled: draft.enabled,
		margin: geometry.margin,
		effective: geometry.effectiveWidth,
		right: geometry.realWidth - geometry.margin - geometry.effectiveWidth,
		inert: draft.enabled && geometry.effectiveWidth >= geometry.realWidth,
	};
}

/** write `text` into a fixed width cell row, clipped at the right edge */
function writeAt(cells: string[], index: number, text: string): void {
	for (let i = 0; i < text.length && index + i < cells.length; i++) cells[index + i] = text[i] ?? " ";
}

export function renderBarBlock(preview: Preview, cells: number, indent: string): string[] {
	const { realWidth, enabled, margin, effective, right } = preview;
	const column = enabled ? Math.max(1, Math.round((effective / realWidth) * cells)) : cells;
	const left = enabled ? Math.min(cells - column, Math.round((margin / realWidth) * cells)) : 0;
	const bar = enabled
		? " ".repeat(left) + "▓".repeat(column) + " ".repeat(Math.max(0, cells - column - left))
		: "·".repeat(cells);

	// margin on the left, width under the column, remaining space on the right.
	const marginText = String(margin);
	const widthText = String(effective);
	const rightText = String(right);
	const numbers: string[] = Array.from({ length: cells }, () => " ");
	if (marginText.length + widthText.length + rightText.length + 2 > cells) {
		writeAt(numbers, Math.max(0, Math.round((cells - widthText.length) / 2)), widthText);
	} else {
		writeAt(numbers, 0, marginText);
		writeAt(numbers, Math.max(0, cells - rightText.length), rightText);
		const centre = left + column / 2;
		writeAt(numbers, Math.round(centre - widthText.length / 2), widthText);
	}

	const termText = String(realWidth);
	const termLine = indent + " ".repeat(Math.max(0, Math.round((cells - termText.length) / 2))) + termText;
	return [
		termLine + " ".repeat(Math.max(0, cells + 2 - (termLine.length - indent.length))),
		`${indent}┌${"─".repeat(cells)}┐`,
		`${indent}│${bar}│`,
		`${indent}└${"─".repeat(cells)}┘`,
		indent + numbers.join(""),
	];
}

/** Widest run of items around `index` that fits in `budget`, gaps included. */
function fitWindow(lengths: number[], index: number, budget: number, gap: number): [number, number] {
	let start = index;
	let end = index;
	let used = lengths[index] ?? 0;
	while (start > 0 && used + (lengths[start - 1] ?? 0) + gap <= budget) {
		start -= 1;
		used += (lengths[start] ?? 0) + gap;
	}
	while (end < lengths.length - 1 && used + (lengths[end + 1] ?? 0) + gap <= budget) {
		used += (lengths[end + 1] ?? 0) + gap;
		end += 1;
	}
	return [start, end + 1];
}

function isShift(data: string, letter: "h" | "l" | "j" | "k" | "r"): boolean {
	return matchesKey(data, Key.shift(letter)) || data === letter.toUpperCase();
}

/**
 * `/px:focus config`: a settings dialog over the reading column.
 *
 * Edits a draft. Nothing reaches the terminal or the state file until Apply is
 * pressed, and Apply for session applies the same draft without persisting it.
 * Esc closes on an untouched draft, and asks before dropping a changed one.
 */
export class FocusModeConfigDialog implements Component, Focusable {
	private draft: FocusModeStateV1;
	private readonly snapshot: FocusModeStateV1;
	private selected = 0;
	private mode: Mode = "edit";
	private scroller: Scroller | null = null;
	private contentWidth = MAX_FRAME_WIDTH - 2;
	private contentPadding = 3;
	private _focused = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly getRealWidth: () => number,
		initial: FocusModeStateV1,
		private readonly onApply: (state: FocusModeStateV1, persist: boolean) => void,
		private readonly done: () => void,
	) {
		this.draft = { ...initial };
		this.snapshot = { ...initial };
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	invalidate(): void {}

	// Exposed for tests.
	get state(): FocusModeStateV1 {
		return { ...this.draft };
	}
	get mode_(): Mode {
		return this.mode;
	}
	get selectedRow(): Row {
		return ROWS[this.selected] ?? "enabled";
	}
	get scroller_(): Scroller | null {
		return this.scroller;
	}
	get pending(): boolean {
		return this.draft.enabled !== this.snapshot.enabled || this.draft.width !== this.snapshot.width || this.draft.bias !== this.snapshot.bias;
	}

	/** The value a row shows: the highlighted preset while its scroller is open. */
	private displayValue(field: "width" | "bias"): number {
		if (this.mode === "preset" && this.scroller?.field === field) return this.scroller.values[this.scroller.index] ?? this.draft[field];
		return this.draft[field];
	}

	private change(delta: number, fine: boolean): void {
		switch (ROWS[this.selected]) {
			case "enabled":
				this.draft = { ...this.draft, enabled: delta > 0 };
				break;
			case "width":
				this.draft = {
					...this.draft,
					width: step(this.draft.width, delta * (fine ? WIDTH_FINE_STEP : WIDTH_STEP), MIN_WIDTH, MAX_WIDTH),
				};
				break;
			case "bias":
				this.draft = {
					...this.draft,
					bias: step(this.draft.bias, delta * (fine ? BIAS_FINE_STEP : BIAS_STEP), MIN_BIAS, MAX_BIAS),
				};
				break;
			default:
				return;
		}
		this.tui.requestRender();
	}

	private resetRow(): void {
		switch (ROWS[this.selected]) {
			case "enabled":
				this.draft = { ...this.draft, enabled: true };
				break;
			case "width":
				this.draft = { ...this.draft, width: DEFAULT_WIDTH };
				break;
			case "bias":
				this.draft = { ...this.draft, bias: DEFAULT_BIAS };
				break;
			default:
				return;
		}
		this.tui.requestRender();
	}

	private resetAll(): void {
		this.draft = { version: 1, enabled: true, width: DEFAULT_WIDTH, bias: DEFAULT_BIAS };
		this.tui.requestRender();
	}

	private openScroller(field: "width" | "bias"): void {
		const current = this.draft[field];
		const values = mergePreset(current, field === "width" ? WIDTH_PRESETS : BIAS_PRESETS);
		this.mode = "preset";
		this.scroller = { field, values, index: Math.max(0, values.indexOf(current)) };
		this.tui.requestRender();
	}

	private moveScroller(delta: number): void {
		if (!this.scroller) return;
		const last = this.scroller.values.length - 1;
		this.scroller = { ...this.scroller, index: Math.min(last, Math.max(0, this.scroller.index + delta)) };
		this.tui.requestRender();
	}

	private commitScroller(): void {
		if (!this.scroller) return;
		const value = this.scroller.values[this.scroller.index];
		if (value !== undefined) this.draft = { ...this.draft, [this.scroller.field]: value };
		this.mode = "edit";
		this.scroller = null;
		this.tui.requestRender();
	}

	private apply(persist: boolean): void {
		this.onApply({ ...this.draft }, persist);
		this.done();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.mode === "preset") {
				this.mode = "edit";
				this.scroller = null;
				this.tui.requestRender();
				return;
			}
			if (this.mode === "confirm") {
				this.mode = "edit";
				this.tui.requestRender();
				return;
			}
			if (this.pending) {
				this.mode = "confirm";
				this.tui.requestRender();
				return;
			}
			this.done();
			return;
		}

		if (this.mode === "confirm") {
			// Only two ways out: throw the draft away, or go back and keep it.
			if (data === "d") {
				this.draft = { ...this.snapshot };
				this.done();
			}
			return;
		}

		if (this.mode === "preset") {
			if (matchesKey(data, Key.down) || data === "j" || matchesKey(data, Key.right) || data === "l") this.moveScroller(1);
			else if (matchesKey(data, Key.up) || data === "k" || matchesKey(data, Key.left) || data === "h") this.moveScroller(-1);
			else if (matchesKey(data, Key.enter)) this.commitScroller();
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") {
			this.selected = Math.min(ROWS.length - 1, this.selected + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.right) || data === "l") {
			this.change(1, false);
			return;
		}
		if (matchesKey(data, Key.left) || data === "h") {
			this.change(-1, false);
			return;
		}
		if (isShift(data, "l")) {
			this.change(1, true);
			return;
		}
		if (isShift(data, "h")) {
			this.change(-1, true);
			return;
		}
		if (isShift(data, "r")) {
			this.resetAll();
			return;
		}
		if (data === "r") {
			this.resetRow();
			return;
		}
		if (data === "0") {
			this.draft = { ...this.draft, bias: DEFAULT_BIAS };
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			switch (ROWS[this.selected]) {
				case "enabled":
					this.draft = { ...this.draft, enabled: !this.draft.enabled };
					this.tui.requestRender();
					break;
				case "width":
					this.openScroller("width");
					break;
				case "bias":
					this.openScroller("bias");
					break;
				case "reset":
					this.resetAll();
					break;
				case "apply":
					this.apply(true);
					break;
				case "apply-session":
					this.apply(false);
					break;
			}
		}
	}

	// --- rendering ---

	/**
	 * One row of the dialog, laid out like a quick actions row: a `›` marker,
	 * the label, then a right hand column holding the value and, for toggles,
	 * the `─●` / `○─` status marker.
	 */
	private actionLine(label: string, right: string, marker: { text: string; color: ThemeColor } | null, isSelected: boolean): string {
		const rightText = [right, marker?.text].filter((part) => part && part.length > 0).join(" ");
		const padding = this.contentPadding;
		const prefix = isSelected
			? `${padding > 1 ? " " : ""}›${" ".repeat(Math.max(0, padding - 2))}`
			: " ".repeat(padding);
		const rowWidth = Math.max(1, this.contentWidth - padding * 2);
		const actionWidth = Math.max(1, rowWidth - 1);
		const minGap = Math.min(5, Math.max(1, actionWidth - visibleWidth(rightText) - 1));
		const availableLeft = Math.max(1, actionWidth - visibleWidth(rightText) - minGap);
		const leftText = truncateToWidth(`${prefix}${label}`, availableLeft, "");
		const gap = " ".repeat(Math.max(minGap, actionWidth - visibleWidth(leftText) - visibleWidth(rightText)));

		const left = isSelected ? SELECTED_FG + leftText + "\x1b[39m" : leftText;
		const styledRight = right ? (isSelected ? SELECTED_FG + right + "\x1b[39m" : this.theme.fg("dim", right)) : "";
		let markerText = "";
		if (marker) {
			markerText = isSelected
				? SELECTED_FG + marker.text + "\x1b[39m"
				: this.theme.fg(marker.color, this.theme.bold(marker.text));
		}

		const row = `${left}${gap}${styledRight}${markerText ? ` ${markerText}` : ""}`;
		const clipped = truncateToWidth(row, rowWidth, "");
		const padded = clipped + " ".repeat(Math.max(0, rowWidth - visibleWidth(clipped)));
		const paddedRow = `${" ".repeat(padding)}${padded}${" ".repeat(padding)}`;
		return isSelected ? `${SELECTED_BG}${paddedRow}${RESET_BG}` : paddedRow;
	}

	/** Enabled row, with the same `─●` / `○─` toggle control quick actions uses. */
	private toggleMarker(enabled: boolean): { text: string; color: ThemeColor } {
		return enabled ? { text: "─●", color: "success" } : { text: "○─", color: "muted" };
	}

	render(width: number): string[] {
		const available = Math.max(1, width);
		const frameWidth = Math.min(Math.max(1, available - 2), MAX_FRAME_WIDTH);
		this.contentWidth = Math.max(1, frameWidth - 2);
		this.contentPadding = Math.min(3, Math.floor((this.contentWidth - 1) / 2));
		const outerWidth = Math.max(0, available - frameWidth);
		const outerLeft = " ".repeat(Math.floor(outerWidth / 2));
		const outerRight = " ".repeat(Math.ceil(outerWidth / 2));
		const outerLine = " ".repeat(available);
		const wrap = (line: string): string => outerLeft + line + outerRight;

		const body =
			this.mode === "confirm"
				? this.renderConfirm()
				: this.renderBody();
		const title =
			this.mode === "confirm"
				? "Focus / unsaved"
				: this.mode === "preset"
					? `Focus / ${this.scroller?.field === "width" ? "Width" : "Bias"}`
					: "Focus";

		return [outerLine, ...[this.top(title), ...body, this.bottom()].map(wrap), outerLine];
	}

	private renderConfirm(): string[] {
		const line = this.actionLine("discard changes", "", null, false);
		return [
			this.frame(""),
			this.frame(` ${this.theme.fg("warning", "Unsaved changes.")}`),
			this.frame(""),
			line,
			this.frame(`   ${this.theme.fg("dim", "esc  continue editing")}`),
			this.frame(""),
		];
	}

	private renderBody(): string[] {
		const cells = Math.max(8, this.contentWidth - this.contentPadding * 2 - 2);
		const indent = " ".repeat(this.contentPadding);
		const preview = previewFor(this.getRealWidth(), {
			...this.draft,
			width: this.displayValue("width"),
			bias: this.displayValue("bias"),
		});

		const lines: string[] = [this.frame("")];
		lines.push(
			this.frame(this.actionLine("Enabled", "", this.toggleMarker(this.draft.enabled), this.selectedRow === "enabled")),
		);
		lines.push(this.frame(this.actionLine("Width", String(this.displayValue("width")), null, this.selectedRow === "width")));
		if (this.mode === "preset" && this.scroller?.field === "width") lines.push(this.renderScrollerRow());
		lines.push(this.frame(this.actionLine("Bias", String(this.displayValue("bias")), null, this.selectedRow === "bias")));
		if (this.mode === "preset" && this.scroller?.field === "bias") lines.push(this.renderScrollerRow());
		lines.push(this.frame(""));
		for (const line of renderBarBlock(preview, cells, indent)) lines.push(this.frame(this.theme.fg("dim", line)));
		if (preview.inert) {
			lines.push(this.frame(this.theme.fg("dim", ` ${indent}no margin, the terminal is only ${preview.realWidth} wide`)));
		}
		lines.push(this.frame(""));
		lines.push(this.frame(this.actionLine("↺ Reset to defaults", "R", null, this.selectedRow === "reset")));
		lines.push(this.frame(""));
		lines.push(this.frame(this.actionLine("Apply", "↵ save", null, this.selectedRow === "apply")));
		lines.push(this.frame(this.actionLine("Apply for session", "↵ session", null, this.selectedRow === "apply-session")));
		lines.push(this.frame(""));
		const hints =
			this.mode === "preset"
				? "h l scroll · ↵ pick · esc cancel"
				: "j k move · h l change · H L fine · ↵ presets";
		lines.push(this.frame(this.theme.fg("dim", ` ${hints}`)));
		lines.push(this.frame(this.theme.fg("dim", " r row · R all · 0 center · esc close")));
		return lines;
	}

	/** Pad a content line to the frame width and add the side borders. */
	private frame(text = ""): string {
		const clipped = visibleWidth(text) > this.contentWidth ? truncateToWidth(text, this.contentWidth, "") : text;
		return `${borderOf("┃")}${clipped}${" ".repeat(Math.max(0, this.contentWidth - visibleWidth(clipped)))}${borderOf("┃")}`;
	}

	private top(title: string): string {
		const titleText = truncateToWidth(` ${title} `, Math.max(1, this.contentWidth - 4), "");
		const topFill = "━".repeat(Math.max(0, this.contentWidth - visibleWidth(titleText) - 3));
		return `${borderOf("╭━╾")}${borderOf(this.theme.bold(titleText))}${borderOf(`╼${topFill}╮`)}`;
	}

	private bottom(): string {
		return borderOf(`╰${"━".repeat(this.contentWidth)}╯`);
	}

	private renderScrollerRow(): string {
		if (!this.scroller) return this.frame();
		const { values, index } = this.scroller;
		const labels = values.map((value, i) => (i === index ? `[${value}]` : `${value}`));
		const lengths = labels.map((label) => visibleWidth(label));
		const budget = this.contentWidth - this.contentPadding * 2 - 2;
		const [start, end] = fitWindow(lengths, index, budget, 3);
		const parts: string[] = [];
		if (start > 0) parts.push(this.theme.fg("dim", "‹"));
		for (let i = start; i < end; i++) {
			const label = labels[i] ?? "";
			parts.push(i === index ? this.theme.fg("accent", label) : this.theme.fg("dim", label));
		}
		if (end < values.length) parts.push(this.theme.fg("dim", "›"));
		return this.frame(` ${" ".repeat(this.contentPadding)}${parts.join(this.theme.fg("dim", " · "))}`);
	}
}
