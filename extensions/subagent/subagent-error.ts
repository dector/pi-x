import { getResultOutput, isAbortedResult, isFailedResult } from "./result-output.ts";
import type { SingleResult } from "./types.ts";

/** Parent transcript entry, independent of the subagent tool's (possibly collapsed) output. */
export const SUBAGENT_ERROR_CUSTOM_TYPE = "subagent-error";

export interface SubagentErrorEntry {
	agent: string;
	runId?: string;
	message: string;
}

/** Tool errors (e.g. a failed bash command) do not make the child session fail. */
export function subagentErrorEntry(result: SingleResult): SubagentErrorEntry | undefined {
	if (isAbortedResult(result) || !isFailedResult(result)) return undefined;
	if (result.stopReason !== "error" && !result.errorMessage?.trim()) return undefined;
	return {
		agent: result.agent,
		...(result.runId ? { runId: result.runId } : {}),
		message: getResultOutput(result),
	};
}

export function formatSubagentError(entry: SubagentErrorEntry): string {
	return `Subagent ${entry.agent}${entry.runId ? ` [${entry.runId}]` : ""} error: ${entry.message}`;
}
