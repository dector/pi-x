/**
 * Pure formatter and publisher for the active-subagents editor widget.
 *
 * `formatActiveSubagentWidget` renders the compact, non-interactive list of
 * active runs shown immediately above the input editor via
 * `ctx.ui.setWidget(id, lines, { placement: "aboveEditor" })`.
 *
 * The formatter is independent of the Pi UI APIs so it is easy to test. The
 * `ActiveSubagentWidget` wrapper owns the small amount of state needed to
 * skip redundant `setWidget` calls, to refresh elapsed time while a run is
 * active, and to clear the widget on shutdown.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SubagentRunState, UsageStats } from "./types.ts";

/** Stable widget id used by the subagent extension. */
export const ACTIVE_SUBAGENT_WIDGET_ID = "px-subagents-active";

/**
 * Pi renders at most 10 widget lines and appends its own truncation notice for
 * anything longer, so the formatter keeps the content within this limit and
 * emits its own `… N more` line instead. Each run occupies three lines.
 */
export const ACTIVE_SUBAGENT_WIDGET_MAX_LINES = 10;

/**
 * Overall per-line display budget in Unicode code points. The formatter does
 * not know the terminal width, so it caps each line defensively; the terminal
 * still clips anything wider. Keeping it here stops a long task preview from
 * pushing state/tool data off-screen.
 */
export const ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH = 120;

/** Per-field caps that keep the three run lines compact before the line budget applies. */
export const ACTIVE_SUBAGENT_AGENT_MAX_LENGTH = 24;
export const ACTIVE_SUBAGENT_STATE_MAX_LENGTH = 16;
export const ACTIVE_SUBAGENT_MODEL_MAX_LENGTH = 42;
export const ACTIVE_SUBAGENT_TASK_MAX_LENGTH = 100;
export const ACTIVE_SUBAGENT_RUN_ID_MAX_LENGTH = 28;

/** Nerd Font Material Design robot (`nf-md-robot`). */
export const ACTIVE_SUBAGENT_WIDGET_ICON = "\u{f06a9}";

/**
 * How often the widget re-renders elapsed time while at least one run is
 * active. The elapsed display is second-granular, so a one-second tick is
 * enough and keeps the refresh bounded.
 */
export const ACTIVE_SUBAGENT_REFRESH_INTERVAL_MS = 1000;

/** Minimal active-run shape the formatter needs; `SubagentRunRuntime` matches it. */
export interface ActiveSubagentWidgetRun {
	runId: string;
	agentName: string;
	task: string;
	startedAt: number;
	completedAt?: number;
	result: {
		state?: SubagentRunState;
		model?: string;
		thinkingLevel?: ThinkingLevel;
		usage?: UsageStats;
		pendingApproval?: { method: string; title?: string };
	};
}

export interface ActiveSubagentWidgetStyles {
	bold: (text: string) => string;
	italic: (text: string) => string;
	accent: (text: string) => string;
	muted: (text: string) => string;
	dim: (text: string) => string;
	success: (text: string) => string;
	warning: (text: string) => string;
	error: (text: string) => string;
}

const identity = (text: string): string => text;
const PLAIN_STYLES: ActiveSubagentWidgetStyles = {
	bold: identity,
	italic: identity,
	accent: identity,
	muted: identity,
	dim: identity,
	success: identity,
	warning: identity,
	error: identity,
};

export interface ActiveSubagentWidgetFormatOptions {
	styles?: ActiveSubagentWidgetStyles;
	contextWindowForModel?: (model?: string) => number | undefined;
}

/**
 * Render the active-subagents widget.
 *
 * Returns `undefined` when no run is active so the caller can clear the widget.
 * Completed runs are excluded. The result never exceeds
 * `ACTIVE_SUBAGENT_WIDGET_MAX_LINES`; when more runs are active than fit, the
 * last line reports the hidden count.
 */
export function formatActiveSubagentWidget(
	runs: readonly ActiveSubagentWidgetRun[],
	now = Date.now(),
	options: ActiveSubagentWidgetFormatOptions = {},
): string[] | undefined {
	const active = runs.filter((run) => !run.completedAt);
	if (active.length === 0) return undefined;

	const styles = options.styles ?? PLAIN_STYLES;
	const header = styles.accent(styles.bold(`${ACTIVE_SUBAGENT_WIDGET_ICON} Subagents (${active.length} active)`));
	const fullRunBudget = Math.floor((ACTIVE_SUBAGENT_WIDGET_MAX_LINES - 1) / 3);
	// A hidden-count notice cannot fit after three complete runs, so overflow
	// reserves that notice by showing two runs and leaving two rows unused.
	const runBudget = active.length > fullRunBudget
		? Math.floor((ACTIVE_SUBAGENT_WIDGET_MAX_LINES - 2) / 3)
		: fullRunBudget;
	const shown = active.slice(0, runBudget);
	const lines = [
		header,
		...shown.flatMap((run) => formatActiveSubagentWidgetLines(run, now, styles, options.contextWindowForModel)),
	];
	const hidden = active.length - shown.length;
	if (hidden > 0) lines.push(styles.dim(styles.italic(`… ${hidden} more`)));
	return lines.slice(0, ACTIVE_SUBAGENT_WIDGET_MAX_LINES);
}

/** Format one run as identity, runtime details, and task lines. */
function formatActiveSubagentWidgetLines(
	run: ActiveSubagentWidgetRun,
	now: number,
	styles: ActiveSubagentWidgetStyles,
	contextWindowForModel?: (model?: string) => number | undefined,
): [string, string, string] {
	const appearance = stateAppearance(run.result.state, Boolean(run.result.pendingApproval));
	const state = truncate(
		run.result.pendingApproval ? "waiting approval" : (run.result.state ?? "running").replace(/-/g, " "),
		ACTIVE_SUBAGENT_STATE_MAX_LENGTH,
	);
	const agent = truncate(run.agentName, ACTIVE_SUBAGENT_AGENT_MAX_LENGTH);
	const id = truncate(run.runId, ACTIVE_SUBAGENT_RUN_ID_MAX_LENGTH);
	const identityLine = " " + styles[appearance.tone](appearance.icon) + " " + styles.dim(`[${id}]`)
		+ styles.dim(" · ") + styles.muted(agent);

	const elapsed = formatElapsed((run.completedAt ?? now) - run.startedAt);
	const turns = formatTurns(run.result.usage?.turns);
	const usage = truncate(formatWidgetUsage(run.result.usage, run.result.model, contextWindowForModel), 30);
	const activity = `${state} ${elapsed}${turns ? `, ${turns}` : ""}${usage ? ` · ${usage}` : ""}`;
	const effort = run.result.thinkingLevel;
	const effortSuffix = effort ? ` (${effort})` : "";
	const detailsPrefix = " │ ";
	const modelSuffix = ` · ${activity}`;
	const modelBudget = Math.max(
		1,
		Math.min(
			ACTIVE_SUBAGENT_MODEL_MAX_LENGTH,
			ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH - codePointLength(detailsPrefix + effortSuffix + modelSuffix),
		),
	);
	const model = run.result.model ? truncate(run.result.model, modelBudget) : undefined;
	let detailsLine = styles.dim(detailsPrefix);
	if (model) {
		detailsLine += styles.muted(model);
		if (effort) detailsLine += styles.dim(" (") + styles.muted(effort) + styles.dim(")");
		detailsLine += styles.dim(` · ${activity}`);
	} else if (effort) {
		detailsLine += styles.muted(effort) + styles.dim(` · ${activity}`);
	} else {
		detailsLine += styles.dim(activity);
	}

	const task = truncate(run.task || "(no task description)", ACTIVE_SUBAGENT_TASK_MAX_LENGTH);
	const taskLine = styles.dim(" │ ") + styles.muted(task);
	return [identityLine, detailsLine, taskLine];
}

function formatWidgetUsage(
	usage: UsageStats | undefined,
	model: string | undefined,
	contextWindowForModel?: (model?: string) => number | undefined,
): string {
	if (!usage) return "";
	const parts: string[] = [];
	if (usage.contextTokens > 0) {
		const contextWindow = contextWindowForModel?.(model);
		if (contextWindow && contextWindow > 0) {
			parts.push(`ctx:${Math.round((usage.contextTokens / contextWindow) * 100)}%`);
		}
	}
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

function formatTurns(turns: number | undefined): string {
	return turns && turns > 0 ? `${turns} turn${turns === 1 ? "" : "s"}` : "";
}

type StateTone = "success" | "warning" | "error" | "muted";

function stateAppearance(
	state: SubagentRunState | undefined,
	pendingApproval: boolean,
): { icon: string; tone: StateTone } {
	if (state === "failed") return { icon: "✗", tone: "error" };
	if (pendingApproval || ["waiting-approval", "pause-requested", "paused", "resuming", "aborting"].includes(state ?? "")) {
		return { icon: "◐", tone: "warning" };
	}
	if (state === "starting") return { icon: "○", tone: "muted" };
	return { icon: "●", tone: "success" };
}

/** Compact elapsed rendering: `34s`, `5m 2s`, `1h 3m`. */
function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		const remainder = seconds % 60;
		return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
	}
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function codePointLength(text: string): number {
	return Array.from(text).length;
}

/**
 * Collapse whitespace and cap to `max` Unicode code points. Truncating by code
 * point rather than UTF-16 unit avoids splitting a surrogate pair (for example
 * an emoji) at the cut.
 */
function truncate(text: string, max: number): string {
	const single = text.replace(/\s+/g, " ").trim();
	const points = Array.from(single);
	if (points.length <= max) return single;
	return `${points.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** Injectable interval scheduling so the widget can be driven in tests. */
export interface ActiveSubagentWidgetTimers {
	set: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
	clear: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_TIMERS: ActiveSubagentWidgetTimers = {
	set: (callback, delayMs) => setInterval(callback, delayMs),
	clear: (handle) => clearInterval(handle),
};

export interface ActiveSubagentWidgetOptions {
	/** Publishes (or clears, with `undefined`) the widget content. */
	setWidget: (content: string[] | undefined) => void;
	/** Injectable clock for deterministic tests. Defaults to `Date.now`. */
	now?: () => number;
	/**
	 * Provides the current runs for periodic refresh ticks. When omitted, the
	 * tick re-renders the last snapshot passed to `refresh()`; both keep elapsed
	 * time moving during a silent (no-update) period.
	 */
	listRuns?: () => readonly ActiveSubagentWidgetRun[];
	/** Tick interval while at least one run is active. Defaults to 1000ms. */
	refreshIntervalMs?: number;
	/** Injectable timers for tests. Defaults to `setInterval`/`clearInterval`. */
	timers?: ActiveSubagentWidgetTimers;
	/** Optional terminal styling, resolved on every publish. */
	styles?: () => ActiveSubagentWidgetStyles;
	/** Resolve a model's context window for the live context percentage. */
	contextWindowForModel?: (model?: string) => number | undefined;
}

/**
 * Thin stateful wrapper around `formatActiveSubagentWidget`.
 *
 * - `refresh()` re-renders and only calls `setWidget` when the content changed,
 *   so a burst of progress updates does not rebuild the widget needlessly.
 * - While at least one run is active it owns a single bounded interval timer
 *   that re-renders elapsed time; the timer is stopped when the last run
 *   settles and on `clear()`/`reset()` so it cannot leak.
 * - `clear()` always publishes `undefined` (used on shutdown).
 * - `reset()` forgets the last content and stops the timer so the next
 *   `refresh()` publishes even if the rendered content is unchanged (used on a
 *   new session or when the tree is restored).
 */
export class ActiveSubagentWidget {
	private last: string | undefined;
	private initialized = false;
	private runs: readonly ActiveSubagentWidgetRun[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly options: ActiveSubagentWidgetOptions) {}

	refresh(runs: readonly ActiveSubagentWidgetRun[]): void {
		this.runs = runs;
		this.publish();
		this.syncTimer();
	}

	private publish(): void {
		const content = formatActiveSubagentWidget(this.runs, (this.options.now ?? Date.now)(), {
			styles: this.options.styles?.(),
			contextWindowForModel: this.options.contextWindowForModel,
		});
		const key = content?.join("\n");
		if (this.initialized && key === this.last) return;
		this.initialized = true;
		this.last = key;
		this.options.setWidget(content);
	}

	private syncTimer(): void {
		const active = this.runs.some((run) => !run.completedAt);
		if (!active) {
			this.stopTimer();
			return;
		}
		if (this.timer) return;
		const delayMs = this.options.refreshIntervalMs ?? ACTIVE_SUBAGENT_REFRESH_INTERVAL_MS;
		this.timer = this.timers.set(() => {
			this.refresh(this.options.listRuns?.() ?? this.runs);
		}, delayMs);
	}

	private stopTimer(): void {
		if (!this.timer) return;
		this.timers.clear(this.timer);
		this.timer = undefined;
	}

	private get timers(): ActiveSubagentWidgetTimers {
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
	}
}
