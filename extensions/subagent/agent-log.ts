/**
 * Pure helpers for `/px:agent:log`.
 *
 * A run's "log" is its original task prompt plus the final assistant output.
 * Three sources are merged:
 *   - the in-memory `SubagentRegistry` (active runs and recent completed runs);
 *   - persisted terminal `SubagentDetails` tool results (blocking runs);
 *   - persisted `subagent-completion` custom messages (detached async runs).
 *
 * The persisted sources survive registry pruning and `/resume`.
 *
 * Duplicates are removed by `runId`, with the registry entry winning because it
 * carries live state. Persisted results without a `runId` (older sessions) fall
 * back to a content signature so they do not double-report registry runs.
 */

import { isTerminalDispatchStatus, normalizeSubagentDetails, SUBAGENT_COMPLETION_CUSTOM_TYPE } from "./completion.ts";
import type { SubagentRunRuntime } from "./registry.ts";
import { getResultOutput, getRunningOutput, isFailedResult } from "./result-output.ts";
import type {
	HerdrRetention,
	HerdrRunLocation,
	SingleResult,
	SubagentBackendKind,
	SubagentDetails,
	SubagentExecution,
} from "./types.ts";

export type AgentLogStatus = "running" | "completed" | "failed";
export type AgentLogSource = "registry" | "persisted";
export type SubagentMode = SubagentDetails["mode"];

export interface AgentLogEntry {
	runId: string;
	agentName: string;
	task: string;
	output: string;
	status: AgentLogStatus;
	source: AgentLogSource;
	mode?: SubagentMode;
	step?: number;
	startedAt?: number;
	completedAt?: number;
	/** Owning dispatch, when the record carries async metadata. */
	dispatchId?: string;
	/** Whether the run came from a detached async or blocking dispatch. */
	execution?: SubagentExecution;
	/** RPC transport; omitted means the process backend. */
	backend?: SubagentBackendKind;
	/** Per-dispatch Herdr retention intent, when the dispatch opted into Herdr. */
	herdrRetention?: HerdrRetention;
	/**
	 * Persisted Herdr location. Informational only: panes may have been closed
	 * manually, so Stage 5 validates it before offering a jump/close action.
	 */
	herdr?: HerdrRunLocation;
	/**
	 * Full result behind this entry, when available. Registry entries always
	 * carry the live result; persisted entries carry the result embedded in
	 * their completion details. Used to open a read-only transcript after the
	 * registry entry has been pruned.
	 */
	result?: SingleResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Read a session-entry (ISO string) or message (epoch ms) timestamp. */
function readTimestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return undefined;
}

/** Convert active/recent registry entries into log entries. */
export function registryAgentLogEntries(runs: SubagentRunRuntime[]): AgentLogEntry[] {
	const entries: AgentLogEntry[] = [];
	for (const run of runs) {
		const result = run.result as unknown as Record<string, unknown>;
		const completed = Boolean(run.completedAt);
		entries.push({
			runId: run.runId,
			agentName: run.agentName,
			task: run.task,
			output: completed ? getResultOutput(result) : getRunningOutput(result),
			status: completed ? (isFailedResult(result) ? "failed" : "completed") : "running",
			source: "registry",
			startedAt: run.startedAt,
			completedAt: run.completedAt,
			dispatchId: run.dispatchId,
			execution: run.execution,
			backend: run.backend,
			herdrRetention: run.herdrRetention,
			herdr: run.herdr,
			result: run.result,
		});
	}
	return entries;
}

/**
 * Scan a session branch for persisted `subagent` tool results and persisted
 * `subagent-completion` custom messages, then flatten them into per-result log
 * entries. Invalid or unrelated entries are ignored.
 *
 * Async acknowledgement tool results carry `dispatchStatus: "started"` and are
 * non-terminal, so they are never surfaced as completed history. Terminal async
 * work is persisted as a `custom_message` whose details rebuild every entry
 * without parsing display text.
 *
 * When the tool-result message exposes `toolName`, it must be `subagent`; the
 * details shape is only trusted as a fallback for older records that lack it.
 */
export function persistedAgentLogEntries(branch: unknown): AgentLogEntry[] {
	const entries: AgentLogEntry[] = [];
	if (!Array.isArray(branch)) return entries;

	// Pass 1: assistant tool-call timestamps let us recover a run's start time.
	const callTimestamps = new Map<string, number>();
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message) || message.role !== "assistant") continue;
		const timestamp = readTimestamp(message.timestamp);
		if (timestamp === undefined || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string") {
				callTimestamps.set(part.id, timestamp);
			}
		}
	}

	// Pass 2: the acknowledgement tool result is the timestamp that matches a
	// later persisted async completion, so record one start time per dispatch.
	const dispatchStartedAt = new Map<string, number>();
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message) || message.role !== "toolResult") continue;
		if (typeof message.toolName === "string" && message.toolName !== "subagent") continue;
		const details = normalizeSubagentDetails(message.details);
		if (!details || isTerminalDispatchStatus(details.dispatchStatus)) continue;
		if (!details.dispatchId || dispatchStartedAt.has(details.dispatchId)) continue;
		const ackTimestamp =
			(typeof message.toolCallId === "string" ? callTimestamps.get(message.toolCallId) : undefined) ??
			readTimestamp(message.timestamp) ??
			readTimestamp(entry.timestamp);
		if (ackTimestamp !== undefined) dispatchStartedAt.set(details.dispatchId, ackTimestamp);
	}

	for (const entry of branch) {
		if (!isRecord(entry)) continue;

		// Persisted async completion messages survive registry pruning and resume.
		if (entry.type === "custom_message") {
			if (entry.customType !== SUBAGENT_COMPLETION_CUSTOM_TYPE) continue;
			const details = normalizeSubagentDetails(entry.details);
			if (!details) continue;
			// Non-terminal completion messages must never appear as finished history.
			if (!isTerminalDispatchStatus(details.dispatchStatus)) continue;
			const completedAt = readTimestamp(entry.timestamp);
			const startedAt = details.dispatchId ? dispatchStartedAt.get(details.dispatchId) : undefined;
			for (const result of details.results) {
				if (!isRecord(result)) continue;
				entries.push({
					runId: typeof result.runId === "string" ? result.runId : "",
					agentName: typeof result.agent === "string" ? result.agent : "unknown",
					task: typeof result.task === "string" ? result.task : "",
					output: getResultOutput(result),
					status: isFailedResult(result) ? "failed" : "completed",
					source: "persisted",
					mode: details.mode,
					step: typeof result.step === "number" ? result.step : undefined,
					startedAt,
					completedAt,
					dispatchId: details.dispatchId,
					execution: details.execution,
					backend: (result.backend as SubagentBackendKind | undefined) ?? details.backend,
					herdrRetention: details.herdrRetention,
					herdr: result.herdr as HerdrRunLocation | undefined,
					result,
				});
			}
			continue;
		}

		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message)) continue;
		if (message.role === "assistant") continue;
		if (message.role !== "toolResult") continue;
		if (typeof message.toolName === "string" && message.toolName !== "subagent") continue;
		const details = normalizeSubagentDetails(message.details);
		if (!details) continue;
		// Async acknowledgements are non-terminal: never surface them as history.
		if (!isTerminalDispatchStatus(details.dispatchStatus)) continue;

		const completedAt = readTimestamp(message.timestamp) ?? readTimestamp(entry.timestamp);
		const startedAt =
			typeof message.toolCallId === "string" ? callTimestamps.get(message.toolCallId) : undefined;

		for (const result of details.results) {
			if (!isRecord(result)) continue;
			entries.push({
				runId: typeof result.runId === "string" ? result.runId : "",
				agentName: typeof result.agent === "string" ? result.agent : "unknown",
				task: typeof result.task === "string" ? result.task : "",
				output: getResultOutput(result),
				status: isFailedResult(result) ? "failed" : "completed",
				source: "persisted",
				mode: details.mode,
				step: typeof result.step === "number" ? result.step : undefined,
				startedAt,
				completedAt,
				dispatchId: details.dispatchId,
				execution: details.execution,
				backend: (result.backend as SubagentBackendKind | undefined) ?? details.backend,
				herdrRetention: details.herdrRetention,
				herdr: result.herdr as HerdrRunLocation | undefined,
				result,
			});
		}
	}
	return entries;
}

function signature(entry: AgentLogEntry): string {
	return [entry.agentName, entry.task, entry.status, entry.output].join("\u0000");
}

function sortEntries(entries: AgentLogEntry[]): AgentLogEntry[] {
	return [...entries].sort((a, b) => {
		const aActive = a.status === "running" ? 0 : 1;
		const bActive = b.status === "running" ? 0 : 1;
		if (aActive !== bActive) return aActive - bActive;
		const aTime = a.completedAt ?? a.startedAt ?? 0;
		const bTime = b.completedAt ?? b.startedAt ?? 0;
		return bTime - aTime;
	});
}

/** Keep live output/status but fill in metadata only the persisted record has. */
function mergeMetadata(entry: AgentLogEntry, richer: AgentLogEntry): AgentLogEntry {
	return {
		...entry,
		mode: entry.mode ?? richer.mode,
		step: entry.step ?? richer.step,
		startedAt: entry.startedAt ?? richer.startedAt,
		completedAt: entry.completedAt ?? richer.completedAt,
		dispatchId: entry.dispatchId ?? richer.dispatchId,
		execution: entry.execution ?? richer.execution,
		backend: entry.backend ?? richer.backend,
		herdrRetention: entry.herdrRetention ?? richer.herdrRetention,
		herdr: entry.herdr ?? richer.herdr,
		result: entry.result ?? richer.result,
	};
}

/**
 * Merge registry and persisted entries. Running runs sort first, then newest
 * activity. Registry entries win on `runId` collisions, but richer persisted
 * metadata (mode/step/timestamps) is preserved. Persisted entries without a
 * `runId` are dropped when their content matches a registry entry.
 */
export function mergeAgentLogEntries(
	registryEntries: AgentLogEntry[],
	persistedEntries: AgentLogEntry[],
): AgentLogEntry[] {
	const merged = registryEntries.map((entry) => ({ ...entry }));
	const byRunId = new Map<string, AgentLogEntry>();
	for (const entry of merged) {
		if (entry.runId) byRunId.set(entry.runId, entry);
	}
	const signatures = new Set(merged.map(signature));

	for (const entry of persistedEntries) {
		if (entry.runId) {
			const existing = byRunId.get(entry.runId);
			if (existing) {
				Object.assign(existing, mergeMetadata(existing, entry));
				continue;
			}
			byRunId.set(entry.runId, entry);
			merged.push(entry);
			continue;
		}
		const key = signature(entry);
		if (signatures.has(key)) continue;
		signatures.add(key);
		merged.push(entry);
	}

	return sortEntries(merged);
}

/** One-line label for the log picker. */
export function describeAgentLogEntry(entry: AgentLogEntry): string {
	const run = entry.runId ? ` [${entry.runId}]` : "";
	const mode = entry.mode ? `  ${entry.mode}` : "";
	const execution = entry.execution ? `  ${entry.execution}` : "";
	return `${entry.agentName}${run}  ${entry.status}${mode}${execution}`;
}

/**
 * Picker labels plus a label -> entry map. Labels are made unique so selecting
 * one can never open a different duplicate-looking entry (which happens when
 * `labels.indexOf(selected)` is used).
 */
export function buildAgentLogPicker(entries: AgentLogEntry[]): {
	labels: string[];
	byLabel: Map<string, AgentLogEntry>;
} {
	const byLabel = new Map<string, AgentLogEntry>();
	const labels: string[] = [];
	for (const entry of entries) {
		const base = describeAgentLogEntry(entry);
		let label = base;
		let suffix = 2;
		while (byLabel.has(label)) {
			label = `${base} (${suffix})`;
			suffix += 1;
		}
		byLabel.set(label, entry);
		labels.push(label);
	}
	return { labels, byLabel };
}

/**
 * Find the persisted log entry for a run id, including the full result when the
 * completion details still carry it. Returns `undefined` for unknown ids and
 * for legacy records without a run id.
 */
export function findPersistedAgentLogEntry(branch: unknown, runId: string): AgentLogEntry | undefined {
	if (!runId) return undefined;
	return persistedAgentLogEntries(branch).find((entry) => entry.runId === runId);
}

/**
 * Recover the complete persisted `SingleResult` for a run id. This is what
 * lets a completed or pruned run reopen in the read-only attach view after
 * `/resume`, using the same transcript model as a live run.
 */
export function recoverPersistedResult(branch: unknown, runId: string): SingleResult | undefined {
	return findPersistedAgentLogEntry(branch, runId)?.result;
}

/** Full task + output view shown in the editor. */
export function formatAgentLogEntry(entry: AgentLogEntry): string {
	const label = entry.runId ? `${entry.agentName} [${entry.runId}]` : entry.agentName;
	const lines: string[] = [`Agent: ${label}`];
	if (entry.mode) lines.push(`Mode: ${entry.mode}${entry.step ? ` (step ${entry.step})` : ""}${entry.execution ? ` [${entry.execution}]` : ""}`);
	if (entry.dispatchId) lines.push(`Dispatch: ${entry.dispatchId}`);
	if (entry.backend) lines.push(`Backend: ${entry.backend}`);
	if (entry.herdr) lines.push(`Herdr tab: ${entry.herdr.tabId}`);
	if (entry.herdr) lines.push(`Herdr pane: ${entry.herdr.paneId}${entry.herdr.retained ? " (retained)" : ""}`);
	if (entry.herdrRetention) lines.push(`Retention: ${entry.herdrRetention}`);
	lines.push(`Status: ${entry.status}`);
	if (entry.startedAt) lines.push(`Started: ${new Date(entry.startedAt).toISOString()}`);
	if (entry.completedAt) lines.push(`Completed: ${new Date(entry.completedAt).toISOString()}`);
	lines.push("");
	lines.push("Task:");
	lines.push(entry.task || "(none)");
	lines.push("");
	lines.push("Output:");
	lines.push(entry.output || "(no output)");
	return lines.join("\n");
}

/** Concatenated view of every run, for the "all runs" editor. */
export function formatAgentLog(entries: AgentLogEntry[]): string {
	return entries.map(formatAgentLogEntry).join("\n\n────────────\n\n");
}
