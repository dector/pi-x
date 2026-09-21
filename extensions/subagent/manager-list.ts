/**
 * Top-level `/px:agents` run list.
 *
 * The built-in `ctx.ui.select` cannot render a non-selectable separator or bind
 * single-key shortcuts, so the manager uses this small custom component. The
 * pure row/shortcut helpers stay testable without a terminal; the component
 * only renders rows and forwards intents through callbacks.
 *
 * Active runs are grouped first, finished runs second, with exactly one blank
 * non-selectable line between the two groups when both exist. Arrow keys skip
 * the separator, `enter` opens the run's action menu, `d` attaches/joins the
 * selected run, `D` detaches an attached blocking dispatch, and `esc` closes.
 * An ineligible shortcut keeps the list open and shows a concise inline warning.
 */

import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { buildManagerPicker, type ManagerRunDescriptor } from "./manager.ts";

export const MANAGER_LIST_TITLE = "Subagent manager";
export const MANAGER_LIST_HELP = "↑↓ move • enter actions • d attach • D detach • esc close";
export const DEFAULT_MANAGER_LIST_VISIBLE = 12;

/** Structural subset the list needs from a manager entry. */
export interface ManagerListItemLike {
	descriptor: ManagerRunDescriptor;
}

/** One rendered list row: either a run or the non-selectable group separator. */
export type ManagerListRow = { kind: "item"; itemIndex: number } | { kind: "separator" };

/**
 * Group active runs before finished runs, inserting one separator row between
 * them only when both groups are present. Relative order inside a group is
 * preserved, and `itemIndex` maps each item row back to the original array.
 */
export function buildManagerListRows(descriptors: readonly ManagerRunDescriptor[]): ManagerListRow[] {
	const active: number[] = [];
	const finished: number[] = [];
	descriptors.forEach((descriptor, index) => {
		(descriptor.active ? active : finished).push(index);
	});
	const rows: ManagerListRow[] = active.map((itemIndex) => ({ kind: "item", itemIndex }));
	if (active.length > 0 && finished.length > 0) rows.push({ kind: "separator" });
	for (const itemIndex of finished) rows.push({ kind: "item", itemIndex });
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
	private readonly rows: ManagerListRow[];
	private readonly selectable: number[];
	private selectedRow: number;
	private status: string | undefined;

	constructor(options: ManagerListViewOptions<T>) {
		this.options = options;
		this.labels = buildManagerPicker(
			options.items.map((item) => item.descriptor),
			options.now?.() ?? Date.now(),
		).labels;
		this.rows = buildManagerListRows(options.items.map((item) => item.descriptor));
		this.selectable = this.rows
			.map((row, index) => (row.kind === "item" ? index : -1))
			.filter((index) => index >= 0);
		this.selectedRow = this.selectable[0] ?? 0;
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
		if (keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
		} else if (keybindings.matches(data, "tui.select.down")) {
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
		const lines: string[] = [
			border,
			"",
			truncateToWidth(` ${theme.fg("accent", theme.bold(MANAGER_LIST_TITLE))}`, w),
			"",
		];

		const { start, end } = this.visibleRange();
		for (let index = start; index < end; index++) {
			const row = this.rows[index];
			if (!row) continue;
			if (row.kind === "separator") {
				lines.push("");
				continue;
			}
			const selected = index === this.selectedRow;
			const prefix = selected ? " → " : "   ";
			const label = this.labels[row.itemIndex] ?? "";
			const text = prefix + label;
			lines.push(truncateToWidth(selected ? theme.fg("accent", text) : text, w));
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
