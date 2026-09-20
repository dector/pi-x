/**
 * Pure helpers for `/px:agent:log`.
 *
 * A run's "log" is its original task prompt plus the final assistant output.
 * Two sources are merged:
 *   - the in-memory `SubagentRegistry` (active runs and recent completed runs);
 *   - persisted `SubagentDetails` tool results in the current session branch,
 *     which survive registry pruning and `/resume`.
 *
 * Duplicates are removed by `runId`, with the registry entry winning because it
 * carries live state. Persisted results without a `runId` (older sessions) fall
 * back to a content signature so they do not double-report registry runs.
 */

import { isTerminalDispatchStatus, normalizeSubagentDetails } from "./completion.ts";
import type { SubagentRunRuntime } from "./registry.ts";
import { getResultOutput, getRunningOutput, isFailedResult } from "./result-output.ts";
import type { SubagentDetails } from "./types.ts";

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
		});
	}
	return entries;
}

/**
 * Scan a session branch for persisted `subagent` tool results and flatten them
 * into per-result log entries. Invalid or unrelated entries are ignored.
 *
 * When the tool-result message exposes `toolName`, it must be `subagent`; the
 * details shape is only trusted as a fallback for older records that lack it.
 */
export function persistedAgentLogEntries(branch: unknown): AgentLogEntry[] {
	const entries: AgentLogEntry[] = [];
	if (!Array.isArray(branch)) return entries;

	// Assistant tool-call timestamps let us recover the run start time; the tool
	// result message/entry timestamp is the completion time.
	const callTimestamps = new Map<string, number>();

	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message)) continue;

		if (message.role === "assistant") {
			const timestamp = readTimestamp(message.timestamp);
			if (timestamp !== undefined && Array.isArray(message.content)) {
				for (const part of message.content) {
					if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string") {
						callTimestamps.set(part.id, timestamp);
					}
				}
			}
			continue;
		}

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
	return `${entry.agentName}${run}  ${entry.status}${mode}`;
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

/** Full task + output view shown in the editor. */
export function formatAgentLogEntry(entry: AgentLogEntry): string {
	const label = entry.runId ? `${entry.agentName} [${entry.runId}]` : entry.agentName;
	const lines: string[] = [`Agent: ${label}`];
	if (entry.mode) lines.push(`Mode: ${entry.mode}${entry.step ? ` (step ${entry.step})` : ""}`);
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
