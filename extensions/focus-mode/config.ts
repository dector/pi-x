import type { Theme } from "@earendil-works/pi-coding-agent";
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

/** Widest the frame gets, borders included. */
const FRAME_MAX = 47;
/** Cells used to draw the terminal in the visualization. */
const BAR_CELLS_MAX = 30;

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
	private contentWidth = FRAME_MAX - 2;
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
			if (data === "s" || data === "a") this.apply(true);
			else if (data === "S") this.apply(false);
			else if (data === "d") {
				this.draft = { ...this.snapshot };
				this.done();
			} else if (data === "c" || data === "q") {
				this.mode = "edit";
				this.tui.requestRender();
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

	/** Pad a content line to the frame width and add the side borders. */
	private frame(text = ""): string {
		const border = (s: string): string => this.theme.fg("border", s);
		const used = visibleWidth(text);
		const clipped = used > this.contentWidth ? truncateToWidth(text, this.contentWidth) : text;
		return border(`┃${clipped}${" ".repeat(Math.max(0, this.contentWidth - visibleWidth(clipped)))}┃`);
	}

	private top(title: string): string {
		const border = (s: string): string => this.theme.fg("border", s);
		const label = ` ${title} `;
		const fill = Math.max(0, this.contentWidth - visibleWidth(label) - 3);
		return border(`╭━╾`) + this.theme.bold(label) + border(`╼${"━".repeat(fill)}╮`);
	}

	/** A label/value row, framed, with the selected row highlighted. */
	private row(label: string, value: string, selected: boolean, hint?: string): string {
		const marker = selected ? "›" : " ";
		const left = ` ${marker} ${label}`;
		const right = [value, hint].filter((part) => part && part.length > 0).join(" ");
		const gap = Math.max(1, this.contentWidth - 1 - visibleWidth(left) - visibleWidth(right));
		const plain = ` ${left}${" ".repeat(gap)}${right}`;
		const padded = plain + " ".repeat(Math.max(0, this.contentWidth - visibleWidth(plain)));
		return this.frame(selected ? this.theme.bg("selectedBg", this.theme.fg("text", padded)) : padded);
	}

	private renderScrollerRow(): string {
		if (!this.scroller) return this.frame();
		const { values, index } = this.scroller;
		const labels = values.map((value, i) => (i === index ? `[${value}]` : `${value}`));
		const lengths = labels.map((label) => visibleWidth(label));
		const budget = this.contentWidth - 6;
		const [start, end] = fitWindow(lengths, index, budget, 3);
		const parts: string[] = [];
		if (start > 0) parts.push(this.theme.fg("dim", "‹"));
		for (let i = start; i < end; i++) {
			parts.push(i === index ? this.theme.fg("accent", labels[i] ?? "") : this.theme.fg("dim", labels[i] ?? ""));
		}
		if (end < values.length) parts.push(this.theme.fg("dim", "›"));
		return this.frame(`    ${parts.join(this.theme.fg("dim", " · "))}`);
	}

	private renderConfirm(): string[] {
		const options: [string, string, string][] = [
			["s", "save and close", "apply + write config"],
			["S", "session only", "apply, no write"],
			["d", "discard", "revert to how it was"],
			["c", "keep editing", ""],
		];
		const lines = [
			this.frame(),
			this.frame(`  ${this.theme.fg("warning", "Unsaved changes. Save or reset first?")}`),
			this.frame(),
		];
		for (const [key, label, detail] of options) {
			const left = `    ${this.theme.bold(key)}  ${label}`;
			const gap = Math.max(1, this.contentWidth - visibleWidth(left) - visibleWidth(detail));
			lines.push(this.frame(`${left}${" ".repeat(gap)}${this.theme.fg("dim", detail)}`));
		}
		lines.push(this.frame(), this.frame(`  ${this.theme.fg("dim", "esc back to editing")}`));
		return lines;
	}

	render(width: number): string[] {
		const available = Math.max(24, width);
		const total = Math.min(available, FRAME_MAX);
		this.contentWidth = Math.max(1, total - 2);
		const outer = Math.max(0, available - total);
		const outerLeft = " ".repeat(Math.floor(outer / 2));
		const outerRight = " ".repeat(Math.ceil(outer / 2));
		const wrap = (line: string): string => outerLeft + line + outerRight;

		if (this.mode === "confirm") {
			return [wrap(this.top("Focus / unsaved")), ...this.renderConfirm().map(wrap), wrap(this.bottom())];
		}

		const cells = Math.max(8, Math.min(BAR_CELLS_MAX, this.contentWidth - 8));
		const indent = " ".repeat(2);
		const preview = previewFor(this.getRealWidth(), {
			...this.draft,
			width: this.displayValue("width"),
			bias: this.displayValue("bias"),
		});

		const title = this.mode === "preset" ? `Focus / ${this.scroller?.field === "width" ? "Width" : "Bias"}` : "Focus";
		const lines: string[] = [wrap(this.top(title))];

		lines.push(wrap(this.frame()));
		lines.push(wrap(this.row("Enabled", this.draft.enabled ? "● on" : "○ off", this.selectedRow === "enabled")));
		lines.push(wrap(this.row("Width", String(this.displayValue("width")), this.selectedRow === "width")));
		if (this.mode === "preset" && this.scroller?.field === "width") lines.push(wrap(this.renderScrollerRow()));
		lines.push(wrap(this.row("Bias", String(this.displayValue("bias")), this.selectedRow === "bias")));
		if (this.mode === "preset" && this.scroller?.field === "bias") lines.push(wrap(this.renderScrollerRow()));
		lines.push(wrap(this.frame()));
		for (const line of renderBarBlock(preview, cells, indent)) lines.push(wrap(this.frame(line)));
		if (preview.inert) {
			lines.push(wrap(this.frame(`  ${this.theme.fg("dim", `no margin, the terminal is only ${preview.realWidth} wide`)}`)));
		}
		lines.push(wrap(this.frame()));
		lines.push(wrap(this.row("↺ Reset to defaults", "", this.selectedRow === "reset", "R")));
		lines.push(wrap(this.frame()));
		lines.push(wrap(this.row("Apply", "", this.selectedRow === "apply", "↵ save")));
		lines.push(wrap(this.row("Apply for session", "", this.selectedRow === "apply-session", "↵ this session only")));
		lines.push(wrap(this.frame()));
		const hint1 = this.mode === "preset" ? "h l scroll · ↵ pick · esc cancel" : "j k move · h l change · H L fine";
		const hint2 = this.mode === "preset" ? "↵ picks, esc keeps the old value" : "↵ presets · r row · R all · 0 center · esc";
		lines.push(wrap(this.frame(`  ${this.theme.fg("dim", hint1)}`)));
		lines.push(wrap(this.frame(`  ${this.theme.fg("dim", hint2)}`)));
		lines.push(wrap(this.bottom()));
		return lines;
	}

	private bottom(): string {
		return this.theme.fg("border", `╰${"─".repeat(this.contentWidth)}╯`);
	}
}
