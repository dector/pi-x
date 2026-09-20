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
import { interpolatePrevious, mapWithConcurrencyLimit } from "./execution.ts";
import { getFinalOutput, getResultOutput, isAbortedResult, isFailedResult } from "./result-output.ts";
import type {
	PreparedSubagentDispatch,
	SingleResult,
	SubagentDetails,
	SubagentDispatchStatus,
	SubagentMode,
} from "./types.ts";

export const MAX_CONCURRENCY = 4;
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
		results,
	});
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

			const result = await deps.runSingle({
				agent: item.agent,
				task: taskWithContext,
				cwd: item.cwd,
				runId: item.runId,
				step: item.step ?? i + 1,
				signal,
				onUpdate: chainUpdate,
				makeDetails: makeDetailsFor(dispatch, "chain"),
			});
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
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
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
			const result = await deps.runSingle({
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
			});
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
	const result = await deps.runSingle({
		agent: item.agent,
		task: item.task,
		cwd: item.cwd,
		runId: item.runId,
		step: undefined,
		signal,
		onUpdate,
		makeDetails: makeDetailsFor(dispatch, "single"),
	});

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
