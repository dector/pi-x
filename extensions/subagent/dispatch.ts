/**
 * Dispatch orchestration seam.
 *
 * Stage 0 characterization scaffold: the single/parallel/chain orchestration
 * that previously lived inline in `index.ts:execute()` is extracted here behind
 * an injected single-run function so the blocking contract can be regression
 * tested without spawning real Pi processes.
 *
 * Behavior is intentionally identical to the inline implementation. This module
 * imports only local code so it can be loaded in `bun test` where the extension
 * runtime packages are not installed. `index.ts` owns the concrete child runner,
 * approval relay, registry, and safe-mode snapshot; this module only sequences
 * work and formats aggregate results.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { aggregateDispatchStatus, formatParallelAggregate } from "./completion.ts";
import { interpolatePrevious, mapWithConcurrencyLimit } from "./execution.ts";
import { getFinalOutput, getResultOutput, isAbortedResult, isFailedResult } from "./result-output.ts";
import type { SingleResult, SubagentDetails, SubagentDispatchStatus } from "./types.ts";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export { PER_TASK_OUTPUT_CAP } from "./completion.ts";

export type DispatchMode = SubagentDetails["mode"];
export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** Builds a `SubagentDetails` for the current mode with an explicit dispatch status. */
export type MakeDetails = (results: SingleResult[], dispatchStatus: SubagentDispatchStatus) => SubagentDetails;

export interface DispatchTask {
	agent: string;
	task: string;
	cwd?: string;
}

export interface DispatchRequest {
	agent?: string;
	task?: string;
	cwd?: string;
	tasks?: DispatchTask[];
	chain?: DispatchTask[];
}

/** Everything a single child run needs from the orchestrator. */
export interface SingleRunRequest {
	agent: string;
	task: string;
	cwd?: string;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: MakeDetails;
}

/**
 * Injected runtime seam. `index.ts` supplies a real implementation that wraps
 * `runSingleAgent()`; tests supply fakes.
 */
export interface DispatchRunner {
	makeDetails: (mode: DispatchMode) => MakeDetails;
	runSingle: (request: SingleRunRequest) => Promise<SingleResult>;
	/** Agent list rendered by the invalid-parameters fallback. */
	availableAgents?: string;
}

/**
 * Run a single/parallel/chain dispatch. The caller has already validated that
 * exactly one mode is requested (that validation stays in the tool handler until
 * the preparation stage extracts it).
 */
export async function runDispatch(
	request: DispatchRequest,
	runner: DispatchRunner,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
): Promise<AgentToolResult<SubagentDetails>> {
	if (request.chain && request.chain.length > 0) {
		const results: SingleResult[] = [];
		let previousOutput = "";

		for (let i = 0; i < request.chain.length; i++) {
			const step = request.chain[i];
			const taskWithContext = interpolatePrevious(step.task, previousOutput);

			// Create update callback that includes all previous results
			const chainUpdate: OnUpdateCallback | undefined = onUpdate
				? (partial) => {
						// Combine completed results with current streaming result
						const currentResult = partial.details?.results[0];
						if (currentResult) {
							const allResults = [...results, currentResult];
							onUpdate({
								content: partial.content,
								details: runner.makeDetails("chain")(allResults, "started"),
							});
						}
					}
				: undefined;

			const result = await runner.runSingle({
				agent: step.agent,
				task: taskWithContext,
				cwd: step.cwd,
				step: i + 1,
				signal,
				onUpdate: chainUpdate,
				makeDetails: runner.makeDetails("chain"),
			});
			results.push(result);

			const isError = isFailedResult(result);
			if (isError) {
				const errorMsg = getResultOutput(result);
				return {
					content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
					details: runner.makeDetails("chain")(results, isAbortedResult(result) ? "aborted" : "failed"),
					isError: true,
				};
			}
			previousOutput = getFinalOutput(result.messages);
		}
		return {
			content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
			details: runner.makeDetails("chain")(results, "completed"),
		};
	}

	if (request.tasks && request.tasks.length > 0) {
		if (request.tasks.length > MAX_PARALLEL_TASKS)
			return {
				content: [
					{
						type: "text",
						text: `Too many parallel tasks (${request.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
					},
				],
				details: runner.makeDetails("parallel")([], "failed"),
			};

		// Track all results for streaming updates
		const allResults: SingleResult[] = new Array(request.tasks.length);

		// Initialize placeholder results
		for (let i = 0; i < request.tasks.length; i++) {
			allResults[i] = {
				agent: request.tasks[i].agent,
				agentSource: "unknown",
				task: request.tasks[i].task,
				exitCode: -1, // -1 = still running
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			};
		}

		const emitParallelUpdate = () => {
			if (onUpdate) {
				const running = allResults.filter((r) => r.exitCode === -1).length;
				const done = allResults.filter((r) => r.exitCode !== -1).length;
				onUpdate({
					content: [
						{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
					],
					details: runner.makeDetails("parallel")([...allResults], "started"),
				});
			}
		};

		const results = await mapWithConcurrencyLimit(request.tasks, MAX_CONCURRENCY, async (t, index) => {
			const result = await runner.runSingle({
				agent: t.agent,
				task: t.task,
				cwd: t.cwd,
				step: undefined,
				signal,
				// Per-task update callback
				onUpdate: (partial) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emitParallelUpdate();
					}
				},
				makeDetails: runner.makeDetails("parallel"),
			});
			allResults[index] = result;
			emitParallelUpdate();
			return result;
		});

		return {
			content: [{ type: "text", text: formatParallelAggregate(results) }],
			details: runner.makeDetails("parallel")(results, aggregateDispatchStatus(results, { aborted: results.some(isAbortedResult) })),
		};
	}

	if (request.agent && request.task) {
		const result = await runner.runSingle({
			agent: request.agent,
			task: request.task,
			cwd: request.cwd,
			step: undefined,
			signal,
			onUpdate,
			makeDetails: runner.makeDetails("single"),
		});
		const isError = isFailedResult(result);
		if (isError) {
			const errorMsg = getResultOutput(result);
			return {
				content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
				details: runner.makeDetails("single")([result], isAbortedResult(result) ? "aborted" : "failed"),
				isError: true,
			};
		}
		return {
			content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
			details: runner.makeDetails("single")([result], "completed"),
		};
	}

	const available = runner.availableAgents ?? "none";
	return {
		content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
		details: runner.makeDetails("single")([], "failed"),
	};
}
