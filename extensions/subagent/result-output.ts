/**
 * Canonical per-result output helpers for the subagent tool.
 *
 * Shared by the tool implementation (`index.ts`) and the `/px:agent:log`
 * merger (`agent-log.ts`) so both surfaces render exactly the same final
 * output, including failure/stderr fallbacks and empty/multiple text parts.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Canonical "final output": the first text part of the last assistant message
 * that has one. Mirrors the tool's historical behavior exactly (including
 * whitespace-only text parts, which are returned as-is).
 */
export function getFinalOutput(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant") continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
		}
	}
	return "";
}

export interface ResultStatusFields {
	exitCode?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
	stderr?: unknown;
	messages?: unknown;
}

/** Canonical failure check. Missing `exitCode` is treated as success (`0`). */
export function isFailedResult(result: ResultStatusFields): boolean {
	const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
	const stopReason = typeof result.stopReason === "string" ? result.stopReason : "";
	return exitCode !== 0 || stopReason === "error" || stopReason === "aborted";
}

/**
 * True when a settled result ended because the child was aborted. Aborted
 * results also satisfy `isFailedResult()`, so this must be checked first when
 * choosing a dispatch status.
 */
export function isAbortedResult(result: ResultStatusFields): boolean {
	return typeof result.stopReason === "string" && result.stopReason === "aborted";
}

/**
 * Canonical output for a finished result: failures prefer the error message
 * then stderr, everything else falls back to the final assistant text.
 */
export function getResultOutput(result: ResultStatusFields): string {
	if (isFailedResult(result)) {
		const errorMessage = typeof result.errorMessage === "string" ? result.errorMessage : "";
		const stderr = typeof result.stderr === "string" ? result.stderr : "";
		return errorMessage || stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/**
 * Output shown while a run is still streaming. Mirrors the tool's `onUpdate`
 * payload: final text, then live text, then a placeholder.
 */
export function getRunningOutput(result: ResultStatusFields & { liveText?: unknown }): string {
	const finalOutput = getFinalOutput(result.messages);
	if (finalOutput) return finalOutput;
	const liveText = typeof result.liveText === "string" ? result.liveText : "";
	return liveText || "(running...)";
}
