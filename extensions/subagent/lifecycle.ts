/**
 * Detached async dispatch ownership.
 *
 * Async dispatches are owned by the extension session, not by the parent tool
 * invocation. Each `start()` creates an independent `AbortController`, runs the
 * prepared dispatch with that signal (never the parent tool signal), and tracks
 * the promise until it settles and its completion has been delivered.
 *
 * Delivery is exactly-once: a normal result, a runner rejection converted to a
 * failed aggregate, and a manager abort all funnel through one terminal
 * `runDispatch()` path. Once `shutdown()` begins, no completion is delivered,
 * and shutdown awaits every tracked promise before clearing ownership.
 *
 * Races are closed with a session `epoch`:
 *
 *   - `start()` refuses to create ownership once shutdown has begun, so a
 *     preparation that resolves after shutdown cannot spawn an orphan run.
 *   - `shutdown()` captures and aborts the current epoch, awaits it to
 *     quiescence, and removes only the handles it captured.
 *   - `reset()` (replacement session) advances the epoch, so handles created
 *     before it can never deliver into the new session, while new dispatches
 *     can still start immediately.
 *
 * The manager has no runtime imports, so tests drive it with deferred promises
 * and a delivery spy.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { coerceTerminalCompletionDetails, formatAsyncCompletion, SUBAGENT_COMPLETION_CUSTOM_TYPE } from "./completion.ts";
import { buildDispatchExceptionResult } from "./dispatch.ts";
import type { PreparedSubagentDispatch, SubagentDetails } from "./types.ts";

// Re-exported for callers/tests that import the completion type from the
// lifecycle module; the canonical definition lives in `completion.ts`.
export { SUBAGENT_COMPLETION_CUSTOM_TYPE };

/** Custom context-bearing message injected once when a dispatch settles. */
export interface SubagentCompletionMessage {
	customType: typeof SUBAGENT_COMPLETION_CUSTOM_TYPE;
	content: string;
	display: true;
	details: SubagentDetails | undefined;
}

export interface CompletionDeliveryOptions {
	deliverAs: "followUp";
	triggerTurn: true;
}

export interface AsyncDispatchHandle {
	dispatchId: string;
	controller: AbortController;
	/** Session epoch this dispatch belongs to; used to suppress stale delivery. */
	epoch: number;
	/** Resolves after the dispatch settles and delivery has been attempted. */
	promise: Promise<void>;
}

export type AsyncDispatchRun = (signal: AbortSignal) => Promise<AgentToolResult<SubagentDetails>>;

export interface AsyncDispatchManagerOptions {
	/** Fire-and-forget delivery of the one aggregate completion message. */
	deliver: (message: SubagentCompletionMessage, options: CompletionDeliveryOptions) => void;
}

export class AsyncDispatchManager {
	private readonly dispatches = new Map<string, AsyncDispatchHandle>();
	private stopped = false;
	private epoch = 0;
	private shutdownPromise: Promise<void> | undefined;

	constructor(private readonly options: AsyncDispatchManagerOptions) {}

	get shuttingDown(): boolean {
		return this.stopped;
	}

	get size(): number {
		return this.dispatches.size;
	}

	get handles(): AsyncDispatchHandle[] {
		return [...this.dispatches.values()];
	}

	get(dispatchId: string): AsyncDispatchHandle | undefined {
		return this.dispatches.get(dispatchId);
	}

	/**
	 * Whether a new async dispatch may be accepted. Returns false after
	 * shutdown began or when the parent tool signal is already aborted.
	 */
	canStart(parentSignal?: AbortSignal): boolean {
		return !this.stopped && parentSignal?.aborted !== true;
	}

	/**
	 * Take ownership of a detached dispatch and return immediately. The tracked
	 * promise is stored before this returns and removed by `finally`. Returns
	 * `undefined` when the session is shutting down, so the caller can refuse
	 * the request instead of leaving an orphan run behind.
	 */
	start(dispatch: PreparedSubagentDispatch, run: AsyncDispatchRun): AsyncDispatchHandle | undefined {
		if (this.stopped) return undefined;
		const epoch = this.epoch;
		const controller = new AbortController();
		const handle: AsyncDispatchHandle = {
			dispatchId: dispatch.dispatchId,
			controller,
			epoch,
			promise: Promise.resolve(),
		};
		handle.promise = this.runDispatch(dispatch, controller, run, epoch).finally(() => {
			if (this.dispatches.get(dispatch.dispatchId) === handle) {
				this.dispatches.delete(dispatch.dispatchId);
			}
		});
		this.dispatches.set(dispatch.dispatchId, handle);
		return handle;
	}

	private async runDispatch(
		dispatch: PreparedSubagentDispatch,
		controller: AbortController,
		run: AsyncDispatchRun,
		epoch: number,
	): Promise<void> {
		let result: AgentToolResult<SubagentDetails>;
		try {
			result = await run(controller.signal);
		} catch (error) {
			result = this.exceptionResult(dispatch, controller, error);
		}

		if (this.stopped || epoch !== this.epoch) return;

		// A settled runner must never deliver a non-terminal record. Read the
		// details defensively (a corrupt getter is treated as missing) and coerce
		// the status so a runner bug cannot surface a `started` completion. Any
		// failure here falls back to a terminal record built from the dispatch.
		let details: SubagentDetails;
		let content: string;
		try {
			const rawDetails = result?.details;
			details = coerceTerminalCompletionDetails(dispatch, rawDetails, {
				aborted: controller.signal.aborted,
				isError: (result as unknown as { isError?: unknown } | undefined)?.isError === true,
			});
			content = formatAsyncCompletion(dispatch, result);
		} catch (error) {
			// A formatting bug must not strand the dispatch without a completion.
			const reason = error instanceof Error ? error.message : String(error);
			details = coerceTerminalCompletionDetails(dispatch, undefined, {
				aborted: controller.signal.aborted,
				isError: true,
			});
			content = `Subagent dispatch ${dispatch.dispatchId} settled, but its summary could not be formatted: ${reason}`;
		}
		const message: SubagentCompletionMessage = {
			customType: SUBAGENT_COMPLETION_CUSTOM_TYPE,
			content,
			display: true,
			details,
		};

		// Re-check immediately before the synchronous send to close the race.
		if (this.stopped || epoch !== this.epoch) return;
		try {
			this.options.deliver(message, { deliverAs: "followUp", triggerTurn: true });
		} catch {
			// Delivery must never break dispatch cleanup.
		}
	}

	/** Build a terminal result from a runner rejection; never throws. */
	private exceptionResult(
		dispatch: PreparedSubagentDispatch,
		controller: AbortController,
		error: unknown,
	): AgentToolResult<SubagentDetails> {
		try {
			// Preserve partial work where the runner attached it; classify aborts.
			const details =
				typeof error === "object" && error !== null && "details" in error
					? (error as { details?: SubagentDetails }).details
					: undefined;
			const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
			return buildDispatchExceptionResult(dispatch, error, { aborted, details });
		} catch {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Dispatch ${dispatch.dispatchId} failed: ${reason}` }],
				details: {
					mode: dispatch.mode,
					execution: dispatch.execution,
					dispatchId: dispatch.dispatchId,
					dispatchStatus: "failed",
					agentScope: dispatch.agentScope,
					projectAgentsDir: dispatch.projectAgentsDir,
					plannedItems: dispatch.items,
					cwd: dispatch.cwd,
					results: [],
				},
				isError: true,
			};
		}
	}

	/** Abort one detached dispatch's child work. Returns false when unknown. */
	abort(dispatchId: string): boolean {
		const handle = this.dispatches.get(dispatchId);
		if (!handle) return false;
		handle.controller.abort();
		return true;
	}

	abortAll(): void {
		for (const handle of this.dispatches.values()) handle.controller.abort();
	}

	/**
	 * Suppress delivery, abort every dispatch, and await the captured handles
	 * until ownership is quiescent. Idempotent: concurrent callers share one
	 * promise, and only the handles captured at shutdown time are removed so a
	 * replacement session's dispatches are never touched.
	 */
	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.stopped = true;
		// Advance the epoch so any in-flight delivery from before shutdown is
		// suppressed even if `reset()` runs before these handles settle.
		this.epoch += 1;
		const handles = [...this.dispatches.values()];
		for (const handle of handles) handle.controller.abort();

		const drain = (async () => {
			// `finally` on each tracked promise removes it from the map, so wait
			// until the captured ownership is fully quiescent.
			await Promise.allSettled(handles.map((handle) => handle.promise));
			for (const handle of handles) {
				if (this.dispatches.get(handle.dispatchId) === handle) {
					this.dispatches.delete(handle.dispatchId);
				}
			}
		})();
		this.shutdownPromise = drain;
		try {
			await drain;
		} finally {
			if (this.shutdownPromise === drain) this.shutdownPromise = undefined;
		}
	}

	/**
	 * Begin a replacement session. Advances the epoch so handles owned by the
	 * previous session can never deliver into the new one, then re-enables
	 * acceptance.
	 */
	reset(): void {
		this.epoch += 1;
		this.stopped = false;
		this.shutdownPromise = undefined;
	}
}
