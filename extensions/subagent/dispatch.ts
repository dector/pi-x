/**
 * Shared prepared-dispatch runner.
 *
 * Single/parallel/chain orchestration lives here, decoupled from the Pi
 * runtime. The runner consumes a fully validated `PreparedSubagentDispatch`
 * plus an injected per-child runner seam (`DispatchRuntimeDependencies`), its
 * own `AbortSignal`, and an optional `onUpdate` callback. It returns one
 * canonical aggregate tool result for both blocking and (later) async
 * execution.
 *
 * Preparation (Stage 2) already guarantees exactly one mode, a valid task count,
 * known agents, and pre-allocated run IDs, so this module no longer re-validates
 * those or owns an invalid-parameters fallback. `index.ts` supplies the concrete
 * child runner (RPC spawn, approval relay, registry, safe mode); this module only
 * sequences work and formats aggregate results.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { aggregateDispatchStatus, formatParallelAggregate } from "./completion.ts";
import { emptyUsage } from "./events.ts";
import { interpolatePrevious, mapWithConcurrencyLimit } from "./execution.ts";
import { getFinalOutput, getResultOutput, isAbortedResult, isFailedResult } from "./result-output.ts";
import type {
	PreparedDispatchItem,
	PreparedSubagentDispatch,
	SingleResult,
	SubagentBackendKind,
	SubagentDetails,
	SubagentDispatchStatus,
	SubagentMode,
} from "./types.ts";

export const MAX_CONCURRENCY = 4;

/**
 * Thrown by `runSingleAgent()` when a child is aborted. Carries the partial
 * `SingleResult` gathered before the abort so the runner can preserve streamed
 * output instead of replacing it with a synthetic placeholder.
 */
export class SubagentAbortError extends Error {
	constructor(readonly result: SingleResult) {
		super("Subagent was aborted");
		this.name = "SubagentAbortError";
	}
}

/**
 * Convert an unexpected per-child rejection into a terminal failed result.
 * Aborted children are classified as `aborted` so the aggregate status and
 * persisted history do not report a user cancellation as an error.
 */
function failedResultFor(
	item: PreparedDispatchItem,
	error: unknown,
	signal: AbortSignal | undefined,
	fallbackCwd?: string,
	backend?: SubagentBackendKind,
): SingleResult {
	const message = error instanceof Error ? error.message : String(error);
	const aborted = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
	return {
		agent: item.agent,
		agentSource: "unknown",
		task: item.task,
		cwd: item.cwd ?? fallbackCwd,
		exitCode: 1,
		messages: [],
		stderr: message,
		errorMessage: message,
		stopReason: aborted ? "aborted" : "error",
		usage: emptyUsage(),
		runId: item.runId,
		...(item.step !== undefined ? { step: item.step } : {}),
		...(backend ? { backend } : {}),
		state: "failed",
	};
}

/**
 * Force a partial result carried by `SubagentAbortError` to be reported as an
 * abort. `runSingleAgent()`'s snapshot may still be mid-flight (no
 * `stopReason`), so the runner owns the terminal classification instead of
 * trusting the partial fields.
 */
function normalizeAbortedResult(result: SingleResult): SingleResult {
	const hasOutput = getFinalOutput(result.messages).length > 0;
	const fallbackError = result.errorMessage ?? result.stderr;
	return {
		...result,
		exitCode: result.exitCode === 0 ? 1 : result.exitCode,
		stopReason: "aborted",
		// Prefer streamed output when present so an abort does not hide the
		// partial result. Fall back to the failure diagnostic otherwise.
		errorMessage: hasOutput ? result.errorMessage : fallbackError || "Subagent was aborted",
		state: "failed",
	};
}

/** Run one child, converting aborts and unexpected exceptions into results. */
async function runChild(
	deps: DispatchRuntimeDependencies,
	request: SingleRunRequest,
	item: PreparedDispatchItem,
	signal: AbortSignal | undefined,
	fallbackCwd?: string,
	backend?: SubagentBackendKind,
): Promise<SingleResult> {
	// A queued parallel item (or a later chain step) must never start, and in
	// particular must never prompt a child, once its dispatch is aborted.
	if (signal?.aborted) {
		return failedResultFor(item, new Error("Subagent was aborted before it started"), signal, fallbackCwd, backend);
	}
	try {
		return await deps.runSingle(request);
	} catch (error) {
		if (error instanceof SubagentAbortError) return normalizeAbortedResult(error.result);
		return failedResultFor(item, error, signal, fallbackCwd, backend);
	}
}

export { PER_TASK_OUTPUT_CAP } from "./completion.ts";

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** Builds a `SubagentDetails` for one mode with an explicit dispatch status. */
export type MakeDetails = (results: SingleResult[], dispatchStatus: SubagentDispatchStatus) => SubagentDetails;

/** One child run request emitted by the orchestrator. */
export interface SingleRunRequest {
	agent: string;
	task: string;
	cwd?: string;
	step?: number;
	/** Pre-allocated run ID from preparation. Required: the runner never mints IDs. */
	runId: string;
	/**
	 * Stable key shared by every step of one chain so the Herdr backend can
	 * reuse a single pane sequentially. Undefined for single/parallel runs.
	 */
	chainKey?: string;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: MakeDetails;
}

/**
 * Injected runtime seam. `index.ts` supplies a real implementation that wraps
 * `runSingleAgent()`; tests supply fakes. Only child execution is injected:
 * orchestration, aggregate formatting, and details construction stay here.
 */
export interface DispatchRuntimeDependencies {
	runSingle: (request: SingleRunRequest) => Promise<SingleResult>;
}

/** Build the `SubagentDetails` factory for a prepared dispatch and one mode. */
function makeDetailsFor(dispatch: PreparedSubagentDispatch, mode: SubagentMode): MakeDetails {
	return (results, dispatchStatus) => ({
		mode,
		execution: dispatch.execution,
		dispatchId: dispatch.dispatchId,
		dispatchStatus,
		agentScope: dispatch.agentScope,
		projectAgentsDir: dispatch.projectAgentsDir,
		plannedItems: dispatch.items,
		cwd: dispatch.cwd,
		...(dispatch.backend ? { backend: dispatch.backend } : {}),
		...(dispatch.herdrRetention ? { herdrRetention: dispatch.herdrRetention } : {}),
		results,
	});
}

/**
 * Convert an unexpected orchestration exception into a terminal failed
 * aggregate. Async dispatches must still deliver one completion message when
 * the runner rejects, so the exception is normalized rather than rethrown.
 */
export function buildDispatchExceptionResult(
	dispatch: PreparedSubagentDispatch,
	error: unknown,
	options: { aborted?: boolean; details?: SubagentDetails } = {},
): AgentToolResult<SubagentDetails> {
	const message = error instanceof Error ? error.message : String(error);
	const aborted = options.aborted === true;
	const results: SingleResult[] = dispatch.items.map((item) => ({
		agent: item.agent,
		agentSource: "unknown",
		task: item.task,
		cwd: item.cwd ?? dispatch.cwd,
		exitCode: 1,
		messages: [],
		stderr: message,
		errorMessage: message,
		stopReason: aborted ? "aborted" : "error",
		usage: emptyUsage(),
		runId: item.runId,
		...(item.step !== undefined ? { step: item.step } : {}),
		...(dispatch.backend ? { backend: dispatch.backend } : {}),
		state: "failed",
	}));
	const details: SubagentDetails = options.details ?? {
		mode: dispatch.mode,
		execution: dispatch.execution,
		dispatchId: dispatch.dispatchId,
		dispatchStatus: aborted ? "aborted" : "failed",
		agentScope: dispatch.agentScope,
		projectAgentsDir: dispatch.projectAgentsDir,
		plannedItems: dispatch.items,
		cwd: dispatch.cwd,
		...(dispatch.backend ? { backend: dispatch.backend } : {}),
		...(dispatch.herdrRetention ? { herdrRetention: dispatch.herdrRetention } : {}),
		results,
	};
	const status = details.dispatchStatus ?? (aborted ? "aborted" : "failed");

	return {
		content: [{ type: "text", text: `Dispatch ${dispatch.dispatchId} ${status}: ${message}` }],
		details,
		isError: true,
	};
}

/**
 * Run a prepared dispatch to completion. The caller owns the signal (the tool
 * signal for blocking, an independent dispatch controller for async) and may
 * pass the tool `onUpdate` callback while the invocation is still streaming.
 */
export async function runPreparedDispatch(
	dispatch: PreparedSubagentDispatch,
	deps: DispatchRuntimeDependencies,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
): Promise<AgentToolResult<SubagentDetails>> {
	const items = dispatch.items;

	if (items.length === 0) {
		throw new Error(
			`Malformed prepared dispatch ${dispatch.dispatchId} (mode "${dispatch.mode}"): expected at least one item. ` +
				"Preparation must reject empty requests before calling the runner.",
		);
	}

	if (dispatch.mode === "chain") {
		const results: SingleResult[] = [];
		let previousOutput = "";

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const taskWithContext = interpolatePrevious(item.task, previousOutput);

			// Include all previously completed steps alongside the current stream.
			const chainUpdate: OnUpdateCallback | undefined = onUpdate
				? (partial) => {
						const currentResult = partial.details?.results[0];
						if (currentResult) {
							onUpdate({
								content: partial.content,
								details: makeDetailsFor(dispatch, "chain")([...results, currentResult], "started"),
							});
						}
					}
				: undefined;

			const result = await runChild(
				deps,
				{
					agent: item.agent,
					task: taskWithContext,
					cwd: item.cwd,
					runId: item.runId,
					step: item.step ?? i + 1,
					chainKey: dispatch.dispatchId,
					signal,
					onUpdate: chainUpdate,
					makeDetails: makeDetailsFor(dispatch, "chain"),
				},
				item,
				signal,
				dispatch.cwd,
				dispatch.backend,
			);
			results.push(result);

			if (isFailedResult(result)) {
				const errorMsg = getResultOutput(result);
				return {
					content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${item.agent}): ${errorMsg}` }],
					details: makeDetailsFor(dispatch, "chain")(results, isAbortedResult(result) ? "aborted" : "failed"),
					isError: true,
				};
			}
			previousOutput = getFinalOutput(result.messages);
		}
		return {
			content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
			details: makeDetailsFor(dispatch, "chain")(results, "completed"),
		};
	}

	if (dispatch.mode === "parallel") {
		// Track all results by input index for streaming updates. The -1 exit
		// code marks a placeholder that is still running.
		const allResults: SingleResult[] = new Array(items.length);
		for (let i = 0; i < items.length; i++) {
			allResults[i] = {
				agent: items[i].agent,
				agentSource: "unknown",
				task: items[i].task,
				cwd: items[i].cwd ?? dispatch.cwd,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				...(dispatch.backend ? { backend: dispatch.backend } : {}),
			};
		}

		const emitParallelUpdate = () => {
			if (!onUpdate) return;
			const running = allResults.filter((result) => result.exitCode === -1).length;
			const done = allResults.filter((result) => result.exitCode !== -1).length;
			onUpdate({
				content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
				details: makeDetailsFor(dispatch, "parallel")([...allResults], "started"),
			});
		};

		const results = await mapWithConcurrencyLimit(items, MAX_CONCURRENCY, async (item, index) => {
			const result = await runChild(
				deps,
				{
					agent: item.agent,
					task: item.task,
					cwd: item.cwd,
					runId: item.runId,
					step: undefined,
					signal,
					onUpdate: (partial) => {
						if (partial.details?.results[0]) {
							allResults[index] = partial.details.results[0];
							emitParallelUpdate();
						}
					},
					makeDetails: makeDetailsFor(dispatch, "parallel"),
				},
				item,
				signal,
				dispatch.cwd,
				dispatch.backend,
			);
			allResults[index] = result;
			emitParallelUpdate();
			return result;
		});

		return {
			content: [{ type: "text", text: formatParallelAggregate(results) }],
			details: makeDetailsFor(dispatch, "parallel")(
				results,
				aggregateDispatchStatus(results, { aborted: results.some(isAbortedResult) }),
			),
		};
	}

	const item = items[0];
	const result = await runChild(
		deps,
		{
			agent: item.agent,
			task: item.task,
			cwd: item.cwd,
			runId: item.runId,
			step: undefined,
			signal,
			onUpdate,
			makeDetails: makeDetailsFor(dispatch, "single"),
		},
		item,
		signal,
		dispatch.cwd,
		dispatch.backend,
	);

	if (isFailedResult(result)) {
		const errorMsg = getResultOutput(result);
		return {
			content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
			details: makeDetailsFor(dispatch, "single")([result], isAbortedResult(result) ? "aborted" : "failed"),
			isError: true,
		};
	}
	return {
		content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
		details: makeDetailsFor(dispatch, "single")([result], "completed"),
	};
}
