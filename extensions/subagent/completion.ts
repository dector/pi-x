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

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getResultOutput, isAbortedResult, isFailedResult, type ResultStatusFields } from "./result-output.ts";
import type {
	NormalizedSubagentDetails,
	PreparedDispatchItem,
	PreparedSubagentDispatch,
	SingleResult,
	SubagentDetails,
	SubagentDispatchStatus,
	SubagentExecution,
	SubagentMode,
} from "./types.ts";

/** Model-visible output cap per task, in bytes. */
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** Custom message type for the one aggregate completion of an async dispatch. */
export const SUBAGENT_COMPLETION_CUSTOM_TYPE = "subagent-completion";

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
	// Read the required `results` first so a corrupt getter cannot be skipped by
	// an earlier short-circuit and silently produce a non-throwing fallback.
	if (!Array.isArray(value.results)) return undefined;
	if (!isMode(value.mode)) return undefined;

	const { execution, dispatchStatus } = normalizeDispatchMetadata(value);
	const agentScope =
		value.agentScope === "user" || value.agentScope === "project" || value.agentScope === "both"
			? value.agentScope
			: "user";
	const plannedItems = normalizePlannedItems(value.plannedItems);

	return {
		mode: value.mode,
		agentScope,
		projectAgentsDir: typeof value.projectAgentsDir === "string" ? value.projectAgentsDir : null,
		execution,
		dispatchId: typeof value.dispatchId === "string" ? value.dispatchId : undefined,
		dispatchStatus,
		plannedItems,
		cwd: typeof value.cwd === "string" ? value.cwd : undefined,
		results: value.results as SingleResult[],
	};
}

/**
 * Validate persisted planned-item metadata. Entries without a runId, agent, or
 * task are dropped rather than half-trusted, and `cwd`/`step` are only kept
 * when they have the right primitive type.
 */
export function normalizePlannedItems(value: unknown): PreparedDispatchItem[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items: PreparedDispatchItem[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		if (typeof entry.runId !== "string" || !entry.runId) continue;
		if (typeof entry.agent !== "string" || typeof entry.task !== "string") continue;
		items.push({
			runId: entry.runId,
			agent: entry.agent,
			task: entry.task,
			...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
			...(typeof entry.step === "number" ? { step: entry.step } : {}),
		});
	}
	return items.length > 0 ? items : undefined;
}

/**
 * Coerce a settled runner's details into a terminal record before it is
 * delivered or persisted. The dispatch is authoritative for identity, and a
 * non-terminal (or missing) runner status is replaced by one derived from the
 * results. This is the last line of defence against a runner bug surfacing a
 * `"started"` acknowledgement as a completion.
 */
export function coerceTerminalCompletionDetails(
	dispatch: PreparedSubagentDispatch,
	value: unknown,
	options: { aborted?: boolean; isError?: boolean } = {},
): SubagentDetails {
	const normalized = normalizeSubagentDetails(value);
	const results = normalized?.results ?? [];
	const plannedItems = normalized?.plannedItems ?? dispatch.items;
	let dispatchStatus = normalized?.dispatchStatus;
	if (!isTerminalDispatchStatus(dispatchStatus)) {
		const aborted =
			options.aborted === true || results.some((result) => isAbortedResult(result as ResultStatusFields));
		dispatchStatus = aggregateDispatchStatus(results, { error: options.isError === true, aborted });
	}
	return {
		mode: dispatch.mode,
		execution: dispatch.execution,
		dispatchId: dispatch.dispatchId,
		dispatchStatus,
		agentScope: normalized?.agentScope ?? dispatch.agentScope,
		projectAgentsDir: normalized?.projectAgentsDir ?? dispatch.projectAgentsDir,
		...(plannedItems.length > 0 ? { plannedItems } : {}),
		cwd: normalized?.cwd ?? dispatch.cwd,
		results,
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
	execution?: SubagentExecution;
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
		`Subagent dispatch ${input.dispatchId} started in the background (${input.mode}, ${input.execution ?? "async"}).`,
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
		'To stop or steer it, call subagent with action: "stop" or "steer" and the dispatch id above (or one run id).',
	);
	return lines.join("\n");
}

/**
 * Build the immediate tool result returned when a dispatch is detached. It is a
 * non-terminal `"started"` acknowledgement, not a completion record, so it must
 * never be surfaced as finished history.
 */
export function buildAsyncStartResult(dispatch: PreparedSubagentDispatch): AgentToolResult<SubagentDetails> {
	return {
		content: [
			{
				type: "text",
				text: formatAsyncAcknowledgement({
					dispatchId: dispatch.dispatchId,
					execution: dispatch.execution,
					mode: dispatch.mode,
					items: dispatch.items.map((item) => ({
						agent: item.agent,
						runId: item.runId,
						task: item.task,
						cwd: item.cwd ?? dispatch.cwd,
					})),
				}),
			},
		],
		details: {
			mode: dispatch.mode,
			execution: "async",
			dispatchId: dispatch.dispatchId,
			dispatchStatus: "started",
			agentScope: dispatch.agentScope,
			projectAgentsDir: dispatch.projectAgentsDir,
			plannedItems: dispatch.items,
			cwd: dispatch.cwd,
			results: [],
		},
	};
}

/**
 * Ordered section model for one completion. Planned items come first (so a
 * stopped chain still shows its unstarted steps); any result without a matching
 * planned run is appended instead of being dropped.
 */
export interface CompletionRenderSection {
	agent: string;
	runId?: string;
	step?: number;
	status: string;
	task: string;
	cwd?: string;
	output: string;
	failed: boolean;
	/** True for a planned chain step that never started. */
	notRun: boolean;
}

function sectionFromResult(raw: unknown): CompletionRenderSection | undefined {
	if (!isRecord(raw)) return undefined;
	const failed = isFailedResult(raw);
	return {
		agent: typeof raw.agent === "string" ? raw.agent : "unknown",
		runId: typeof raw.runId === "string" && raw.runId ? raw.runId : undefined,
		step: typeof raw.step === "number" ? raw.step : undefined,
		status: formatTaskStatus(raw),
		task: typeof raw.task === "string" ? raw.task : "",
		cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
		output: truncateTaskOutput(getResultOutput(raw)),
		failed,
		notRun: false,
	};
}

function sectionForUnstartedItem(item: PreparedDispatchItem, mode: SubagentMode, fallbackCwd?: string): CompletionRenderSection {
	const notRun = mode === "chain";
	return {
		agent: item.agent,
		runId: item.runId || undefined,
		step: item.step,
		task: item.task,
		cwd: item.cwd ?? fallbackCwd,
		status: notRun ? "not run" : "failed (no result)",
		output: notRun ? "the chain stopped before this step." : "the run produced no result.",
		failed: !notRun,
		notRun,
	};
}

/**
 * Merge planned items with the results that actually settled. Results are the
 * source of truth for output/status; planned items supply the task, step, and
 * the not-run entries a stopped chain would otherwise hide.
 */
export function collectCompletionSections(
	plannedItems: readonly PreparedDispatchItem[],
	results: readonly unknown[],
	mode: SubagentMode,
	fallbackCwd?: string,
): CompletionRenderSection[] {
	const sections: CompletionRenderSection[] = [];
	const matched = new Set<number>();
	const indexByRunId = new Map<string, number>();
	for (let index = 0; index < results.length; index += 1) {
		const raw = results[index];
		if (isRecord(raw) && typeof raw.runId === "string" && raw.runId && !indexByRunId.has(raw.runId)) {
			indexByRunId.set(raw.runId, index);
		}
	}

	for (const item of plannedItems) {
		const index = item.runId ? indexByRunId.get(item.runId) : undefined;
		if (index !== undefined) {
			const section = sectionFromResult(results[index]);
			if (section) {
				// The planned item carries the original task/step/cwd; fill gaps
				// rather than dropping them when a runner result is terse.
				section.task = section.task || item.task;
				section.cwd = section.cwd ?? item.cwd ?? fallbackCwd;
				section.step = section.step ?? item.step;
				matched.add(index);
				sections.push(section);
				continue;
			}
		}
		sections.push(sectionForUnstartedItem(item, mode, fallbackCwd));
	}

	// Include results that have no matching planned item (older records, or an
	// unexpected extra run) rather than silently dropping them.
	for (let index = 0; index < results.length; index += 1) {
		if (matched.has(index)) continue;
		const section = sectionFromResult(results[index]);
		if (!section) continue;
		section.cwd = section.cwd ?? fallbackCwd;
		sections.push(section);
	}
	return sections;
}

/** `2/3 succeeded` plus an optional `, 1 not run` suffix. */
export function formatCompletionCounts(succeeded: number, total: number, notRun: number): string {
	const notRunSuffix = notRun > 0 ? `, ${notRun} not run` : "";
	return `${succeeded}/${total} succeeded${notRunSuffix}`;
}

/** `[agent] [runId] step N status` header shared by text and TUI renderers. */
export function completionSectionHeader(section: CompletionRenderSection): string {
	const runId = section.runId ? ` [${section.runId}]` : "";
	const step = section.step !== undefined ? ` step ${section.step}` : "";
	return `[${section.agent}]${runId}${step} ${section.status}`;
}

/** Output line label for a section: `Not run`, `Failure`, or `Output`. */
export function completionOutputLabel(section: CompletionRenderSection): string {
	if (section.notRun) return "Not run";
	return section.failed ? "Failure" : "Output";
}

/**
 * Model-visible text for the single aggregate completion message. Carries the
 * dispatch identity, every requested run, its original task, working
 * directory, terminal status, and output/diagnostic, plus an aggregate
 * summary. Per-task output stays under the same 50 KB cap as blocking
 * summaries.
 *
 * The summary denominator is the number of *requested* items, not the number
 * of results, so a chain that stopped early reports `N/M succeeded` rather
 * than a misleading `N/N`. Later chain steps that never started are reported as
 * `not run` instead of as failures. A non-terminal runner status is coerced to
 * a terminal one here as well, so a runner bug can never surface a `started`
 * completion to the model.
 */
export function formatAsyncCompletion(
	dispatch: PreparedSubagentDispatch,
	result: AgentToolResult<SubagentDetails>,
): string {
	// Deliberately a direct property read: a null/corrupt result must throw so
	// the lifecycle fallback message is used instead of a fabricated summary.
	const details = result.details;
	const normalized = normalizeSubagentDetails(details);
	const results = normalized?.results ?? [];
	const plannedItems = normalized?.plannedItems ?? dispatch.items;
	const fallbackCwd = normalized?.cwd ?? dispatch.cwd;
	const dispatchStatus = isTerminalDispatchStatus(normalized?.dispatchStatus)
		? normalized.dispatchStatus
		: aggregateDispatchStatus(results, {
				error: (result as unknown as { isError?: unknown }).isError === true,
				aborted: results.some((single) => isAbortedResult(single as ResultStatusFields)),
			});
	const sections = collectCompletionSections(plannedItems, results, dispatch.mode, fallbackCwd);
	const succeeded = sections.filter((section) => !section.failed && !section.notRun).length;
	const notRun = sections.filter((section) => section.notRun).length;

	const lines: string[] = [
		`Subagent dispatch ${dispatch.dispatchId} ${dispatchStatus} (mode: ${dispatch.mode}, execution: ${dispatch.execution}).`,
	];
	for (const section of sections) {
		const runId = section.runId ? ` [${section.runId}]` : "";
		lines.push("", `### [${section.agent}]${runId} ${section.status}`, `Task: ${section.task}`);
		if (section.cwd) lines.push(`Directory: ${section.cwd}`);
		lines.push(`${completionOutputLabel(section)}: ${section.output}`);
	}
	lines.push("", `Summary: ${formatCompletionCounts(succeeded, sections.length, notRun)}.`);
	return lines.join("\n");
}

/**
 * Structured data for the `subagent-completion` message renderer. Pure and
 * theme-free so it can be unit tested without the TUI runtime; `index.ts` maps
 * it to `Text`/`Container`/`Markdown` components.
 */
export interface CompletionRenderData {
	dispatchId?: string;
	mode: SubagentMode;
	execution: SubagentExecution;
	dispatchStatus: SubagentDispatchStatus;
	/** One-line collapsed summary. */
	title: string;
	/** Aggregate success summary. */
	summary: string;
	succeeded: number;
	failed: number;
	notRun: number;
	total: number;
	sections: CompletionRenderSection[];
}

/**
 * Normalize persisted/runtime completion details into render data. Returns
 * `undefined` for non-dispatch records so the renderer can fall back to the
 * raw message content. Planned items (persisted or supplied as a fallback)
 * keep the totals and sections aligned with what the dispatch actually asked
 * for, including unstarted chain steps.
 */
export function buildCompletionRenderData(
	value: unknown,
	plannedFallback?: readonly PreparedDispatchItem[],
): CompletionRenderData | undefined {
	const details = normalizeSubagentDetails(value);
	if (!details) return undefined;

	const plannedItems = details.plannedItems ?? plannedFallback ?? [];
	const sections = collectCompletionSections(plannedItems, details.results, details.mode, details.cwd);
	const succeeded = sections.filter((section) => !section.failed && !section.notRun).length;
	const notRun = sections.filter((section) => section.notRun).length;
	const failed = sections.length - succeeded - notRun;
	const dispatchId = details.dispatchId;
	const counts = formatCompletionCounts(succeeded, sections.length, notRun);
	return {
		dispatchId,
		mode: details.mode,
		execution: details.execution,
		dispatchStatus: details.dispatchStatus,
		title: `Subagent dispatch ${dispatchId ?? "(unknown)"} ${details.dispatchStatus} (${details.mode}, ${details.execution}) — ${counts}`,
		summary: `Summary: ${counts}.`,
		succeeded,
		failed,
		notRun,
		total: sections.length,
		sections,
	};
}

/**
 * Renderer blocks in display order. Both the plain-text helper and the TUI
 * renderer consume this single model, so collapsed/expanded output and the
 * themed UI cannot drift apart.
 */
export type CompletionRenderBlock =
	| { kind: "title"; text: string }
	| { kind: "summary"; text: string }
	| { kind: "header"; section: CompletionRenderSection; text: string }
	| { kind: "task"; section: CompletionRenderSection; text: string }
	| { kind: "directory"; section: CompletionRenderSection; text: string }
	| { kind: "output"; section: CompletionRenderSection; label: string; text: string };

export function buildCompletionRenderBlocks(data: CompletionRenderData): CompletionRenderBlock[] {
	const blocks: CompletionRenderBlock[] = [
		{ kind: "title", text: data.title },
		{ kind: "summary", text: data.summary },
	];
	for (const section of data.sections) {
		blocks.push({ kind: "header", section, text: completionSectionHeader(section) });
		blocks.push({ kind: "task", section, text: section.task });
		if (section.cwd) blocks.push({ kind: "directory", section, text: section.cwd });
		blocks.push({ kind: "output", section, label: completionOutputLabel(section), text: section.output });
	}
	return blocks;
}

/**
 * Theme-free text for the completion renderer. Collapsed is the one-line
 * aggregate; expanded lists every planned run's task, run ID, directory, and
 * output/error (including not-run chain steps). Returns `undefined` when the
 * details are not a dispatch.
 */
export function formatCompletionRenderText(
	value: unknown,
	options: { expanded?: boolean } = {},
): string | undefined {
	const data = buildCompletionRenderData(value);
	if (!data) return undefined;
	if (!options.expanded) return data.title;

	const lines: string[] = [];
	for (const block of buildCompletionRenderBlocks(data)) {
		switch (block.kind) {
			case "title":
				lines.push(block.text);
				break;
			case "summary":
				lines.push(block.text);
				break;
			case "header":
				lines.push("", `### ${block.text}`);
				break;
			case "task":
				lines.push(`Task: ${block.text}`);
				break;
			case "directory":
				lines.push(`Directory: ${block.text}`);
				break;
			case "output":
				lines.push(`${block.label}: ${block.text}`);
				break;
		}
	}
	return lines.join("\n");
}

/**
 * Minimal terminal result used when a dispatch is refused before preparation
 * (for example the session is already shutting down). It is a completed
 * failure, never a `started` acknowledgement, so it cannot be mistaken for
 * background work.
 */
export function buildNotStartedResult(text: string, isError = true): AgentToolResult<SubagentDetails> {
	return {
		content: [{ type: "text", text }],
		details: {
			mode: "single",
			execution: "async",
			dispatchStatus: "aborted",
			agentScope: "user",
			projectAgentsDir: null,
			results: [],
		},
		...(isError ? { isError: true as const } : {}),
	};
}
