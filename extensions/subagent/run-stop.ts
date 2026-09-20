/**
 * Bounded per-run stop escalation.
 *
 * A single run can be stopped more than once. The first stop asks the child to
 * abort cooperatively (an RPC `abort` command). If the child does not settle
 * within a grace period, or a later stop arrives, the controller escalates to
 * a forced termination so the registry entry cannot stay stale forever.
 *
 * The controller owns no runtime or child types: `index.ts` supplies the
 * cooperative-abort and force-terminate handlers, while tests supply fakes and
 * an injectable clock.
 */

/** Cooperative abort plus forced termination hooks for one run. */
export interface RunStopHandlers {
	/** Ask the child to abort cooperatively; may throw to abort synchronously. */
	requestAbort(): void;
	/** Force-terminate the child. Must itself be bounded. */
	terminate(): void | Promise<void>;
}

/** Injectable clock so escalation can be tested without real timers. */
export interface RunStopTimers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export interface RunStopControllerOptions {
	/** Time to wait for a cooperative abort before forcing termination. */
	graceMs?: number;
	/** Called once, synchronously, when the first stop is requested. */
	onAbort?: () => void;
	/** Called once when termination is forced (grace expiry or repeat stop). */
	onEscalate?: () => void;
	timers?: RunStopTimers;
}

/** Default grace before a cooperative abort escalates to forced termination. */
export const DEFAULT_STOP_ESCALATION_MS = 3000;

const defaultTimers: RunStopTimers = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Tracks the stop phase of one run. `request()` is idempotent for the graceful
 * phase: the first call asks for a cooperative abort and schedules escalation,
 * every later call forces termination immediately. `dispose()` clears any
 * pending escalation timer.
 */
export class RunStopController {
	private phase: "running" | "aborting" | "terminating" = "running";
	private timer: unknown;
	private readonly graceMs: number;
	private readonly timers: RunStopTimers;

	constructor(
		private readonly handlers: RunStopHandlers,
		private readonly options: RunStopControllerOptions = {},
	) {
		this.graceMs = options.graceMs ?? DEFAULT_STOP_ESCALATION_MS;
		this.timers = options.timers ?? defaultTimers;
	}

	/** True once any stop has been requested. */
	get stopped(): boolean {
		return this.phase !== "running";
	}

	/** True once forced termination has begun. */
	get escalating(): boolean {
		return this.phase === "terminating";
	}

	/** Request a cooperative stop, escalating on repeat calls. */
	request(): void {
		if (this.phase === "running") {
			this.phase = "aborting";
			this.options.onAbort?.();
			try {
				this.handlers.requestAbort();
			} catch {
				this.force();
				return;
			}
			// A synchronous abort handler may already have escalated.
			if (this.phase === "aborting") {
				this.timer = this.timers.set(() => this.force(), this.graceMs);
			}
			return;
		}
		this.force();
	}

	/** Force termination now; safe to call repeatedly. */
	force(): void {
		if (this.phase === "terminating") return;
		this.phase = "terminating";
		this.clearTimer();
		this.options.onEscalate?.();
		try {
			const termination = this.handlers.terminate();
			if (termination && typeof (termination as Promise<void>).then === "function") {
				void (termination as Promise<void>).then(undefined, () => {});
			}
		} catch {
			// Forced termination is best-effort; the child transport bounds it.
		}
	}

	/** Clear the pending escalation timer without changing the phase. */
	dispose(): void {
		this.clearTimer();
	}

	private clearTimer(): void {
		if (this.timer === undefined) return;
		this.timers.clear(this.timer);
		this.timer = undefined;
	}
}

/**
 * Reject with an AbortError when the signal has already fired. Shared by the
 * registry transport and control operations so a parent turn abort cannot
 * leave a control call waiting on an RPC deadline.
 */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

/** An `AbortError`-shaped error so callers can distinguish cancellation. */
export function abortError(message = "The subagent control call was aborted"): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

/**
 * Resolve `promise` but reject as soon as `signal` aborts. The original
 * promise always has handlers attached, so a late RPC response or timeout can
 * never surface as an unhandled rejection.
 */
export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
