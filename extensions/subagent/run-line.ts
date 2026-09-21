/**
 * The one-line "run settled" model, shared by two surfaces:
 *
 * - the TUI-only `subagent-run-finished` entry appended as each detached run
 *   settles (`pi.appendEntry`), and
 * - the compact entry list inside the expanded dispatch completion message.
 *
 * Both must read identically, so the text is produced here exactly once. The
 * module is pure and theme-free: callers pass style functions in, so the same
 * line can be rendered plain (tests, text fallback) or themed.
 */

import { isAbortedResult, isFailedResult, type ResultStatusFields } from "./result-output.ts";
import { formatDuration, type SubagentTiming } from "./timing.ts";

/** Entry type for a settled run. Rendered by `registerEntryRenderer`; never sent to the LLM. */
export const SUBAGENT_RUN_FINISHED_CUSTOM_TYPE = "subagent-run-finished";

/**
 * Left padding for the entry line.
 *
 * The host renders custom entries with `renderer(entry, { expanded }, theme)`,
 * so an entry never learns the `outputPad` setting (0 or 1, default 1) that is
 * injected into message and tool renderers. Entries are expected to supply
 * their own padding, so pin the default to line up with the rest of the
 * transcript. Only relevant for the TUI entry; the expanded dispatch list
 * inside the completion message uses the host-provided `outputPad`.
 */
export const RUN_LINE_OUTPUT_PAD = 1;

export type RunOutcome = "finished" | "failed" | "aborted" | "notRun";

/** Terminal glyph per outcome, matching the dispatch-level icon set. */
export const RUN_OUTCOME_GLYPH: Record<RunOutcome, string> = {
	finished: "✓",
	failed: "✗",
	aborted: "⊘",
	notRun: "⊘",
};

/** Terminal color per outcome, resolved through the caller's theme. */
export const RUN_OUTCOME_COLOR: Record<RunOutcome, "success" | "error" | "warning"> = {
	finished: "success",
	failed: "error",
	aborted: "warning",
	notRun: "warning",
};

/** Outcome verb used in the line detail. */
const RUN_OUTCOME_VERB: Record<RunOutcome, string> = {
	finished: "finished",
	failed: "failed",
	aborted: "aborted",
	notRun: "not run",
};

export interface RunLineParts {
	outcome: RunOutcome;
	runId: string;
	/** Outcome, duration, and metrics: `finished in 1m 12s, 4 turns, ctx:10%, $0.02`. */
	detail: string;
}

export interface RunLineDetailInput {
	outcome: RunOutcome;
	durationMs?: number;
	turns?: number;
	cost?: number;
	contextPercent?: number;
}

/**
 * Cost rendering keeps short lines short: cents precision normally, and four
 * decimals only when rounding to cents would hide a real (non-zero) cost.
 */
export function formatCost(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0";
	return cost >= 0.005 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

/**
 * `finished in 1m 12s, 4 turns, ctx:10%, $0.02`.
 *
 * An unknown duration still renders the verb so the outcome is never lost, and
 * an unstarted chain step renders plain `not run` with no metrics.
 */
export function formatRunLineDetail(input: RunLineDetailInput): string {
	if (input.outcome === "notRun") return RUN_OUTCOME_VERB.notRun;
	const parts: string[] = [];
	const preposition = input.outcome === "finished" ? "in" : "after";
	parts.push(
		input.durationMs === undefined
			? RUN_OUTCOME_VERB[input.outcome]
			: `${RUN_OUTCOME_VERB[input.outcome]} ${preposition} ${formatDuration(input.durationMs)}`,
	);
	if (input.turns) parts.push(`${input.turns} turn${input.turns > 1 ? "s" : ""}`);
	if (input.contextPercent !== undefined && Number.isFinite(input.contextPercent)) {
		parts.push(`ctx:${Math.round(input.contextPercent)}%`);
	}
	if (input.cost) parts.push(formatCost(input.cost));
	return parts.join(", ");
}

export interface RunLineStyles {
	success: (text: string) => string;
	warning: (text: string) => string;
	error: (text: string) => string;
	muted: (text: string) => string;
	italic: (text: string) => string;
}

/**
 * Themed line: colored outcome glyph, then the run id upright, then the rest
 * italic and muted so a settled run informs without pulling attention.
 */
export function formatRunLine(parts: RunLineParts, styles: RunLineStyles): string {
	const icon = styles[RUN_OUTCOME_COLOR[parts.outcome]](RUN_OUTCOME_GLYPH[parts.outcome]);
	return `${icon} ${styles.muted(parts.runId)} ${styles.italic(styles.muted(parts.detail))}`;
}

/** Plain line for text output and tests. */
export function formatRunLinePlain(parts: RunLineParts): string {
	return `${RUN_OUTCOME_GLYPH[parts.outcome]} ${parts.runId} ${parts.detail}`;
}

/**
 * Persisted payload for one settled run. Flat and JSON-safe so a restored
 * session can re-render the line without any runtime state.
 */
export interface SubagentRunFinishedEntry {
	runId: string;
	agent?: string;
	task?: string;
	model?: string;
	outcome: RunOutcome;
	/** Wall-clock duration of the run in milliseconds. */
	durationMs?: number;
	turns?: number;
	cost?: number;
	contextPercent?: number;
}

/** Rebuild the render parts from a persisted entry. */
export function runLinePartsFromEntry(entry: SubagentRunFinishedEntry): RunLineParts {
	return {
		outcome: entry.outcome,
		runId: entry.runId,
		detail: formatRunLineDetail({
			outcome: entry.outcome,
			durationMs: entry.durationMs,
			turns: entry.turns,
			cost: entry.cost,
			contextPercent: entry.contextPercent,
		}),
	};
}

/** Classify a settled result. Aborted is checked first: it also reads as failed. */
export function runOutcomeFromResult(result: ResultStatusFields): RunOutcome {
	if (isAbortedResult(result)) return "aborted";
	return isFailedResult(result) ? "failed" : "finished";
}

/** Context usage as a percentage, or undefined when either side is unknown. */
export function contextPercentOf(
	contextTokens: number | undefined,
	contextWindow: number | undefined,
): number | undefined {
	if (!contextTokens || contextTokens <= 0 || !contextWindow || contextWindow <= 0) return undefined;
	return Math.round((contextTokens / contextWindow) * 100);
}

/** Convert one settled run into its persisted entry. */
export function buildRunFinishedEntry(
	runId: string,
	result: {
		agent?: string;
		task?: string;
		model?: string;
		timing?: SubagentTiming;
		usage?: { turns?: number; cost?: number; contextTokens?: number };
	} & ResultStatusFields,
	contextWindow?: number,
): SubagentRunFinishedEntry {
	const percent = contextPercentOf(result.usage?.contextTokens, contextWindow);
	return {
		runId,
		...(result.agent ? { agent: result.agent } : {}),
		...(result.task ? { task: result.task } : {}),
		...(result.model ? { model: result.model } : {}),
		outcome: runOutcomeFromResult(result),
		...(result.timing ? { durationMs: result.timing.wallMs } : {}),
		...(result.usage?.turns ? { turns: result.usage.turns } : {}),
		...(result.usage?.cost ? { cost: result.usage.cost } : {}),
		...(percent !== undefined ? { contextPercent: percent } : {}),
	};
}

function isRunOutcome(value: unknown): value is RunOutcome {
	return value === "finished" || value === "failed" || value === "aborted" || value === "notRun";
}

/**
 * Validate and normalize a persisted entry. Returns `undefined` when the data
 * is not a run record or carries no usable run id, so the renderer can fall
 * back instead of printing a half-empty line.
 */
export function normalizeRunFinishedEntry(value: unknown): SubagentRunFinishedEntry | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.runId !== "string" || !record.runId) return undefined;
	if (!isRunOutcome(record.outcome)) return undefined;
	const number = (key: string): number | undefined =>
		typeof record[key] === "number" && Number.isFinite(record[key]) ? (record[key] as number) : undefined;
	const text = (key: string): string | undefined =>
		typeof record[key] === "string" && record[key] ? (record[key] as string) : undefined;
	const durationMs = number("durationMs");
	const turns = number("turns");
	const cost = number("cost");
	const contextPercent = number("contextPercent");
	const agent = text("agent");
	const task = text("task");
	const model = text("model");
	return {
		runId: record.runId,
		outcome: record.outcome,
		...(agent ? { agent } : {}),
		...(task ? { task } : {}),
		...(model ? { model } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(turns !== undefined ? { turns } : {}),
		...(cost !== undefined ? { cost } : {}),
		...(contextPercent !== undefined ? { contextPercent } : {}),
	};
}
