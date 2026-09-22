/**
 * Top-level `/px:agents` run list.
 *
 * The built-in `ctx.ui.select` cannot render a non-selectable separator or bind
 * single-key shortcuts, so the manager uses this small custom component. The
 * pure row/shortcut helpers stay testable without a terminal; the component
 * only renders rows and forwards intents through callbacks.
 *
 * Runs are grouped into batches by dispatch: each batch renders a header row
 * (dispatch id, execution mode, run count, roll-up glyph) followed by its runs.
 * Active batches come first, settled batches second, with exactly one blank
 * non-selectable line between the two groups when both exist. Arrow keys skip
 * the separator and headers, `enter` opens the run's action menu, `d`
 * attaches/joins the selected run, `D` detaches an attached blocking dispatch,
 * and `esc` closes. An ineligible shortcut keeps the list open and shows a
 * concise inline warning.
 */

import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	MANAGER_ICONS,
	MANAGER_OUTCOME_TONE,
	buildManagerPicker,
	describeManagerBatchHeader,
	groupManagerBatches,
	managerBatchElapsed,
	managerRunOutcome,
	shouldShowBatchHeader,
	type ManagerBatch,
	type ManagerRunDescriptor,
} from "./manager.ts";

export const MANAGER_LIST_TITLE = "Subagent manager";
export const MANAGER_LIST_HELP = "↑↓ or j/k move • enter actions • d attach • D detach • esc close";
export const DEFAULT_MANAGER_LIST_VISIBLE = 12;

/** Structural subset the list needs from a manager entry. */
export interface ManagerListItemLike {
	descriptor: ManagerRunDescriptor;
}

/** One rendered list row: a batch header, a run, or the group separator. */
export type ManagerListRow =
	| { kind: "batch"; groupIndex: number }
	| { kind: "item"; itemIndex: number }
	| { kind: "separator" };

/**
 * Group runs by dispatch, keeping active batches before settled ones with one
 * non-selectable separator when both groups exist. A batch header row is emitted
 * only for a real dispatch or a multi-run batch, so ad-hoc single runs stay flat.
 */
export function buildManagerListRows(descriptors: readonly ManagerRunDescriptor[]): ManagerListRow[] {
	return buildManagerListRowsFromBatches(groupManagerBatches(descriptors));
}

/** Row builder shared by `buildManagerListRows` and the component. */
export function buildManagerListRowsFromBatches(batches: readonly ManagerBatch[]): ManagerListRow[] {
	const activeCount = batches.filter((batch) => batch.active).length;
	const rows: ManagerListRow[] = [];
	const emit = (from: number, to: number): void => {
		for (let groupIndex = from; groupIndex < to; groupIndex += 1) {
			const batch = batches[groupIndex];
			if (!batch) continue;
			if (shouldShowBatchHeader(batch)) rows.push({ kind: "batch", groupIndex });
			for (const itemIndex of batch.itemIndices) rows.push({ kind: "item", itemIndex });
		}
	};
	emit(0, activeCount);
	if (activeCount > 0 && activeCount < batches.length) rows.push({ kind: "separator" });
	emit(activeCount, batches.length);
	return rows;
}

export type ManagerShortcut = "d" | "D";

export type ManagerShortcutOutcome =
	| { kind: "attach" }
	| { kind: "detach" }
	| { kind: "warning"; message: string };

export interface ManagerShortcutContext {
	runId: string;
	/** The selected item can open a live or persisted transcript. */
	hasTranscript: boolean;
	/** The selected item is an attached blocking dispatch that can background. */
	detachable: boolean;
}

/** Resolve a single-key shortcut to an intent, or a user-facing warning. */
export function resolveManagerShortcut(
	shortcut: ManagerShortcut,
	context: ManagerShortcutContext,
): ManagerShortcutOutcome {
	if (shortcut === "d") {
		if (context.hasTranscript) return { kind: "attach" };
		return { kind: "warning", message: `No transcript available for ${context.runId}.` };
	}
	if (context.detachable) return { kind: "detach" };
	return { kind: "warning", message: `Detach unavailable: ${context.runId} is not an attached blocking dispatch.` };
}

export type ManagerListResult =
	| { type: "select"; itemIndex: number }
	| { type: "attach"; itemIndex: number }
	| { type: "detach"; itemIndex: number }
	| { type: "cancel" };

export interface ManagerListTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export type ManagerListNavigationKey =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.confirm"
	| "tui.select.cancel";

/** App keybinding subset used by the custom selector. */
export interface ManagerListKeybindings {
	matches: (data: string, keybinding: ManagerListNavigationKey) => boolean;
}

export interface ManagerListViewOptions<T extends ManagerListItemLike> {
	items: readonly T[];
	theme: ManagerListTheme;
	keybindings: ManagerListKeybindings;
	requestRender: () => void;
	done: (result: ManagerListResult) => void;
	/** Whether the item can open a live or persisted transcript for `d`. */
	hasTranscript: (item: T) => boolean;
	/** Injectable clock for deterministic elapsed labels. */
	now?: () => number;
	maxVisible?: number;
}

export class ManagerListView<T extends ManagerListItemLike> implements Component {
	private readonly options: ManagerListViewOptions<T>;
	private readonly labels: string[];
	private readonly batches: ManagerBatch[];
	private readonly rows: ManagerListRow[];
	private readonly selectable: number[];
	private readonly now: number;
	private readonly summary: string;
	private selectedRow: number;
	private status: string | undefined;

	constructor(options: ManagerListViewOptions<T>) {
		this.options = options;
		this.now = options.now?.() ?? Date.now();
		const descriptors = options.items.map((item) => item.descriptor);
		this.labels = buildManagerPicker(descriptors, this.now).labels;
		this.batches = groupManagerBatches(descriptors);
		this.rows = buildManagerListRowsFromBatches(this.batches);
		this.selectable = this.rows
			.map((row, index) => (row.kind === "item" ? index : -1))
			.filter((index) => index >= 0);
		this.selectedRow = this.selectable[0] ?? 0;

		const counts = { active: 0, blocked: 0, failed: 0, finished: 0 };
		for (const descriptor of descriptors) {
			const outcome = managerRunOutcome(descriptor);
			if (outcome === "blocked") counts.blocked += 1;
			else if (descriptor.active) counts.active += 1;
			else if (outcome === "failed" || outcome === "canceled") counts.failed += 1;
			else counts.finished += 1;
		}
		this.summary = [
			counts.active ? `${counts.active} active` : "",
			counts.blocked ? `${counts.blocked} blocked` : "",
			counts.failed ? `${counts.failed} failed` : "",
			counts.finished ? `${counts.finished} finished` : "",
		]
			.filter(Boolean)
			.join(" · ");
	}

	/** Original item index for the selected run, or undefined if none. */
	get selectedItemIndex(): number | undefined {
		const row = this.rows[this.selectedRow];
		return row?.kind === "item" ? row.itemIndex : undefined;
	}

	get selectedItem(): T | undefined {
		const index = this.selectedItemIndex;
		return index === undefined ? undefined : this.options.items[index];
	}

	/** Current inline warning, if a shortcut was ineligible. */
	get statusMessage(): string | undefined {
		return this.status;
	}

	invalidate(): void {
		// No cached render state; themed strings are built on every render.
	}

	handleInput(data: string): void {
		const keybindings = this.options.keybindings;
		if (keybindings.matches(data, "tui.select.up") || data === "k" || data === "K") {
			this.move(-1);
		} else if (keybindings.matches(data, "tui.select.down") || data === "j" || data === "J") {
			this.move(1);
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			const index = this.selectedItemIndex;
			if (index !== undefined) this.options.done({ type: "select", itemIndex: index });
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.options.done({ type: "cancel" });
		} else if (matchesKey(data, "d")) {
			this.applyShortcut("d");
		} else if (matchesKey(data, "shift+d")) {
			this.applyShortcut("D");
		}
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const theme = this.options.theme;
		const border = truncateToWidth(theme.fg("dim", "─".repeat(w)), w);
		const lines: string[] = [border, "", truncateToWidth(` ${theme.fg("accent", theme.bold(MANAGER_LIST_TITLE))}`, w)];
		if (this.summary) lines.push(truncateToWidth(` ${theme.fg("dim", this.summary)}`, w));
		lines.push("");

		const { start, end } = this.visibleRange();
		for (let index = start; index < end; index++) {
			const row = this.rows[index];
			if (!row) continue;
			if (row.kind === "separator") {
				lines.push("");
				continue;
			}
			if (row.kind === "batch") {
				lines.push(this.renderBatch(row.groupIndex, w));
				continue;
			}
			const selected = index === this.selectedRow;
			const descriptor = this.options.items[row.itemIndex]?.descriptor;
			if (!descriptor) continue;
			const outcome = managerRunOutcome(descriptor);
			const icon = theme.fg(MANAGER_OUTCOME_TONE[outcome], MANAGER_ICONS[outcome]);
			const prefix = selected ? theme.fg("thinkingHigh", " → ") : "   ";
			const label = this.labels[row.itemIndex] ?? "";
			const styledLabel = selected ? theme.fg("thinkingHigh", theme.bold(label)) : label;
			lines.push(truncateToWidth(`${prefix}${icon} ${styledLabel}`, w));
		}

		if (start > 0 || end < this.rows.length) {
			const ordinal = Math.max(0, this.selectable.indexOf(this.selectedRow)) + 1;
			lines.push(truncateToWidth(theme.fg("dim", `   (${ordinal}/${this.selectable.length})`), w));
		}
		lines.push("");
		if (this.status) lines.push(truncateToWidth(` ${theme.fg("warning", this.status)}`, w));
		lines.push(truncateToWidth(` ${theme.fg("dim", MANAGER_LIST_HELP)}`, w));
		lines.push("");
		lines.push(border);
		return lines;
	}

	/** Header row: glyphs + dispatch/execution/count on the left, rollup + clock on the right. */
	private renderBatch(groupIndex: number, width: number): string {
		const theme = this.options.theme;
		const batch = this.batches[groupIndex];
		if (!batch) return "";
		const right = `${MANAGER_ICONS[batch.outcome]} ${managerBatchElapsed(batch, this.now)}`;
		const leftBudget = Math.max(1, width - visibleWidth(right) - 2);
		const left = truncateToWidth(` ${describeManagerBatchHeader(batch)}`, leftBudget, "…");
		const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 1));
		const line = `${theme.fg("muted", left)}${gap}${theme.fg(MANAGER_OUTCOME_TONE[batch.outcome], right)}`;
		return truncateToWidth(line, width);
	}

	/** Move selection by one, wrapping and skipping the group separator. */
	private move(delta: number): void {
		if (this.selectable.length === 0) return;
		const position = this.selectable.indexOf(this.selectedRow);
		const next = position < 0 ? 0 : (position + delta + this.selectable.length) % this.selectable.length;
		this.selectedRow = this.selectable[next] ?? this.selectedRow;
		this.status = undefined;
		this.options.requestRender();
	}

	private applyShortcut(shortcut: ManagerShortcut): void {
		const item = this.selectedItem;
		const index = this.selectedItemIndex;
		if (!item || index === undefined) return;
		const outcome = resolveManagerShortcut(shortcut, {
			runId: item.descriptor.runId,
			hasTranscript: this.options.hasTranscript(item),
			detachable: Boolean(item.descriptor.attachedBlocking && item.descriptor.dispatchId),
		});
		if (outcome.kind === "warning") {
			this.status = outcome.message;
			this.options.requestRender();
			return;
		}
		this.options.done({ type: outcome.kind, itemIndex: index });
	}

	private visibleRange(): { start: number; end: number } {
		const maxVisible = Math.max(1, this.options.maxVisible ?? DEFAULT_MANAGER_LIST_VISIBLE);
		if (this.rows.length <= maxVisible) return { start: 0, end: this.rows.length };
		const start = Math.max(0, Math.min(this.selectedRow - Math.floor(maxVisible / 2), this.rows.length - maxVisible));
		return { start, end: start + maxVisible };
	}
}
