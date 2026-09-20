/**
 * Canonical dispatch completion helpers.
 *
 * Pure helpers shared by the blocking tool result, the async acknowledgement
 * and completion messages, the completion renderer, and `/px:agent:log`.
 * Nothing here touches the runtime, so it is safe to import from tests.
 *
 * Compatibility boundary: `SubagentDetails` keeps the async metadata optional
 * so old persisted records (no `execution`/`dispatchStatus`) keep parsing.
 * Readers call `normalizeSubagentDetails()` to resolve the historical meaning:
 * a missing `execution` is a blocking run and a missing `dispatchStatus` is a
 * finished run. `"started"` is the only non-terminal status and is never
 * treated as completed history.
 */

import { getResultOutput, isFailedResult, type ResultStatusFields } from "./result-output.ts";
import type {
	NormalizedSubagentDetails,
	SingleResult,
	SubagentDispatchStatus,
	SubagentExecution,
	SubagentMode,
} from "./types.ts";

/** Model-visible output cap per task, in bytes. */
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isMode(value: unknown): value is SubagentMode {
	return value === "single" || value === "parallel" || value === "chain";
}

/**
 * True once a dispatch has settled. `"started"` is explicitly non-terminal so
 * an async acknowledgement is never mistaken for a completed run.
 */
export function isTerminalDispatchStatus(status: unknown): status is Exclude<SubagentDispatchStatus, "started"> {
	return status === "completed" || status === "failed" || status === "aborted";
}

/**
 * Canonical terminal status for a settled dispatch, derived once for every
 * caller. An explicit aggregate error or a fully-failed result set is a failed
 * dispatch; an aborted dispatch wins over both.
 */
export function aggregateDispatchStatus(
	results: ReadonlyArray<ResultStatusFields>,
	options: { error?: boolean; aborted?: boolean } = {},
): SubagentDispatchStatus {
	if (options.aborted) return "aborted";
	if (options.error) return "failed";
	if (results.length > 0 && results.every((result) => isFailedResult(result))) return "failed";
	return "completed";
}

/**
 * Resolve compatibility metadata for a persisted dispatch record. Unknown
 * values fall back to the historical blocking/completed meaning; only
 * `"started"` survives as a non-terminal status.
 */
export function normalizeDispatchMetadata(value: unknown): {
	execution: SubagentExecution;
	dispatchStatus: SubagentDispatchStatus;
} {
	const record = isRecord(value) ? value : {};
	const execution: SubagentExecution = record.execution === "async" ? "async" : "blocking";
	const rawStatus = record.dispatchStatus;
	const dispatchStatus: SubagentDispatchStatus =
		rawStatus === "started" || rawStatus === "failed" || rawStatus === "aborted" ? rawStatus : "completed";
	return { execution, dispatchStatus };
}

/**
 * Validate and normalize an unknown persisted `SubagentDetails` value. Returns
 * `undefined` when the record is not a dispatch at all, matching the historical
 * "only `mode` and `results` are required" tolerance.
 */
export function normalizeSubagentDetails(value: unknown): NormalizedSubagentDetails | undefined {
	if (!isRecord(value)) return undefined;
	if (!isMode(value.mode)) return undefined;
	if (!Array.isArray(value.results)) return undefined;

	const { execution, dispatchStatus } = normalizeDispatchMetadata(value);
	const agentScope =
		value.agentScope === "user" || value.agentScope === "project" || value.agentScope === "both"
			? value.agentScope
			: "user";

	return {
		mode: value.mode,
		agentScope,
		projectAgentsDir: typeof value.projectAgentsDir === "string" ? value.projectAgentsDir : null,
		execution,
		dispatchId: typeof value.dispatchId === "string" ? value.dispatchId : undefined,
		dispatchStatus,
		results: value.results as SingleResult[],
	};
}

/**
 * Truncate one task's model-visible output to `cap` bytes. The cut is made on a
 * code-point boundary so a split surrogate never reaches the model, and the
 * omitted count is the true byte difference.
 */
export function truncateTaskOutput(output: string, cap: number = PER_TASK_OUTPUT_CAP): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= cap) return output;

	let kept = "";
	let keptBytes = 0;
	for (const char of output) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (keptBytes + charBytes > cap) break;
		kept += char;
		keptBytes += charBytes;
	}
	const omitted = byteLength - keptBytes;
	return `${kept}\n\n[Output truncated: ${omitted} bytes omitted. Full output preserved in tool details.]`;
}

/** Historical per-task status label: `completed` or `failed (reason)`. */
export function formatTaskStatus(result: ResultStatusFields): string {
	if (!isFailedResult(result)) return "completed";
	const stopReason = typeof result.stopReason === "string" ? result.stopReason : "";
	return `failed${stopReason && stopReason !== "end" ? ` (${stopReason})` : ""}`;
}

/** One `### [agent] status` section for the parallel aggregate. */
export function formatParallelTaskSection(result: SingleResult): string {
	const output = truncateTaskOutput(getResultOutput(result));
	return `### [${result.agent}] ${formatTaskStatus(result)}\n\n${output}`;
}

/**
 * Canonical parallel aggregate text. Byte-for-byte identical to the historical
 * `dispatch.ts` formatting so blocking output does not change.
 */
export function formatParallelAggregate(results: readonly SingleResult[]): string {
	const successCount = results.filter((result) => !isFailedResult(result)).length;
	const sections = results.map(formatParallelTaskSection).join("\n\n---\n\n");
	return `Parallel: ${successCount}/${results.length} succeeded\n\n${sections}`;
}

export interface AsyncAcknowledgementItem {
	agent: string;
	runId: string;
	task: string;
	cwd?: string;
}

export interface AsyncAcknowledgementInput {
	dispatchId: string;
	mode: SubagentMode;
	items: readonly AsyncAcknowledgementItem[];
}

/**
 * Short model-visible acknowledgement returned when a dispatch is detached.
 * Tells the parent not to poll, that the result arrives automatically, and that
 * children may have touched the shared working tree.
 */
export function formatAsyncAcknowledgement(input: AsyncAcknowledgementInput): string {
	const lines: string[] = [
		`Subagent dispatch ${input.dispatchId} started in the background (${input.mode}).`,
		"",
		"Tasks:",
	];
	for (const item of input.items) {
		const cwd = item.cwd ? ` (cwd: ${item.cwd})` : "";
		lines.push(`- ${item.agent} [${item.runId}]${cwd}: ${item.task}`);
	}
	lines.push(
		"",
		"The dispatch is running in the background. Do not poll or wait for it unless the user asks. The final result will arrive automatically when the whole dispatch settles. Children may modify the shared working tree, so re-read affected files before editing them.",
	);
	return lines.join("\n");
}
