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

import type { SubagentRunState } from "./types.ts";

/** Stable widget id used by the subagent extension. */
export const ACTIVE_SUBAGENT_WIDGET_ID = "px-subagents-active";

/**
 * Pi renders at most 10 widget lines and appends its own truncation notice for
 * anything longer, so the formatter keeps the content within this limit and
 * emits its own `… N more` line instead.
 */
export const ACTIVE_SUBAGENT_WIDGET_MAX_LINES = 10;

/**
 * Overall per-line display budget in Unicode code points. The formatter does
 * not know the terminal width, so it caps each line defensively; the terminal
 * still clips anything wider. Keeping it here stops a long task preview from
 * pushing state/tool data off-screen.
 */
export const ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH = 100;

/** Per-field caps that keep one run line compact before the line budget applies. */
export const ACTIVE_SUBAGENT_AGENT_MAX_LENGTH = 16;
export const ACTIVE_SUBAGENT_STATE_MAX_LENGTH = 16;
export const ACTIVE_SUBAGENT_TOOL_MAX_LENGTH = 20;
export const ACTIVE_SUBAGENT_TASK_MAX_LENGTH = 40;

/** Shortest-run-id budget that still preserves the distinctive tail. */
export const ACTIVE_SUBAGENT_RUN_ID_MAX_LENGTH = 12;

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
		activeTool?: string;
		pendingApproval?: { method: string; title?: string };
	};
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
): string[] | undefined {
	const active = runs.filter((run) => !run.completedAt);
	if (active.length === 0) return undefined;

	const header = `Subagents (${active.length} active)`;
	const runLineBudget = ACTIVE_SUBAGENT_WIDGET_MAX_LINES - 1;
	const shown =
		active.length <= runLineBudget
			? active
			: active.slice(0, Math.max(0, runLineBudget - 1));

	const lines = [header, ...shown.map((run) => formatActiveSubagentWidgetLine(run, now))];
	const hidden = active.length - shown.length;
	if (hidden > 0) lines.push(`… ${hidden} more`);
	return lines.slice(0, ACTIVE_SUBAGENT_WIDGET_MAX_LINES);
}

/** Format one run line: icon, agent, short run id, state, elapsed, tool, task. */
function formatActiveSubagentWidgetLine(run: ActiveSubagentWidgetRun, now: number): string {
	const icon = run.result.pendingApproval ? "◐" : stateIcon(run.result.state);
	const state = truncate(
		run.result.pendingApproval ? "waiting approval" : (run.result.state ?? "running").replace(/-/g, " "),
		ACTIVE_SUBAGENT_STATE_MAX_LENGTH,
	);
	const agent = truncate(run.agentName, ACTIVE_SUBAGENT_AGENT_MAX_LENGTH);
	const elapsed = formatElapsed((run.completedAt ?? now) - run.startedAt);
	const tool = run.result.activeTool
		? ` · ${truncate(run.result.activeTool, ACTIVE_SUBAGENT_TOOL_MAX_LENGTH)}`
		: "";
	const prefix = `${icon} ${agent} ${shortRunId(run.runId)} ${state} · ${elapsed}${tool}`;
	if (!run.task) return truncate(prefix, ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH);

	// Reserve the two-space separator, then give the task whatever budget is
	// left (never more than its own cap). This keeps the whole line bounded
	// even when the agent name, state, and tool all sit at their caps.
	const remaining = ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH - codePointLength(prefix) - 2;
	if (remaining <= 0) return truncate(prefix, ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH);
	const task = truncate(run.task, Math.min(ACTIVE_SUBAGENT_TASK_MAX_LENGTH, remaining));
	return truncate(`${prefix}  ${task}`, ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH);
}

function stateIcon(state: SubagentRunState | undefined): string {
	switch (state) {
		case "starting":
			return "○";
		case "failed":
			return "✗";
		case "waiting-approval":
		case "pause-requested":
		case "paused":
		case "resuming":
		case "aborting":
			return "◐";
		default:
			return "●";
	}
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

/**
 * Keep the run id informative and distinctive without letting it push out the
 * task preview. Real ids share a long `sa-<time>-<seq>` prefix, so keep the
 * unique tail (the random suffix and sequence) and trim from the left.
 */
function shortRunId(runId: string, max = ACTIVE_SUBAGENT_RUN_ID_MAX_LENGTH): string {
	const points = Array.from(runId);
	if (points.length <= max) return runId;
	return `…${points.slice(-(max - 1)).join("")}`;
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
		const content = formatActiveSubagentWidget(this.runs, (this.options.now ?? Date.now)());
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
