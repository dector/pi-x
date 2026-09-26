import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Pure formatter and publisher for the Processes editor widget.
 *
 * `formatProcessesWidget` renders the compact, non-interactive list of
 * processes shown immediately above the input editor via
 * `ctx.ui.setWidget(PROCESSES_WIDGET_ID, lines, { placement: "aboveEditor" })`.
 *
 * The formatter is independent of the Pi UI APIs so it is easy to test. The
 * `ProcessesWidget` wrapper owns the small amount of state needed to skip
 * redundant `setWidget` calls, to refresh elapsed time while a process is
 * running, and to clear the widget on shutdown.
 *
 * The widget is collapsed to a single summary line by default and expands when
 * the `panels` extension marks `processes` as the active panel.
 */

/** Stable widget id used by the proc extension. */
export const PROCESSES_WIDGET_ID = "px-processes-active";

/**
 * Pi renders at most 10 widget lines, so the formatter keeps the content within
 * this limit and emits its own `… N more` line instead. Each process occupies
 * one line; the first line is the summary header.
 */
export const PROCESSES_WIDGET_MAX_LINES = 10;

/**
 * Overall per-line display budget in Unicode code points. The formatter does
 * not know the terminal width, so it caps each line defensively; the renderer
 * still clips anything wider.
 */
export const PROCESSES_WIDGET_MAX_LINE_LENGTH = 120;

/** Nerd Font Font Awesome cogs (`nf-fa-cogs`). */
export const PROCESSES_WIDGET_ICON = "\u{f085}";

/** Match the Subagents widget's Material Design status glyphs. */
export const PROCESS_STATUS_ICONS = {
	running: "\u{f005a}", // arrow-right-drop-circle-outline
	stopping: "\u{f03e6}", // pause-circle-outline (waiting for exit)
	exitedOk: "\u{f012c}", // check
	exitedError: "\u{f0156}", // close
} as const;

/** Nerd Font Material Design unfold-more (`nf-md-unfold_more`), the expand affordance. */
export const PROCESSES_COLLAPSED_ICON = "\u{f054f}";

/**
 * How often the widget re-renders elapsed time while at least one process is
 * running. The elapsed display is second-granular, so a one-second tick is
 * enough and keeps the refresh bounded.
 */
export const PROCESSES_REFRESH_INTERVAL_MS = 1000;

/** Default exited-process retention, matching the retired neo-bar row. */
export const PROCESSES_DEFAULT_EXITED_RETENTION_MS = 60_000;

export type ProcessState = "running" | "stopping" | "exited";

/** Minimal process shape the formatter needs. */
export interface ProcessesWidgetEntry {
	name: string;
	state: ProcessState;
	pid?: number;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
	unread: number;
}

export interface ProcessesWidgetStyles {
	bold: (text: string) => string;
	dim: (text: string) => string;
	muted: (text: string) => string;
	accent: (text: string) => string;
	success: (text: string) => string;
	warning: (text: string) => string;
	error: (text: string) => string;
}

const identity = (text: string): string => text;
const PLAIN_STYLES: ProcessesWidgetStyles = {
	bold: identity,
	dim: identity,
	muted: identity,
	accent: identity,
	success: identity,
	warning: identity,
	error: identity,
};

export interface ProcessesWidgetFormatOptions {
	styles?: ProcessesWidgetStyles;
	exitedRetentionMs?: number;
}

type ProcessTone = "success" | "warning" | "muted" | "error";

function codePointLength(text: string): number {
	return Array.from(text).length;
}

/** Collapse whitespace and cap to `max` Unicode code points without splitting a surrogate pair. */
function truncate(text: string, max: number): string {
	const single = text.replace(/\s+/g, " ").trim();
	const points = Array.from(single);
	if (points.length <= max) return single;
	return `${points.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function pad(text: string, width: number): string {
	const length = codePointLength(text);
	return length >= width ? text : text + " ".repeat(width - length);
}

/** Compact elapsed rendering: `34s`, `5m02s`, `1h03m`. */
function formatElapsed(milliseconds: number): string {
	const total = Math.max(0, Math.floor(milliseconds / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

function exitLabel(entry: ProcessesWidgetEntry): string {
	if (entry.state !== "exited") return "-";
	if (entry.exitSignal) return `signal ${entry.exitSignal}`;
	return `code ${entry.exitCode ?? "?"}`;
}

/**
 * State color mapping, matching the retired neo-bar row: green running,
 * yellow stopping, gray exited (0), red exited (non-zero/signal).
 */
export function processStateTone(entry: ProcessesWidgetEntry): ProcessTone {
	if (entry.state === "exited") {
		const ok = entry.exitCode === 0 && !entry.exitSignal;
		return ok ? "muted" : "error";
	}
	if (entry.state === "stopping") return "warning";
	return "success";
}

/** Running/stopping first by start time, then exited by most recent end time. */
export function sortProcessEntries(a: ProcessesWidgetEntry, b: ProcessesWidgetEntry): number {
	const rank = (entry: ProcessesWidgetEntry): number => (entry.state === "exited" ? 1 : 0);
	const byRank = rank(a) - rank(b);
	if (byRank !== 0) return byRank;
	if (a.state === "exited" && b.state === "exited") return (b.endedAt ?? 0) - (a.endedAt ?? 0);
	return a.startedAt - b.startedAt;
}

/**
 * Filter exited processes past their retention window and sort the rest.
 * The returned array is a fresh, sorted copy.
 */
export function visibleProcessEntries(
	entries: readonly ProcessesWidgetEntry[],
	now = Date.now(),
	exitedRetentionMs = PROCESSES_DEFAULT_EXITED_RETENTION_MS,
): ProcessesWidgetEntry[] {
	return entries
		.filter((entry) => entry.state !== "exited" || (entry.endedAt !== undefined && now - entry.endedAt <= exitedRetentionMs))
		.sort(sortProcessEntries);
}

/** True when at least one process is visible after the retention filter. */
export function hasVisibleProcessEntries(
	entries: readonly ProcessesWidgetEntry[],
	now = Date.now(),
	exitedRetentionMs = PROCESSES_DEFAULT_EXITED_RETENTION_MS,
): boolean {
	return visibleProcessEntries(entries, now, exitedRetentionMs).length > 0;
}

function countStates(entries: readonly ProcessesWidgetEntry[]): { running: number; stopping: number; exited: number } {
	const counts = { running: 0, stopping: 0, exited: 0 };
	for (const entry of entries) counts[entry.state] += 1;
	return counts;
}

function summaryText(counts: { running: number; stopping: number; exited: number }): string {
	const parts: string[] = [];
	if (counts.running > 0) parts.push(`${counts.running} running`);
	if (counts.stopping > 0) parts.push(`${counts.stopping} stopping`);
	if (counts.exited > 0) parts.push(`${counts.exited} exited`);
	return parts.length > 0 ? parts.join(", ") : "0 running";
}

function formatEntryLine(
	entry: ProcessesWidgetEntry,
	now: number,
	styles: ProcessesWidgetStyles,
	nameWidth: number,
): string {
	const tone = processStateTone(entry);
	const icon = entry.state === "running"
		? PROCESS_STATUS_ICONS.running
		: entry.state === "stopping"
			? PROCESS_STATUS_ICONS.stopping
			: tone === "muted"
				? PROCESS_STATUS_ICONS.exitedOk
				: PROCESS_STATUS_ICONS.exitedError;
	const name = pad(truncate(entry.name, nameWidth), nameWidth);
	const durationMs = (entry.state === "exited" && entry.endedAt ? entry.endedAt : now) - entry.startedAt;
	const pid = entry.pid ? `pid ${entry.pid}` : "pid -";
	const details: string[] = [];
	if (entry.state === "exited") details.push(exitLabel(entry));
	if (entry.unread > 0) details.push(`+${entry.unread}`);
	const suffix = details.length > 0 ? `  ${details.join("  ")}` : "";
	return ` ${styles[tone](icon)} ${name}  ${pid}  ${styles.muted(entry.state)}  ${formatElapsed(durationMs)}${suffix}`;
}

/**
 * Render the expanded Processes widget.
 *
 * Returns `undefined` when no process is visible so the caller can clear the
 * widget. The result never exceeds `PROCESSES_WIDGET_MAX_LINES`; when more
 * processes are visible than fit, the last line reports the hidden count.
 */
export function formatProcessesWidget(
	entries: readonly ProcessesWidgetEntry[],
	now = Date.now(),
	options: ProcessesWidgetFormatOptions = {},
): string[] | undefined {
	const visible = visibleProcessEntries(entries, now, options.exitedRetentionMs ?? PROCESSES_DEFAULT_EXITED_RETENTION_MS);
	if (visible.length === 0) return undefined;

	const styles = options.styles ?? PLAIN_STYLES;
	const lines = [styles.accent(styles.bold(`${PROCESSES_WIDGET_ICON}  Processes (${summaryText(countStates(visible))})`))];
	const nameWidth = Math.min(20, Math.max(1, ...visible.map((entry) => codePointLength(entry.name))));

	let shown = 0;
	for (const entry of visible) {
		const mustReserveOverflowLine = shown + 1 < visible.length;
		const available = PROCESSES_WIDGET_MAX_LINES - lines.length - (mustReserveOverflowLine ? 1 : 0);
		if (available < 1) break;
		lines.push(formatEntryLine(entry, now, styles, nameWidth));
		shown += 1;
	}
	const hidden = visible.length - shown;
	if (hidden > 0) lines.push(styles.dim(`… ${hidden} more`));
	return lines;
}

/**
 * Render the collapsed Processes widget: the summary header plus an expand
 * icon. Returns `undefined` when no process is visible, so the caller clears it.
 */
export function formatCollapsedProcessesWidget(
	entries: readonly ProcessesWidgetEntry[],
	now = Date.now(),
	options: ProcessesWidgetFormatOptions = {},
): string[] | undefined {
	const full = formatProcessesWidget(entries, now, options);
	if (!full) return undefined;
	const styles = options.styles ?? PLAIN_STYLES;
	return [`${full[0]} ${styles.dim(PROCESSES_COLLAPSED_ICON)}`];
}

/** Match Subagents' one-cell horizontal inset and full-width widget rows. */
export function renderProcessesWidgetContent(content: readonly string[], width: number): string[] {
	const outerWidth = Math.max(1, width);
	const paddingX = Math.min(1, Math.max(0, Math.floor((outerWidth - 1) / 2)));
	const contentWidth = Math.max(1, outerWidth - paddingX * 2);
	const margin = " ".repeat(paddingX);
	return content.map((line) => {
		const fitted = truncateToWidth(line, contentWidth, "…");
		const fill = " ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)));
		return `${margin}${fitted}${fill}${margin}`;
	});
}

/** Injectable interval scheduling so the widget can be driven in tests. */
export interface ProcessesWidgetTimers {
	set: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
	clear: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_TIMERS: ProcessesWidgetTimers = {
	set: (callback, delayMs) => setInterval(callback, delayMs),
	clear: (handle) => clearInterval(handle),
};

export interface ProcessesWidgetOptions {
	/** Publishes (or clears, with `undefined`) the widget content. */
	setWidget: (content: string[] | undefined) => void;
	/** Injectable clock for deterministic tests. Defaults to `Date.now`. */
	now?: () => number;
	/** Provides the current entries for periodic refresh ticks. */
	listEntries?: () => readonly ProcessesWidgetEntry[];
	/** Tick interval while at least one process is running. Defaults to 1000ms. */
	refreshIntervalMs?: number;
	/** Injectable timers for tests. Defaults to `setInterval`/`clearInterval`. */
	timers?: ProcessesWidgetTimers;
	/** Optional terminal styling, resolved on every publish. */
	styles?: () => ProcessesWidgetStyles;
	/** Resolve the exited retention window. Defaults to 60s. */
	exitedRetentionMs?: () => number;
}

/**
 * Thin stateful wrapper around the process formatters.
 *
 * - `refresh()` re-renders and only calls `setWidget` when the content changed.
 * - While at least one process is running it owns a single bounded interval
 *   timer that re-renders elapsed time; the timer stops when the last running
 *   process settles and on `clear()`/`reset()` so it cannot leak.
 * - `clear()` always publishes `undefined` (used on shutdown).
 * - `reset()` forgets the last content, restores the collapsed default, and
 *   stops the timer so the next `refresh()` publishes even if unchanged.
 * - `setActive()` expands the widget for the active panel and collapses it
 *   otherwise. The widget is collapsed by default.
 */
export class ProcessesWidget {
	private last: string | undefined;
	private initialized = false;
	private entries: readonly ProcessesWidgetEntry[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	private collapsed = true;

	constructor(private readonly options: ProcessesWidgetOptions) {}

	refresh(entries: readonly ProcessesWidgetEntry[]): void {
		this.entries = entries;
		this.publish();
		this.syncTimer();
	}

	/** True while the widget is showing the one-line collapsed summary. */
	get isCollapsed(): boolean {
		return this.collapsed;
	}

	/** Expand when this extension owns the active panel; collapse otherwise. */
	setActive(active: boolean): void {
		this.setCollapsed(!active);
	}

	/** Collapse or expand the widget, republishing immediately. */
	setCollapsed(collapsed: boolean): void {
		if (this.collapsed === collapsed) return;
		this.collapsed = collapsed;
		// Force a publish even when the rendered line matches the last snapshot.
		this.last = undefined;
		this.publish();
		// Elapsed time is only visible while expanded, so the refresh timer only
		// runs in that mode.
		this.syncTimer();
	}

	private publish(): void {
		const now = (this.options.now ?? Date.now)();
		const options: ProcessesWidgetFormatOptions = {
			styles: this.options.styles?.(),
			exitedRetentionMs: this.options.exitedRetentionMs?.(),
		};
		const content = this.collapsed
			? formatCollapsedProcessesWidget(this.entries, now, options)
			: formatProcessesWidget(this.entries, now, options);
		const key = content?.join("\n");
		if (this.initialized && key === this.last) return;
		this.initialized = true;
		this.last = key;
		this.options.setWidget(content);
	}

	private syncTimer(): void {
		const active = !this.collapsed && this.entries.some((entry) => entry.state !== "exited");
		if (!active) {
			this.stopTimer();
			return;
		}
		if (this.timer) return;
		const delayMs = this.options.refreshIntervalMs ?? PROCESSES_REFRESH_INTERVAL_MS;
		this.timer = this.timers.set(() => {
			this.refresh(this.options.listEntries?.() ?? this.entries);
		}, delayMs);
	}

	private stopTimer(): void {
		if (!this.timer) return;
		this.timers.clear(this.timer);
		this.timer = undefined;
	}

	private get timers(): ProcessesWidgetTimers {
		return this.options.timers ?? DEFAULT_TIMERS;
	}

	clear(): void {
		this.stopTimer();
		this.initialized = true;
		this.last = undefined;
		this.options.setWidget(undefined);
	}

	reset(): void {
		this.stopTimer();
		this.initialized = false;
		this.last = undefined;
		this.collapsed = true;
	}
}
