/**
 * Stage 6 cross-module acceptance tests.
 *
 * These wire the real preparation path, dispatch runner, detached lifecycle
 * manager, and persisted agent-log extraction together without the Pi runtime
 * or a TUI. They cover the automated part of the Stage 6 acceptance matrix:
 *
 *   - omitted `execution` is async end to end, and the acknowledgement is
 *     non-terminal while the run is in flight;
 *   - exactly one terminal completion is delivered and persists as a log entry
 *     that survives a simulated `/resume`;
 *   - the acknowledgement tool result is never mistaken for completed history;
 *   - explicit blocking returns the final result in-line and is also loggable;
 *   - shutdown suppresses a completion and it cannot leak into a replacement
 *     session.
 */

import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "./agents.ts";
import { persistedAgentLogEntries } from "./agent-log.ts";
import { buildAsyncStartResult, SUBAGENT_COMPLETION_CUSTOM_TYPE } from "./completion.ts";
import { runPreparedDispatch } from "./dispatch.ts";
import {
	AsyncDispatchManager,
	type CompletionDeliveryOptions,
	type SubagentCompletionMessage,
} from "./lifecycle.ts";
import { prepareSubagentDispatch, type PreparationDependencies } from "./prepare.ts";
import type { SingleResult } from "./types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function agent(name: string): AgentConfig {
	return {
		name,
		description: `${name} description`,
		systemPrompt: "",
		source: "user",
		filePath: `/agents/${name}.md`,
	};
}

function singleResult(runId: string, output: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		agentSource: "user",
		task: "edit the file",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: output }], usage, stopReason: "end" }],
		stderr: "",
		usage,
		runId,
		...overrides,
	};
}

function createPreparation(): PreparationDependencies {
	let runSeq = 0;
	let dispatchSeq = 0;
	return {
		discoverAgents: () => ({ agents: [agent("worker")], projectAgentsDir: null }),
		requestPermission: async () => undefined,
		snapshotSafeMode: async () => ({ mode: "smart", outerAccess: false }),
		nextDispatchId: () => `dispatch-${(dispatchSeq += 1)}`,
		nextRunId: () => `sa-${(runSeq += 1)}`,
		context: { cwd: "/work/repo", model: "anthropic/claude", thinkingLevel: "high" },
	};
}

interface Delivered {
	message: SubagentCompletionMessage;
	options: CompletionDeliveryOptions;
}

function createManager() {
	const delivered: Delivered[] = [];
	const manager = new AsyncDispatchManager({
		deliver: (message, options) => delivered.push({ message, options }),
	});
	return { manager, delivered };
}

/** Persisted branch fragment: assistant tool call -> ack tool result -> completion. */
function resumableBranch(ackDetails: unknown, completionDetails: unknown, completedAt: number): unknown[] {
	return [
		{
			type: "message",
			message: {
				role: "assistant",
				timestamp: completedAt - 5000,
				content: [{ type: "toolCall", id: "call-1" }],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "subagent",
				toolCallId: "call-1",
				timestamp: completedAt - 4900,
				details: ackDetails,
			},
		},
		{
			type: "custom_message",
			customType: SUBAGENT_COMPLETION_CUSTOM_TYPE,
			display: true,
			timestamp: completedAt,
			content: "aggregate",
			details: completionDetails,
		},
	];
}

describe("async default acceptance flow", () => {
	test("acknowledges, completes once, and persists a resumable log entry", async () => {
		const preparation = await prepareSubagentDispatch({ agent: "worker", task: "edit the file" }, createPreparation());
		expect(preparation.ok).toBe(true);
		if (!preparation.ok) return;
		const dispatch = preparation.dispatch;

		// Omitted execution resolves to async and the ack is non-terminal.
		expect(dispatch.execution).toBe("async");
		const ack = buildAsyncStartResult(dispatch);
		expect(ack.details?.dispatchStatus).toBe("started");
		expect(ack.details?.execution).toBe("async");
		expect(ack.details?.dispatchId).toBe(dispatch.dispatchId);
		expect(ack.details?.results).toEqual([]);
		const ackText = ack.content[0]?.type === "text" ? ack.content[0].text : "";
		expect(ackText).toContain("started in the background");
		expect(ackText).toContain("sa-1");

		const { manager, delivered } = createManager();
		const handle = manager.start(dispatch, (signal) =>
			runPreparedDispatch(
				dispatch,
				{ runSingle: async (request) => singleResult(request.runId, "edited the file") },
				signal,
				undefined,
			),
		);
		// Ownership exists before the acknowledgement is returned to the caller.
		expect(handle).toBeDefined();
		expect(manager.size).toBe(1);
		expect(delivered).toHaveLength(0);

		await handle?.promise;
		expect(manager.size).toBe(0);
		expect(delivered).toHaveLength(1);
		const completion = delivered[0];
		expect(completion?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(completion?.message.details).toMatchObject({
			mode: "single",
			execution: "async",
			dispatchId: dispatch.dispatchId,
			dispatchStatus: "completed",
		});

		// Simulate `/resume`: only the terminal completion is listed, with both
		// the acknowledgement and the completion in the branch.
		const entries = persistedAgentLogEntries(
			resumableBranch(ack.details, completion?.message.details, Date.now()),
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			runId: "sa-1",
			agentName: "worker",
			output: "edited the file",
			status: "completed",
			source: "persisted",
			mode: "single",
			execution: "async",
			dispatchId: dispatch.dispatchId,
		});
		expect(entries[0]?.startedAt).toBeDefined();
	});

	test("explicit blocking returns the final result in-line and is loggable", async () => {
		const preparation = await prepareSubagentDispatch(
			{ agent: "worker", task: "edit the file", execution: "blocking" },
			createPreparation(),
		);
		expect(preparation.ok).toBe(true);
		if (!preparation.ok) return;
		const dispatch = preparation.dispatch;
		expect(dispatch.execution).toBe("blocking");

		const result = await runPreparedDispatch(
			dispatch,
			{ runSingle: async (request) => singleResult(request.runId, "blocking output") },
			undefined,
			undefined,
		);
		expect(result.isError).toBeUndefined();
		expect(result.details).toMatchObject({
			mode: "single",
			execution: "blocking",
			dispatchId: dispatch.dispatchId,
			dispatchStatus: "completed",
		});
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("blocking output");

		const entries = persistedAgentLogEntries([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					toolCallId: "call-blocking",
					timestamp: Date.now(),
					details: result.details,
				},
			},
		]);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ runId: "sa-1", status: "completed", execution: "blocking" });
	});
});

describe("shutdown isolation acceptance flow", () => {
	test("suppresses the in-flight completion and never leaks it into the replacement session", async () => {
		const preparation = await prepareSubagentDispatch({ agent: "worker", task: "edit the file" }, createPreparation());
		expect(preparation.ok).toBe(true);
		if (!preparation.ok) return;
		const dispatch = preparation.dispatch;

		const { manager, delivered } = createManager();
		let resolveRun!: () => void;
		const pending = new Promise<void>((resolve) => {
			resolveRun = resolve;
		});
		const handle = manager.start(dispatch, async (signal) => {
			await pending;
			return runPreparedDispatch(
				dispatch,
				{ runSingle: async (request) => singleResult(request.runId, "late output") },
				signal,
				undefined,
			);
		});

		const shutdown = manager.shutdown();
		manager.reset();
		// The old run settles only after the replacement session has started.
		resolveRun();
		await shutdown;
		await handle?.promise;
		expect(delivered).toHaveLength(0);

		// A new dispatch in the replacement session delivers normally.
		const fresh = await prepareSubagentDispatch({ agent: "worker", task: "new work" }, createPreparation());
		expect(fresh.ok).toBe(true);
		if (!fresh.ok) return;
		const freshHandle = manager.start(fresh.dispatch, (signal) =>
			runPreparedDispatch(
				fresh.dispatch,
				{ runSingle: async (request) => singleResult(request.runId, "fresh output") },
				signal,
				undefined,
			),
		);
		await freshHandle?.promise;
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.content).toContain("fresh output");
		expect(delivered[0]?.message.content).not.toContain("late output");
	});
});
