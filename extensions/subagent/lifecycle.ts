/**
 * Unified dispatch lifecycle ownership.
 *
 * Every dispatch — detached async from launch, or blocking — is owned by the
 * extension session through `DispatchLifecycleManager`, not by the parent tool
 * invocation. Each `start()` creates an independent `AbortController`, runs the
 * prepared dispatch with that signal (never directly with the parent tool
 * signal), and tracks the promise until it settles and any required completion
 * has been delivered.
 *
 * Blocking is only a wait/stream policy on top of the same ownership:
 *
 *   - `start(dispatch, run, { attach })` creates an `attached` handle. The
 *     manager forwards the parent tool signal to its independent controller and
 *     streams `onUpdate` while it stays attached. When the runner settles the
 *     aggregate is returned in-line and no completion message is injected.
 *   - `detach(dispatchId)` moves an attached blocking handle to `detached`
 *     without restarting it: parent-abort forwarding is unlinked, `onUpdate` is
 *     gated, the blocking tool call is resolved with an acknowledgement, and the
 *     eventual aggregate becomes exactly-one injected completion.
 *   - A handle created without `attach` is `detached` from launch (the historical
 *     async behavior): its completion is injected automatically.
 *
 * Ownership is a one-way state machine (`attached -> detached -> settled` or
 * `attached -> settled`, `detached -> settled`). Because the transitions are
 * synchronous, a completion-vs-detach race cannot both return an in-line
 * aggregate and inject a completion, and cannot lose a settled result.
 *
 * Races are closed with a session `epoch`:
 *
 *   - `start()` refuses to create ownership once shutdown has begun, so a
 *     preparation that resolves after shutdown cannot spawn an orphan run.
 *   - `shutdown()` captures and aborts the current epoch, resolves attached
 *     blocking results immediately (so a tool call can never hang), awaits every
 *     tracked promise to quiescence, and suppresses delivery.
 *   - `reset()` (replacement session) advances the epoch, so handles created
 *     before it can never deliver into the new session, while new dispatches
 *     can still start immediately.
 *
 * The manager has no Pi runtime imports, so tests drive it with deferred
 * promises and a delivery spy.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	buildDetachedStartResult,
	coerceTerminalCompletionDetails,
	formatAsyncCompletion,
	SUBAGENT_COMPLETION_CUSTOM_TYPE,
} from "./completion.ts";
import { buildDispatchExceptionResult, type OnUpdateCallback } from "./dispatch.ts";
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

/**
 * One-way ownership state for a dispatch handle.
 *
 * - `attached`: a blocking dispatch owned by a live parent tool call. Parent
 *   aborts are forwarded and `onUpdate` streams.
 * - `detached`: the dispatch runs in the background. Parent aborts are no
 *   longer forwarded, updates are gated, and its aggregate becomes an injected
 *   completion.
 * - `settled`: the runner produced a terminal aggregate. No further transitions.
 */
export type DispatchOwnership = "attached" | "detached" | "settled";

/** The runner seam. The manager owns the signal and gates `onUpdate`. */
export type AsyncDispatchRun = (
	signal: AbortSignal,
	onUpdate: OnUpdateCallback | undefined,
) => Promise<AgentToolResult<SubagentDetails>>;

/** Attached (blocking) wait/stream policy for a handle. */
export interface AttachedDispatchPolicy {
	/** Parent tool-call signal; forwarded only while the handle is attached. */
	parentSignal?: AbortSignal;
	/** Live progress callback; gated off once the handle is detached. */
	onUpdate?: OnUpdateCallback;
}

export interface DispatchStartOptions {
	/** Create the handle attached to a blocking tool call. Omit for async. */
	attach?: AttachedDispatchPolicy;
	/** Called once, synchronously, when an attached handle is detached. */
	onDetach?: (dispatchId: string) => void;
}

export interface AsyncDispatchHandle {
	dispatchId: string;
	controller: AbortController;
	/** Session epoch this dispatch belongs to; used to suppress stale delivery. */
	epoch: number;
	/** Resolves after the dispatch settles and delivery has been attempted. */
	promise: Promise<void>;
	/**
	 * The result the parent tool call should return: the terminal aggregate when
	 * it settles attached, or the detach acknowledgement when it was detached.
	 */
	result: Promise<AgentToolResult<SubagentDetails>>;
	/** Current ownership state. */
	readonly ownership: DispatchOwnership;
	/** True once this handle was detached from an attached blocking state. */
	readonly everDetached: boolean;
	/** True once `result` resolved or rejected; no further settlement is possible. */
	readonly resultSettled: boolean;
}

export type DetachReason = "unknown" | "settled" | "already-detached" | "stale";

/** Result of a detach request; message is safe to show in a notification. */
export interface DetachOutcome {
	ok: boolean;
	reason?: DetachReason;
	message: string;
}

/** Mutable handle implementation with live ownership getters. */
class DispatchHandle implements AsyncDispatchHandle {
	ownership: DispatchOwnership = "detached";
	everDetached = false;
	unlinkParentAbort: (() => void) | undefined;
	onDetach: ((dispatchId: string) => void) | undefined;
	promise: Promise<void> = Promise.resolve();
	readonly result: Promise<AgentToolResult<SubagentDetails>>;
	private resultClosed = false;
	private resolveResult!: (value: AgentToolResult<SubagentDetails>) => void;
	private rejectResult!: (error: unknown) => void;

	constructor(
		readonly dispatchId: string,
		readonly controller: AbortController,
		readonly epoch: number,
		readonly dispatch: PreparedSubagentDispatch,
	) {
		this.result = new Promise((resolve, reject) => {
			this.resolveResult = resolve;
			this.rejectResult = reject;
		});
	}

	get resultSettled(): boolean {
		return this.resultClosed;
	}

	/** Resolve the tool result at most once. */
	settleResult(value: AgentToolResult<SubagentDetails>): void {
		if (this.resultClosed) return;
		this.resultClosed = true;
		this.resolveResult(value);
	}

	/** Reject the tool result at most once; never overrides an earlier settle. */
	failResult(error: unknown): void {
		if (this.resultClosed) return;
		this.resultClosed = true;
		this.rejectResult(error);
	}
}

export interface AsyncDispatchManagerOptions {
	/** Fire-and-forget delivery of the one aggregate completion message. */
	deliver: (message: SubagentCompletionMessage, options: CompletionDeliveryOptions) => void;
}

export class DispatchLifecycleManager {
	private readonly dispatches = new Map<string, DispatchHandle>();
	/**
	 * Dispatch ids detached during this session, remembered after their handle is
	 * removed so `/px:agents` keeps showing background ownership for runs that
	 * registered after the detach (later chain steps, queued parallel siblings).
	 */
	private readonly everDetachedDispatches = new Set<string>();
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

	/** Whether an owned dispatch is still attached to a blocking tool call. */
	isAttached(dispatchId: string): boolean {
		return this.dispatches.get(dispatchId)?.ownership === "attached";
	}

	/**
	 * Whether a dispatch was ever detached from an attached blocking turn. True
	 * while its handle exists and afterwards for the rest of the session, so late
	 * registrations of the same dispatch are classified as background work.
	 */
	wasEverDetached(dispatchId: string): boolean {
		return this.dispatches.get(dispatchId)?.everDetached === true || this.everDetachedDispatches.has(dispatchId);
	}

	/**
	 * Whether a new async dispatch may be accepted. Returns false after
	 * shutdown began or when the parent tool signal is already aborted.
	 */
	canStart(parentSignal?: AbortSignal): boolean {
		return !this.stopped && parentSignal?.aborted !== true;
	}

	/**
	 * Take ownership of a dispatch and return immediately. The tracked promise
	 * is stored before this returns and removed by `finally`. Returns
	 * `undefined` when the session is shutting down, so the caller can refuse
	 * the request instead of leaving an orphan run behind.
	 *
	 * Passing `options.attach` creates an attached blocking handle. Omitting it
	 * creates the historical detached async handle.
	 */
	start(
		dispatch: PreparedSubagentDispatch,
		run: AsyncDispatchRun,
		options: DispatchStartOptions = {},
	): AsyncDispatchHandle | undefined {
		if (this.stopped) return undefined;
		const epoch = this.epoch;
		const controller = new AbortController();
		const handle = new DispatchHandle(dispatch.dispatchId, controller, epoch, dispatch);
		handle.onDetach = options.onDetach;

		const attach = options.attach;
		if (attach) {
			handle.ownership = "attached";
			const parentSignal = attach.parentSignal;
			if (parentSignal) {
				// Forward parent aborts only while attached. Detach unlinks this so a
				// later parent cancellation cannot kill backgrounded work.
				const onAbort = (): void => {
					if (handle.ownership === "attached") controller.abort();
				};
				if (parentSignal.aborted) controller.abort();
				else {
					parentSignal.addEventListener("abort", onAbort, { once: true });
					handle.unlinkParentAbort = () => parentSignal.removeEventListener("abort", onAbort);
				}
			}
		}

		// Gate updates on ownership: once detached (or settled), the completed
		// invocation's streaming callback must never be called again.
		const onUpdate = attach?.onUpdate;
		const gatedUpdate: OnUpdateCallback | undefined = onUpdate
			? (partial) => {
					if (handle.ownership === "attached") onUpdate(partial);
				}
			: undefined;

		handle.promise = this.runDispatch(handle, run, gatedUpdate).finally(() => {
			if (this.dispatches.get(dispatch.dispatchId) === handle) {
				this.dispatches.delete(dispatch.dispatchId);
			}
		});
		this.dispatches.set(dispatch.dispatchId, handle);
		return handle;
	}

	/**
	 * Move an attached blocking dispatch to the background without restarting
	 * it. Unlinks parent-abort forwarding, gates future `onUpdate`, resolves the
	 * blocking tool call with a detach acknowledgement, and marks registry/menu
	 * state through `onDetach`. The later aggregate still arrives exactly once as
	 * an injected completion.
	 *
	 * Settled or already-detached handles are rejected so a completion and a
	 * detach can never both claim the same result. A shutting-down or replaced
	 * session is also rejected, because its completion delivery is suppressed and
	 * a detach acknowledgement would promise a result that never arrives.
	 */
	detach(dispatchId: string): DetachOutcome {
		const handle = this.dispatches.get(dispatchId);
		if (!handle) {
			return { ok: false, reason: "unknown", message: `No active dispatch ${dispatchId}.` };
		}
		if (handle.ownership === "detached") {
			return {
				ok: false,
				reason: "already-detached",
				message: `Dispatch ${dispatchId} is already running in the background.`,
			};
		}
		if (handle.ownership === "settled") {
			return {
				ok: false,
				reason: "settled",
				message: `Dispatch ${dispatchId} has already settled; there is nothing to detach.`,
			};
		}
		// Shutdown or a replacement session suppresses completion delivery, so a
		// detach here could only promise a result that will never arrive.
		if (this.stopped || handle.epoch !== this.epoch) {
			return {
				ok: false,
				reason: "stale",
				message: `Dispatch ${dispatchId} cannot be detached: its owning session is shutting down or has been replaced.`,
			};
		}
		// A shutdown-settled attached handle already returned an abort result and
		// stays `attached` until its runner drains; never detach over that result.
		if (handle.resultSettled) {
			return {
				ok: false,
				reason: "settled",
				message: `Dispatch ${dispatchId} has already settled; there is nothing to detach.`,
			};
		}

		// Synchronous transition closes the completion-vs-detach race: the settle
		// path observes `detached` and injects exactly one completion instead of
		// returning an in-line aggregate.
		handle.ownership = "detached";
		handle.everDetached = true;
		this.everDetachedDispatches.add(dispatchId);
		handle.unlinkParentAbort?.();
		handle.unlinkParentAbort = undefined;
		handle.settleResult(buildDetachedStartResult(handle.dispatch));
		try {
			handle.onDetach?.(dispatchId);
		} catch {
			// UI/registry bookkeeping must never break the lifecycle transition.
		}
		return {
			ok: true,
			message: `Dispatch ${dispatchId} detached. It continues in the background and its result will arrive automatically.`,
		};
	}

	private async runDispatch(
		handle: DispatchHandle,
		run: AsyncDispatchRun,
		onUpdate: OnUpdateCallback | undefined,
	): Promise<void> {
		const dispatch = handle.dispatch;
		let result: AgentToolResult<SubagentDetails>;
		let runnerRejected = false;
		let runnerError: unknown = undefined;
		try {
			result = await run(handle.controller.signal, onUpdate);
		} catch (error) {
			runnerRejected = true;
			runnerError = error;
			result = this.exceptionResult(dispatch, handle.controller, error);
		}

		// Terminal commit. Capture whether the handle was still attached before
		// flipping state, so the in-line vs injected decision is made once.
		const wasAttached = handle.ownership === "attached";
		handle.ownership = "settled";
		handle.unlinkParentAbort?.();
		handle.unlinkParentAbort = undefined;

		if (wasAttached) {
			// Preserve the historical blocking contract: a genuine runner rejection
			// propagates out of the tool call instead of being returned as an
			// `isError` result. Shutdown may already have resolved the result, in
			// which case `failResult` is a no-op and the abort result is kept.
			if (runnerRejected) handle.failResult(runnerError);
			else handle.settleResult(result);
			return;
		}

		// A detached handle resolves its acknowledgement (from `detach`) or its
		// terminal aggregate, then injects exactly one completion. Resolve before
		// the shutdown/epoch suppression check so nothing can be lost.
		handle.settleResult(result);
		if (this.stopped || handle.epoch !== this.epoch) return;

		// A settled runner must never deliver a non-terminal record. Read the
		// details defensively (a corrupt getter is treated as missing) and coerce
		// the status so a runner bug cannot surface a `started` completion. Any
		// failure here falls back to a terminal record built from the dispatch.
		let details: SubagentDetails;
		let content: string;
		try {
			const rawDetails = result?.details;
			details = coerceTerminalCompletionDetails(dispatch, rawDetails, {
				aborted: handle.controller.signal.aborted,
				isError: (result as unknown as { isError?: unknown } | undefined)?.isError === true,
			});
			content = formatAsyncCompletion(dispatch, result);
		} catch (error) {
			// A formatting bug must not strand the dispatch without a completion.
			const reason = error instanceof Error ? error.message : String(error);
			details = coerceTerminalCompletionDetails(dispatch, undefined, {
				aborted: handle.controller.signal.aborted,
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
		if (this.stopped || handle.epoch !== this.epoch) return;
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

	/**
	 * Abort one dispatch's child work. Works for attached blocking and detached
	 * handles alike. Returns false when unknown.
	 */
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
	 * until ownership is quiescent. Attached blocking results are resolved
	 * immediately so a waiting tool call cannot hang on a wedged runner.
	 * Idempotent: concurrent callers share one promise, and only the handles
	 * captured at shutdown time are removed so a replacement session's
	 * dispatches are never touched.
	 */
	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.stopped = true;
		// Advance the epoch so any in-flight delivery from before shutdown is
		// suppressed even if `reset()` runs before these handles settle.
		this.epoch += 1;
		const handles = [...this.dispatches.values()];
		for (const handle of handles) {
			handle.controller.abort();
			if (handle.ownership === "attached") {
				handle.settleResult(
					buildDispatchExceptionResult(
						handle.dispatch,
						new Error("Subagent dispatch aborted: the session is shutting down."),
						{ aborted: true },
					),
				);
			}
		}

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
		// Background ownership is session-scoped; a replacement session starts
		// with a clean slate. Live handles still report their own `everDetached`.
		this.everDetachedDispatches.clear();
	}
}

/**
 * Backwards-compatible alias. `AsyncDispatchManager` predates blocking
 * ownership; new code should use `DispatchLifecycleManager`.
 */
export { DispatchLifecycleManager as AsyncDispatchManager };
