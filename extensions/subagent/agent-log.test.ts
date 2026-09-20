import { describe, expect, test } from "bun:test";
import {
	buildAgentLogPicker,
	formatAgentLog,
	formatAgentLogEntry,
	mergeAgentLogEntries,
	persistedAgentLogEntries,
	registryAgentLogEntries,
	type AgentLogEntry,
} from "./agent-log.ts";
import { getFinalOutput, getResultOutput } from "./result-output.ts";
import { createRunIdGenerator } from "./run-id.ts";
import type { SubagentRunRuntime } from "./registry.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function assistant(text: string) {
	return { role: "assistant", content: [{ type: "text", text }], usage, stopReason: "end" };
}

function runtime(overrides: Partial<SubagentRunRuntime> & { result?: SubagentRunRuntime["result"] }): SubagentRunRuntime {
	return {
		runId: "sa-1",
		agentName: "scout",
		task: "find auth code",
		cwd: "/tmp",
		startedAt: Date.now(),
		result: {
			agent: "scout",
			agentSource: "user",
			task: "find auth code",
			exitCode: 0,
			messages: [assistant("scout output")],
			stderr: "",
			usage,
		},
		...overrides,
	};
}

function branchWithDetails(details: unknown, message: Record<string, unknown> = {}): unknown[] {
	return [{ type: "message", message: { role: "toolResult", toolName: "subagent", details, ...message } }];
}

describe("canonical output (shared with the tool result)", () => {
	test("returns the first text part of the last assistant message", () => {
		expect(getFinalOutput([assistant("first"), assistant("last")])).toBe("last");
		expect(getFinalOutput([assistant("first"), { role: "user", content: "x" }])).toBe("first");
		expect(
			getFinalOutput([
				{ role: "assistant", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
			]),
		).toBe("one");
	});

	test("preserves whitespace-only final text instead of skipping it", () => {
		expect(getFinalOutput([assistant("real"), assistant("   ")])).toBe("   ");
	});

	test("handles non-array and malformed input", () => {
		expect(getFinalOutput(undefined)).toBe("");
		expect(getFinalOutput("nope")).toBe("");
		expect(getFinalOutput([null, 42, { role: "assistant", content: "plain" }])).toBe("");
	});

	test("failures prefer errorMessage, then stderr, then final output", () => {
		expect(getResultOutput({ exitCode: 1, errorMessage: "boom", stderr: "trace", messages: [assistant("out")] })).toBe(
			"boom",
		);
		expect(getResultOutput({ exitCode: 1, stderr: "trace", messages: [assistant("out")] })).toBe("trace");
		expect(getResultOutput({ exitCode: 1, messages: [assistant("out")] })).toBe("out");
		expect(getResultOutput({ exitCode: 1, messages: [] })).toBe("(no output)");
		expect(getResultOutput({ exitCode: 0, messages: [] })).toBe("(no output)");
	});
});

describe("persistedAgentLogEntries", () => {
	test("flattens every subagent result with task, output, mode, and step", () => {
		const entries = persistedAgentLogEntries(
			branchWithDetails({
				mode: "chain",
				results: [
					{ runId: "sa-1", agent: "scout", task: "step one", messages: [assistant("found it")], exitCode: 0, usage },
					{ runId: "sa-2", agent: "worker", task: "step two", messages: [], stderr: "boom", exitCode: 1, step: 2, usage },
				],
			}),
		);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			runId: "sa-1",
			agentName: "scout",
			task: "step one",
			output: "found it",
			status: "completed",
			mode: "chain",
			source: "persisted",
		});
		expect(entries[1]).toMatchObject({ runId: "sa-2", output: "boom", status: "failed", step: 2 });
	});

	test("ignores unrelated entries and invalid details", () => {
		expect(persistedAgentLogEntries(undefined)).toEqual([]);
		expect(persistedAgentLogEntries([{ type: "message", message: { role: "user" } }])).toEqual([]);
		expect(persistedAgentLogEntries(branchWithDetails({ mode: "banana", results: [] }))).toEqual([]);
		expect(persistedAgentLogEntries([{ type: "custom", customType: "subagent" }])).toEqual([]);
	});

	test("hardens the scan with toolName when the shape exposes it", () => {
		const shaped = { mode: "single", results: [{ runId: "sa-1", agent: "scout", task: "t", messages: [], exitCode: 0, usage }] };
		expect(persistedAgentLogEntries(branchWithDetails(shaped, { toolName: "bash" }))).toEqual([]);
		// Missing toolName (older sessions) still falls back to the details shape.
		const noName = [{ type: "message", message: { role: "toolResult", details: shaped } }];
		expect(persistedAgentLogEntries(noName)).toHaveLength(1);
	});

	test("captures persisted started/completed timestamps when present", () => {
		const startedAt = 1_700_000_000_000;
		const completedAt = 1_700_000_005_000;
		const branch = [
			{
				type: "message",
				timestamp: new Date(startedAt).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: {} }],
					timestamp: startedAt,
				},
			},
			{
				type: "message",
				timestamp: new Date(completedAt).toISOString(),
				message: {
					role: "toolResult",
					toolName: "subagent",
					toolCallId: "call-1",
					timestamp: completedAt,
					details: {
						mode: "single",
						results: [{ runId: "sa-9", agent: "scout", task: "t", messages: [assistant("done")], exitCode: 0, usage }],
					},
				},
			},
		];
		const [entry] = persistedAgentLogEntries(branch);
		expect(entry?.startedAt).toBe(startedAt);
		expect(entry?.completedAt).toBe(completedAt);
	});

	test("ignores async acknowledgements that have not settled", () => {
		const started = branchWithDetails({
			mode: "parallel",
			execution: "async",
			dispatchId: "d-1",
			dispatchStatus: "started",
			results: [{ runId: "sa-1", agent: "scout", task: "t", messages: [assistant("partial")], exitCode: -1, usage }],
		});
		expect(persistedAgentLogEntries(started)).toEqual([]);

		const completed = branchWithDetails({
			mode: "parallel",
			execution: "async",
			dispatchId: "d-1",
			dispatchStatus: "completed",
			results: [{ runId: "sa-1", agent: "scout", task: "t", messages: [assistant("done")], exitCode: 0, usage }],
		});
		expect(persistedAgentLogEntries(completed)).toHaveLength(1);
	});

	test("leaves runId empty when the persisted result has none", () => {
		const entries = persistedAgentLogEntries(
			branchWithDetails({ mode: "single", results: [{ agent: "scout", task: "t", messages: [assistant("o")] }] }),
		);
		expect(entries[0]?.runId).toBe("");
	});
});

describe("registryAgentLogEntries", () => {
	test("maps live, completed, and failed runs", () => {
		const active = runtime({ runId: "sa-active" });
		const completed = runtime({ runId: "sa-done", completedAt: Date.now() });
		const failed = runtime({
			runId: "sa-failed",
			completedAt: Date.now(),
			result: {
				agent: "scout",
				agentSource: "user",
				task: "find auth code",
				exitCode: 1,
				messages: [],
				stderr: "failed hard",
				usage,
			},
		});
		const entries = registryAgentLogEntries([active, completed, failed]);
		expect(entries.map((entry) => entry.status)).toEqual(["running", "completed", "failed"]);
		expect(entries[0]?.output).toBe("scout output");
		expect(entries[2]?.output).toBe("failed hard");
	});

	test("streams live text, then the running placeholder", () => {
		const live = runtime({ runId: "sa-live" });
		live.result.messages = [];
		live.result.liveText = "partial";
		const empty = runtime({ runId: "sa-empty" });
		empty.result.messages = [];
		const entries = registryAgentLogEntries([live, empty]);
		expect(entries[0]?.output).toBe("partial");
		expect(entries[1]?.output).toBe("(running...)");
	});
});

describe("mergeAgentLogEntries", () => {
	test("dedupes by runId, keeps registry entries, and adds persisted-only runs", () => {
		const registryEntry: AgentLogEntry = {
			runId: "sa-1",
			agentName: "scout",
			task: "live",
			output: "live output",
			status: "completed",
			source: "registry",
		};
		const persisted = persistedAgentLogEntries(
			branchWithDetails({
				mode: "single",
				results: [
					{ runId: "sa-1", agent: "scout", task: "live", messages: [assistant("old output")], exitCode: 0, usage },
					{ runId: "sa-2", agent: "worker", task: "persisted", messages: [assistant("kept")], exitCode: 0, usage },
				],
			}),
		);
		const merged = mergeAgentLogEntries([registryEntry], persisted);
		expect(merged).toHaveLength(2);
		expect(merged.find((entry) => entry.runId === "sa-1")?.output).toBe("live output");
		expect(merged.find((entry) => entry.runId === "sa-2")?.output).toBe("kept");
	});

	test("preserves richer persisted mode/step metadata on a runId collision", () => {
		const registryEntry: AgentLogEntry = {
			runId: "sa-1",
			agentName: "worker",
			task: "step two",
			output: "live output",
			status: "completed",
			source: "registry",
		};
		const persisted = persistedAgentLogEntries(
			branchWithDetails({
				mode: "chain",
				results: [
					{ runId: "sa-1", agent: "worker", task: "step two", messages: [assistant("old")], exitCode: 0, step: 2, usage },
				],
			}),
		);
		const [merged] = mergeAgentLogEntries([registryEntry], persisted);
		expect(merged).toMatchObject({ output: "live output", source: "registry", mode: "chain", step: 2 });
	});

	test("does not drop a persisted run when a restarted generator uses new IDs", () => {
		const persisted = persistedAgentLogEntries(
			branchWithDetails({
				mode: "single",
				results: [{ runId: "sa-1", agent: "scout", task: "old run", messages: [assistant("old")], exitCode: 0, usage }],
			}),
		);
		const nextRunId = createRunIdGenerator();
		const registryEntry: AgentLogEntry = {
			runId: nextRunId(),
			agentName: "scout",
			task: "new run",
			output: "new",
			status: "completed",
			source: "registry",
		};
		const merged = mergeAgentLogEntries([registryEntry], persisted);
		expect(merged).toHaveLength(2);
		expect(merged.some((entry) => entry.runId === "sa-1")).toBe(true);
		expect(merged.some((entry) => entry.runId === registryEntry.runId)).toBe(true);
	});

	test("drops persisted runs without runId that duplicate a registry run", () => {
		const registryEntry: AgentLogEntry = {
			runId: "sa-1",
			agentName: "scout",
			task: "same",
			output: "same output",
			status: "completed",
			source: "registry",
		};
		const persisted = persistedAgentLogEntries(
			branchWithDetails({
				mode: "single",
				results: [{ agent: "scout", task: "same", messages: [assistant("same output")], exitCode: 0, usage }],
			}),
		);
		expect(mergeAgentLogEntries([registryEntry], persisted)).toHaveLength(1);
	});

	test("lists active runs first, then newest activity", () => {
		const entries = mergeAgentLogEntries(
			[
				{ runId: "old", agentName: "a", task: "t", output: "o", status: "completed", source: "registry", startedAt: 1 },
				{ runId: "new", agentName: "b", task: "t", output: "o", status: "completed", source: "registry", startedAt: 10 },
				{ runId: "active", agentName: "c", task: "t", output: "o", status: "running", source: "registry", startedAt: 5 },
			],
			[],
		);
		expect(entries.map((entry) => entry.runId)).toEqual(["active", "new", "old"]);
	});

	test("sorts persisted runs newest first using their timestamps", () => {
		const persisted = persistedAgentLogEntries([
			{
				type: "message",
				timestamp: "2024-01-01T00:00:00.000Z",
				message: {
					role: "toolResult",
					toolName: "subagent",
					timestamp: 1_700_000_000_000,
					details: { mode: "single", results: [{ runId: "older", agent: "a", task: "t", messages: [], exitCode: 0 }] },
				},
			},
			{
				type: "message",
				timestamp: "2024-01-02T00:00:00.000Z",
				message: {
					role: "toolResult",
					toolName: "subagent",
					timestamp: 1_700_086_400_000,
					details: { mode: "single", results: [{ runId: "newer", agent: "b", task: "t", messages: [], exitCode: 0 }] },
				},
			},
		]);
		expect(mergeAgentLogEntries([], persisted).map((entry) => entry.runId)).toEqual(["newer", "older"]);
	});
});

describe("buildAgentLogPicker", () => {
	test("maps duplicate-looking labels to distinct entries", () => {
		const shared = { agentName: "scout", task: "t", output: "o", status: "completed" as const, source: "persisted" as const };
		const entries: AgentLogEntry[] = [
			{ ...shared, runId: "" },
			{ ...shared, runId: "" },
		];
		const { labels, byLabel } = buildAgentLogPicker(entries);
		expect(new Set(labels).size).toBe(2);
		expect(byLabel.get(labels[0])).toBe(entries[0]);
		expect(byLabel.get(labels[1])).toBe(entries[1]);
	});
});

describe("formatAgentLogEntry", () => {
	test("shows the exact task and final output", () => {
		const text = formatAgentLogEntry({
			runId: "sa-9",
			agentName: "reviewer",
			task: "review the diff",
			output: "looks good",
			status: "completed",
			source: "registry",
		});
		expect(text).toContain("Agent: reviewer [sa-9]");
		expect(text).toContain("Task:\nreview the diff");
		expect(text).toContain("Output:\nlooks good");
	});

	test("falls back to placeholders for missing task/output", () => {
		const text = formatAgentLogEntry({
			runId: "",
			agentName: "scout",
			task: "",
			output: "",
			status: "running",
			source: "registry",
		});
		expect(text).toContain("Agent: scout");
		expect(text).toContain("Task:\n(none)");
		expect(text).toContain("Output:\n(no output)");
	});
});

describe("formatAgentLog", () => {
	test("joins every run with a separator", () => {
		const text = formatAgentLog([
			{ runId: "sa-1", agentName: "scout", task: "one", output: "a", status: "completed", source: "registry" },
			{ runId: "sa-2", agentName: "worker", task: "two", output: "b", status: "failed", source: "persisted" },
		]);
		expect(text).toContain("Agent: scout [sa-1]");
		expect(text).toContain("Agent: worker [sa-2]");
		expect(text).toContain("────────────");
	});
});

function completionBranch(details: unknown, timestamp = "2024-02-01T00:00:00.000Z"): unknown[] {
	return [
		{
			type: "custom_message",
			customType: "subagent-completion",
			content: "completion text",
			display: true,
			details,
			timestamp,
		},
	];
}

describe("persisted async completion messages", () => {
	test("loads completed async runs after resume", () => {
		const entries = persistedAgentLogEntries(
			completionBranch({
				mode: "parallel",
				execution: "async",
				dispatchId: "dispatch-7",
				dispatchStatus: "completed",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					{ runId: "sa-1", agent: "scout", task: "find code", messages: [assistant("found")], exitCode: 0, usage },
					{ runId: "sa-2", agent: "worker", task: "fix", exitCode: 1, stderr: "boom", usage },
				],
			}),
		);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			runId: "sa-1",
			agentName: "scout",
			task: "find code",
			output: "found",
			status: "completed",
			mode: "parallel",
			source: "persisted",
			dispatchId: "dispatch-7",
			execution: "async",
		});
		expect(entries[0]?.completedAt).toBe(Date.parse("2024-02-01T00:00:00.000Z"));
		expect(entries[1]).toMatchObject({ runId: "sa-2", output: "boom", status: "failed" });
	});

	test("ignores started completion messages and unrelated custom types", () => {
		const started = completionBranch({
			mode: "single",
			execution: "async",
			dispatchId: "d-1",
			dispatchStatus: "started",
			results: [{ runId: "sa-1", agent: "a", task: "t", messages: [], exitCode: -1, usage }],
		});
		expect(persistedAgentLogEntries(started)).toEqual([]);
		expect(persistedAgentLogEntries([{ type: "custom_message", customType: "other" }])).toEqual([]);
		expect(persistedAgentLogEntries([{ type: "custom_message", customType: "subagent-completion" }])).toEqual([]);
	});

	test("still ignores async acknowledgement tool results", () => {
		const ack = branchWithDetails({
			mode: "single",
			execution: "async",
			dispatchId: "d-1",
			dispatchStatus: "started",
			results: [],
		});
		expect(persistedAgentLogEntries(ack)).toEqual([]);
	});

	test("fills startedAt from the matching acknowledgement timestamp", () => {
		const startedAt = Date.parse("2024-02-01T00:00:00.000Z");
		const completedAt = Date.parse("2024-02-01T00:00:10.000Z");
		const branch = [
			{
				type: "message",
				timestamp: new Date(startedAt).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: {} }],
					timestamp: startedAt,
				},
			},
			{
				type: "message",
				timestamp: new Date(startedAt + 5).toISOString(),
				message: {
					role: "toolResult",
					toolName: "subagent",
					toolCallId: "call-1",
					timestamp: startedAt + 5,
					details: {
						mode: "single",
						execution: "async",
						dispatchId: "dispatch-7",
						dispatchStatus: "started",
						plannedItems: [{ runId: "sa-1", agent: "scout", task: "find code" }],
						results: [],
					},
				},
			},
			{
				type: "custom_message",
				customType: "subagent-completion",
				content: "completion text",
				display: true,
				timestamp: new Date(completedAt).toISOString(),
				details: {
					mode: "single",
					execution: "async",
					dispatchId: "dispatch-7",
					dispatchStatus: "completed",
					plannedItems: [{ runId: "sa-1", agent: "scout", task: "find code" }],
					results: [{ runId: "sa-1", agent: "scout", task: "find code", messages: [assistant("found")], exitCode: 0, usage }],
				},
			},
		];

		const [entry] = persistedAgentLogEntries(branch);
		expect(entry?.startedAt).toBe(startedAt);
		expect(entry?.completedAt).toBe(completedAt);
		expect(entry?.dispatchId).toBe("dispatch-7");
	});

	test("falls back to the acknowledgement result timestamp without a tool call", () => {
		const startedAt = Date.parse("2024-03-01T00:00:00.000Z");
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					timestamp: startedAt,
					details: {
						mode: "single",
						execution: "async",
						dispatchId: "dispatch-8",
						dispatchStatus: "started",
						results: [],
					},
				},
			},
			{
				type: "custom_message",
				customType: "subagent-completion",
				content: "completion text",
				display: true,
				timestamp: new Date(startedAt + 1000).toISOString(),
				details: {
					mode: "single",
					execution: "async",
					dispatchId: "dispatch-8",
					dispatchStatus: "completed",
					results: [{ runId: "sa-8", agent: "worker", task: "done", messages: [assistant("ok")], exitCode: 0, usage }],
				},
			},
		];

		const [entry] = persistedAgentLogEntries(branch);
		expect(entry?.startedAt).toBe(startedAt);
	});

	test("a real stopped-chain completion only logs steps that ran", () => {
		const startedAt = Date.parse("2024-04-01T00:00:00.000Z");
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					timestamp: startedAt,
					details: {
						mode: "chain",
						execution: "async",
						dispatchId: "chain-1",
						dispatchStatus: "started",
						plannedItems: [
							{ runId: "sa-1", agent: "a", task: "one", step: 1 },
							{ runId: "sa-2", agent: "b", task: "two", step: 2 },
							{ runId: "sa-3", agent: "c", task: "three", step: 3 },
						],
						results: [],
					},
				},
			},
			{
				type: "custom_message",
				customType: "subagent-completion",
				content: "completion text",
				display: true,
				timestamp: new Date(startedAt + 2000).toISOString(),
				details: {
					mode: "chain",
					execution: "async",
					dispatchId: "chain-1",
					dispatchStatus: "failed",
					plannedItems: [
						{ runId: "sa-1", agent: "a", task: "one", step: 1 },
						{ runId: "sa-2", agent: "b", task: "two", step: 2 },
						{ runId: "sa-3", agent: "c", task: "three", step: 3 },
					],
					results: [
						{ runId: "sa-1", agent: "a", task: "one", step: 1, messages: [assistant("a-out")], exitCode: 0, usage },
						{ runId: "sa-2", agent: "b", task: "two", step: 2, exitCode: 1, stderr: "stopped", usage },
					],
				},
			},
		];

		const entries = persistedAgentLogEntries(branch);
		expect(entries.map((entry) => entry.runId)).toEqual(["sa-1", "sa-2"]);
		expect(entries.every((entry) => entry.startedAt === startedAt)).toBe(true);
		expect(entries.some((entry) => entry.runId === "sa-3")).toBe(false);
	});
});

describe("live and persisted async deduplication", () => {
	test("live state wins while persisted completion metadata fills gaps", () => {
		const registryEntry = registryAgentLogEntries([runtime({ runId: "sa-1", completedAt: Date.now() })]);
		const persisted = persistedAgentLogEntries(
			completionBranch({
				mode: "parallel",
				execution: "async",
				dispatchId: "dispatch-7",
				dispatchStatus: "completed",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					{
						runId: "sa-1",
						agent: "scout",
						task: "find auth code",
						messages: [assistant("stale output")],
						exitCode: 0,
						step: 2,
						usage,
					},
				],
			}),
		);
		const merged = mergeAgentLogEntries(registryEntry, persisted);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({
			output: "scout output",
			source: "registry",
			mode: "parallel",
			step: 2,
			dispatchId: "dispatch-7",
			execution: "async",
		});
	});

	test("keeps a persisted-only async run after registry pruning", () => {
		const persisted = persistedAgentLogEntries(
			completionBranch({
				mode: "single",
				execution: "async",
				dispatchId: "dispatch-9",
				dispatchStatus: "completed",
				results: [{ runId: "sa-9", agent: "worker", task: "done", messages: [assistant("ok")], exitCode: 0, usage }],
			}),
		);
		const merged = mergeAgentLogEntries([], persisted);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ runId: "sa-9", output: "ok", dispatchId: "dispatch-9", execution: "async" });
	});

	test("dedupes a stopped-chain completion without logging not-run steps", () => {
		const registryEntry = registryAgentLogEntries([runtime({ runId: "sa-1", completedAt: Date.now() })]);
		const persisted = persistedAgentLogEntries(
			completionBranch({
				mode: "chain",
				execution: "async",
				dispatchId: "chain-1",
				dispatchStatus: "failed",
				plannedItems: [
					{ runId: "sa-1", agent: "scout", task: "find auth code", step: 1 },
					{ runId: "sa-2", agent: "worker", task: "apply fix", step: 2 },
					{ runId: "sa-3", agent: "reviewer", task: "review", step: 3 },
				],
				results: [
					{ runId: "sa-1", agent: "scout", task: "find auth code", step: 1, messages: [assistant("stale")], exitCode: 0, usage },
					{ runId: "sa-2", agent: "worker", task: "apply fix", step: 2, exitCode: 1, stderr: "boom", usage },
				],
			}),
		);
		const merged = mergeAgentLogEntries(registryEntry, persisted);
		expect(merged.map((entry) => entry.runId)).toEqual(["sa-1", "sa-2"]);
		expect(merged.find((entry) => entry.runId === "sa-1")).toMatchObject({
			output: "scout output",
			source: "registry",
			mode: "chain",
			step: 1,
			dispatchId: "chain-1",
			execution: "async",
		});
	});
});

describe("registry async metadata", () => {
	test("registryAgentLogEntries carries dispatch id and execution mode", () => {
		const [entry] = registryAgentLogEntries([runtime({ dispatchId: "dispatch-7", execution: "async" })]);
		expect(entry).toMatchObject({ dispatchId: "dispatch-7", execution: "async" });
	});

	test("formatAgentLogEntry shows dispatch and execution metadata", () => {
		const text = formatAgentLogEntry({
			runId: "sa-1",
			agentName: "worker",
			task: "t",
			output: "o",
			status: "completed",
			source: "persisted",
			mode: "chain",
			step: 2,
			execution: "async",
			dispatchId: "dispatch-7",
		});
		expect(text).toContain("Mode: chain (step 2) [async]");
		expect(text).toContain("Dispatch: dispatch-7");
	});
});
