/**
 * Pure helpers for the subagent status-bar row.
 *
 * `formatSubagentStatusRow` renders the row; `StatusBarPresence` tracks whether
 * the optional `status-bar` extension answered the availability ping and, when
 * the row is needed but the delay elapses first, warns exactly once.
 *
 * The row is published by the subagent extension itself (order 50, so it sorts
 * above proc's row at order 100) and only while at least one child is running.
 */

export const SUBAGENT_STATUS_ROW_ID = "subagent";
/** Lower than proc's 100 so the running count appears above process status. */
export const SUBAGENT_STATUS_ROW_ORDER = 50;

const ANSI_RESET = "\u001b[0m";
const ANSI_CYAN = "\u001b[38;5;44m";

/** Returns undefined when there is nothing to show (count <= 0). */
export function formatSubagentStatusRow(count: number): string | undefined {
	if (!Number.isFinite(count)) return undefined;
	const running = Math.floor(count);
	if (running <= 0) return undefined;
	const noun = running === 1 ? "subagent" : "subagents";
	return `${ANSI_CYAN}\u25c6${ANSI_RESET} ${running} ${noun} running`;
}

export interface StatusBarProbeTimers {
	set(fn: () => void, delayMs: number): unknown;
	clear(handle: unknown): void;
}

export interface StatusBarProbeOptions {
	/** How long to wait for a pong before warning that status-bar is missing. */
	delayMs: number;
	timers: StatusBarProbeTimers;
	onPing: () => void;
	onWarn: () => void;
}

/**
 * Presence tracker for the optional `status-bar` dependency.
 *
 * - `ping()` checks availability without arming the warning.
 * - `watch()` is called only while the row is needed: it pings and, if no pong
 *   arrives before `delayMs`, warns once.
 * - `cancel()` disarms a pending warning. `publishSubagentRow` calls it when the
 *   running count drops back to zero, so a short-lived run never warns.
 * - `markAvailable()` records a pong. `reset()` starts a new session.
 */
export class StatusBarPresence {
	private handle: unknown;
	private available = false;
	private warned = false;

	constructor(private readonly options: StatusBarProbeOptions) {}

	reset(): void {
		this.clearTimer();
		this.available = false;
		this.warned = false;
	}

	markAvailable(): void {
		this.available = true;
		this.clearTimer();
	}

	ping(): void {
		if (this.available || this.warned) return;
		this.options.onPing();
	}

	watch(): void {
		if (this.available || this.warned || this.handle !== undefined) return;
		this.options.onPing();
		this.handle = this.options.timers.set(() => {
			this.handle = undefined;
			if (this.available || this.warned) return;
			this.warned = true;
			this.options.onWarn();
		}, this.options.delayMs);
	}

	cancel(): void {
		this.clearTimer();
	}

	private clearTimer(): void {
		if (this.handle === undefined) return;
		this.options.timers.clear(this.handle);
		this.handle = undefined;
	}
}
