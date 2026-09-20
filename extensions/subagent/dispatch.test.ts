/**
 * Characterization tests for the prepared dispatch runner.
 *
 * These pin the single/parallel/chain blocking contract of
 * `runPreparedDispatch()`. They use an injected fake single-run function so no
 * real Pi child process is spawned. `index.ts` wires the same seam to
 * `runSingleAgent()`.
 */

import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	MAX_CONCURRENCY,
	PER_TASK_OUTPUT_CAP,
	runPreparedDispatch,
	SubagentAbortError,
	type DispatchRuntimeDependencies,
	type SingleRunRequest,
} from "./dispatch.ts";
import { isAbortedResult, isFailedResult } from "./result-output.ts";
import type {
	PreparedSubagentDispatch,
	SingleResult,
	SubagentDetails,
	SubagentMode,
} from "./types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function assistant(text: string) {
	return { role: "assistant", content: [{ type: "text", text }], usage, stopReason: "end" };
}

function singleResult(agent: string, output: string | undefined, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent,
		agentSource: "user",
		task: "",
		exitCode: 0,
		messages: output === undefined ? [] : [assistant(output)],
		stderr: "",
		usage,
		...overrides,
	};
}

interface PreparedItemInput {
	agent: string;
	task: string;
	cwd?: string;
	runId?: string;
	step?: number;
}

/**
 * Build a prepared dispatch the way `prepareSubagentDispatch()` does: run IDs
 * allocated in input order and chain steps numbered. Tests can still pass their
 * own IDs to assert forwarding.
 */
function preparedDispatch(
	mode: SubagentMode,
	items: PreparedItemInput[],
	overrides: Partial<PreparedSubagentDispatch> = {},
): PreparedSubagentDispatch {
	return {
		dispatchId: "dispatch-test",
		execution: "blocking",
		mode,
		agentScope: "user",
		projectAgentsDir: null,
		agents: [],
		dispatchDefaults: {},
		cwd: "/tmp/parent",
		items: items.map((item, index) => ({
			runId: item.runId ?? `sa-${index + 1}`,
			agent: item.agent,
			task: item.task,
			...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
			...(item.step !== undefined ? { step: item.step } : mode === "chain" ? { step: index + 1 } : {}),
		})),
		...overrides,
	};
}

/** Runner that records every call and resolves through the supplied handler. */
function createRunner(
	handler: (request: SingleRunRequest, index: number) => SingleResult | Promise<SingleResult>,
): { runner: DispatchRuntimeDependencies; calls: SingleRunRequest[] } {
	const calls: SingleRunRequest[] = [];
	const runner: DispatchRuntimeDependencies = {
		runSingle: async (request) => {
			calls.push(request);
			return handler(request, calls.length - 1);
		},
	};
	return { runner, calls };
}

/** Runner whose single runs stay pending until the test resolves them. */
function deferredRunner(): {
	runner: DispatchRuntimeDependencies;
	calls: SingleRunRequest[];
	pending: Array<{ request: SingleRunRequest; resolve: (result: SingleResult) => void }>;
} {
	const calls: SingleRunRequest[] = [];
	const pending: Array<{ request: SingleRunRequest; resolve: (result: SingleResult) => void }> = [];
	const runner: DispatchRuntimeDependencies = {
		runSingle: (request) =>
			new Promise<SingleResult>((resolve) => {
				calls.push(request);
				pending.push({ request, resolve });
			}),
	};
	return { runner, calls, pending };
}

function textOf(result: AgentToolResult<SubagentDetails>): string {
	const part = result.content[0];
	return part && part.type === "text" ? part.text : "";
}

describe("single dispatch", () => {
	test("returns the final assistant output and success details", async () => {
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "worker output"));
		const result = await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "worker", task: "do it", cwd: "/tmp/work" }]),
			runner,
			undefined,
			undefined,
		);

		expect(textOf(result)).toBe("worker output");
		expect(result.isError).toBeUndefined();
		expect(result.details?.mode).toBe("single");
		expect(result.details?.dispatchStatus).toBe("completed");
		expect(result.details?.results.map((r) => r.agent)).toEqual(["worker"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.task).toBe("do it");
		expect(calls[0]?.cwd).toBe("/tmp/work");
		expect(calls[0]?.step).toBeUndefined();
	});

	test("stamps prepared dispatch metadata on aggregate details", async () => {
		const { runner } = createRunner((request) => singleResult(request.agent, "ok"));
		const dispatch = preparedDispatch("single", [{ agent: "worker", task: "t" }], {
			dispatchId: "dispatch-42",
			execution: "blocking",
			agentScope: "both",
			projectAgentsDir: "/repo/.pi/agents",
		});

		const result = await runPreparedDispatch(dispatch, runner, undefined, undefined);

		expect(result.details).toMatchObject({
			dispatchId: "dispatch-42",
			execution: "blocking",
			agentScope: "both",
			projectAgentsDir: "/repo/.pi/agents",
			mode: "single",
			dispatchStatus: "completed",
		});
	});

	test("falls back to (no output) when the child produced no text", async () => {
		const { runner } = createRunner(() => singleResult("worker", undefined));
		const result = await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "worker", task: "t" }]),
			runner,
			undefined,
			undefined,
		);
		expect(textOf(result)).toBe("(no output)");
		expect(result.isError).toBeUndefined();
	});

	test("failure text uses stopReason, then literal failed, and sets isError", async () => {
		const withReason = createRunner(() =>
			singleResult("worker", undefined, { exitCode: 1, stopReason: "error", errorMessage: "boom" }),
		);
		const reasonResult = await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "worker", task: "t" }]),
			withReason.runner,
			undefined,
			undefined,
		);
		expect(textOf(reasonResult)).toBe("Agent error: boom");
		expect(reasonResult.isError).toBe(true);
		expect(reasonResult.details?.dispatchStatus).toBe("failed");
		expect(isFailedResult(reasonResult.details?.results[0] ?? {})).toBe(true);

		const noReason = createRunner(() => singleResult("worker", undefined, { exitCode: 1, stderr: "trace" }));
		const noReasonResult = await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "worker", task: "t" }]),
			noReason.runner,
			undefined,
			undefined,
		);
		expect(textOf(noReasonResult)).toBe("Agent failed: trace");
		expect(noReasonResult.isError).toBe(true);
		expect(noReasonResult.details?.dispatchStatus).toBe("failed");
	});

	test("aborted single run reports aborted, not failed, in details", async () => {
		const { runner } = createRunner(() =>
			singleResult("worker", undefined, { exitCode: 0, stopReason: "aborted", errorMessage: "stopped" }),
		);
		const result = await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "worker", task: "t" }]),
			runner,
			undefined,
			undefined,
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("Agent aborted: stopped");
		expect(result.details?.dispatchStatus).toBe("aborted");
	});
});

describe("signal and update forwarding", () => {
	test("forwards the abort signal to a single run", async () => {
		const controller = new AbortController();
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));

		await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "worker", task: "t" }]),
			runner,
			controller.signal,
			undefined,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.signal).toBe(controller.signal);
	});

	test("forwards onUpdate to the single run", async () => {
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));
		const updates: Array<AgentToolResult<SubagentDetails>> = [];
		const onUpdate = (update: AgentToolResult<SubagentDetails>) => updates.push(update);

		await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "worker", task: "t" }]),
			runner,
			undefined,
			onUpdate,
		);

		expect(calls[0]?.onUpdate).toBe(onUpdate);
		const partial: AgentToolResult<SubagentDetails> = {
			content: [{ type: "text", text: "partial" }],
			details: calls[0].makeDetails([], "started"),
		};
		calls[0]?.onUpdate?.(partial);
		expect(updates).toEqual([partial]);
	});

	test("forwards the abort signal to every parallel run", async () => {
		const controller = new AbortController();
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));

		await runPreparedDispatch(
			preparedDispatch("parallel", [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
				{ agent: "c", task: "3" },
			]),
			runner,
			controller.signal,
			undefined,
		);

		expect(calls).toHaveLength(3);
		expect(calls.map((call) => call.signal)).toEqual([controller.signal, controller.signal, controller.signal]);
	});

	test("forwards the abort signal to every chain step", async () => {
		const controller = new AbortController();
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));

		await runPreparedDispatch(
			preparedDispatch("chain", [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
			]),
			runner,
			controller.signal,
			undefined,
		);

		expect(calls).toHaveLength(2);
		expect(calls.map((call) => call.signal)).toEqual([controller.signal, controller.signal]);
	});

	test("an already-aborted signal prevents every queued parallel run from starting", async () => {
		const controller = new AbortController();
		controller.abort();
		const { runner, calls } = createRunner(() => {
			throw new Error("an aborted run must never start");
		});

		const result = await runPreparedDispatch(
			preparedDispatch("parallel", [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
				{ agent: "c", task: "3" },
				{ agent: "d", task: "4" },
				{ agent: "e", task: "5" },
			]),
			runner,
			controller.signal,
			undefined,
		);

		expect(calls).toHaveLength(0);
		expect(result.details?.dispatchStatus).toBe("aborted");
		expect(result.details?.results).toHaveLength(5);
		expect(result.details?.results.every((item) => isAbortedResult(item))).toBe(true);
	});

	test("an already-aborted signal prevents later chain steps from starting", async () => {
		const controller = new AbortController();
		controller.abort();
		const { runner, calls } = createRunner(() => {
			throw new Error("an aborted run must never start");
		});

		const result = await runPreparedDispatch(
			preparedDispatch("chain", [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
			]),
			runner,
			controller.signal,
			undefined,
		);

		expect(calls).toHaveLength(0);
		expect(result.details?.dispatchStatus).toBe("aborted");
	});
});

describe("pre-allocated run IDs", () => {
	test("forwards the prepared run ID to a single run", async () => {
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));
		await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "worker", task: "t", runId: "sa-single" }]),
			runner,
			undefined,
			undefined,
		);
		expect(calls[0]?.runId).toBe("sa-single");
	});

	test("forwards one prepared run ID per parallel task in input order", async () => {
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));
		await runPreparedDispatch(
			preparedDispatch("parallel", [
				{ agent: "a", task: "1", runId: "sa-a" },
				{ agent: "b", task: "2", runId: "sa-b" },
			]),
			runner,
			undefined,
			undefined,
		);
		expect(calls.map((call) => call.runId)).toEqual(["sa-a", "sa-b"]);
	});

	test("forwards one prepared run ID per chain step in order", async () => {
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));
		await runPreparedDispatch(
			preparedDispatch("chain", [
				{ agent: "a", task: "1", runId: "sa-1" },
				{ agent: "b", task: "2", runId: "sa-2" },
			]),
			runner,
			undefined,
			undefined,
		);
		expect(calls.map((call) => call.runId)).toEqual(["sa-1", "sa-2"]);
	});
});

describe("malformed prepared dispatch", () => {
	test("throws a descriptive invariant error for empty items instead of crashing", async () => {
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));

		await expect(
			runPreparedDispatch(
				preparedDispatch("single", [], { dispatchId: "dispatch-empty" }),
				runner,
				undefined,
				undefined,
			),
		).rejects.toThrow(/Malformed prepared dispatch dispatch-empty \(mode "single"\): expected at least one item/);
		expect(calls).toHaveLength(0);
	});
});

describe("chain dispatch", () => {
	test("interpolates {previous} from the prior step and preserves step numbers", async () => {
		const { runner, calls } = createRunner((request) => {
			if (request.agent === "a") return singleResult("a", "A-out");
			return singleResult("b", `seen:${request.task}`);
		});
		const result = await runPreparedDispatch(
			preparedDispatch("chain", [
				{ agent: "a", task: "first" },
				{ agent: "b", task: "use {previous} twice {previous}" },
			]),
			runner,
			undefined,
			undefined,
		);

		expect(calls.map((c) => c.task)).toEqual(["first", "use A-out twice A-out"]);
		expect(calls.map((c) => c.step)).toEqual([1, 2]);
		expect(textOf(result)).toBe("seen:use A-out twice A-out");
		expect(result.details?.mode).toBe("chain");
		expect(result.details?.dispatchStatus).toBe("completed");
		expect(result.details?.results.map((r) => r.agent)).toEqual(["a", "b"]);
		expect(result.isError).toBeUndefined();
	});

	test("forwards an explicit non-default chain step instead of the input position", async () => {
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));
		await runPreparedDispatch(
			preparedDispatch("chain", [
				{ agent: "a", task: "1", step: 4 },
				{ agent: "b", task: "2", step: 7 },
			]),
			runner,
			undefined,
			undefined,
		);
		expect(calls.map((call) => call.step)).toEqual([4, 7]);
	});

	test("shares one chain key across steps and omits it for single and parallel", async () => {
		const chain = createRunner((request) => singleResult(request.agent, "ok"));
		await runPreparedDispatch(
			preparedDispatch("chain", [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
			]),
			chain.runner,
			undefined,
			undefined,
		);
		expect(chain.calls.map((call) => call.chainKey)).toEqual(["dispatch-test", "dispatch-test"]);

		const single = createRunner((request) => singleResult(request.agent, "ok"));
		await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "a", task: "1" }]),
			single.runner,
			undefined,
			undefined,
		);
		expect(single.calls.map((call) => call.chainKey)).toEqual([undefined]);

		const parallel = createRunner((request) => singleResult(request.agent, "ok"));
		await runPreparedDispatch(
			preparedDispatch("parallel", [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
			]),
			parallel.runner,
			undefined,
			undefined,
		);
		expect(parallel.calls.map((call) => call.chainKey)).toEqual([undefined, undefined]);
	});

	test("stops at the first failed step and reports it", async () => {
		const { runner, calls } = createRunner((request) => {
			if (request.agent === "b")
				return singleResult("b", undefined, { exitCode: 1, stopReason: "error", errorMessage: "boom" });
			return singleResult(request.agent, `${request.agent}-out`);
		});
		const result = await runPreparedDispatch(
			preparedDispatch("chain", [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
				{ agent: "c", task: "3" },
			]),
			runner,
			undefined,
			undefined,
		);

		expect(textOf(result)).toBe("Chain stopped at step 2 (b): boom");
		expect(result.isError).toBe(true);
		expect(result.details?.dispatchStatus).toBe("failed");
		expect(result.details?.results).toHaveLength(2);
		expect(calls.map((c) => c.agent)).toEqual(["a", "b"]);
	});

	test("streaming updates prepend completed prior results to the current partial", async () => {
		const { runner, pending } = deferredRunner();
		const updates: Array<AgentToolResult<SubagentDetails>> = [];
		const dispatch = runPreparedDispatch(
			preparedDispatch(
				"chain",
				[
					{ agent: "a", task: "1" },
					{ agent: "b", task: "2" },
				],
				{
					dispatchId: "dispatch-chain-stream",
					agentScope: "both",
					projectAgentsDir: "/repo/.pi/agents",
				},
			),
			runner,
			undefined,
			(update) => updates.push(update),
		);

		pending[0]?.resolve(singleResult("a", "a-out"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(pending).toHaveLength(2);

		const partial = singleResult("b", undefined, { exitCode: -1 });
		pending[1]?.request.onUpdate?.({
			content: [{ type: "text", text: "partial-b" }],
			details: pending[1].request.makeDetails([partial], "started"),
		});

		const streamed = updates.at(-1);
		expect(streamed?.details).toMatchObject({
			dispatchId: "dispatch-chain-stream",
			execution: "blocking",
			agentScope: "both",
			projectAgentsDir: "/repo/.pi/agents",
			mode: "chain",
			dispatchStatus: "started",
		});
		expect(streamed?.details?.results.map((r) => r.agent)).toEqual(["a", "b"]);
		expect(textOf(streamed as AgentToolResult<SubagentDetails>)).toBe("partial-b");

		pending[1]?.resolve(singleResult("b", "b-out"));
		const result = await dispatch;
		expect(textOf(result)).toBe("b-out");
	});
});

describe("parallel dispatch", () => {
	test("preserves input order while runs complete out of order and limits concurrency", async () => {
		let active = 0;
		let peak = 0;
		const started: string[] = [];
		const completionOrder: string[] = [];
		const resolvers = new Map<string, (result: SingleResult) => void>();
		const tasks = ["a", "b", "c", "d", "e"].map((agent) => ({ agent, task: `task-${agent}` }));
		const runner: DispatchRuntimeDependencies = {
			runSingle: (request) => {
				active += 1;
				peak = Math.max(peak, active);
				started.push(request.agent);
				return new Promise<SingleResult>((resolve) => {
					resolvers.set(request.agent, (result) => {
						active -= 1;
						completionOrder.push(request.agent);
						resolve(result);
					});
				});
			},
		};

		const dispatch = runPreparedDispatch(preparedDispatch("parallel", tasks), runner, undefined, undefined);

		// Only the first MAX_CONCURRENCY tasks start; the fifth waits for a slot.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(started).toEqual(["a", "b", "c", "d"]);

		// Completing c frees a slot for e, not for b/d/a which are still running.
		resolvers.get("c")?.(singleResult("c", "c-out"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(started).toEqual(["a", "b", "c", "d", "e"]);

		resolvers.get("b")?.(singleResult("b", "b-out"));
		resolvers.get("d")?.(singleResult("d", "d-out"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		resolvers.get("e")?.(singleResult("e", "e-out"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		resolvers.get("a")?.(singleResult("a", "a-out"));

		const result = await dispatch;

		expect(peak).toBe(MAX_CONCURRENCY);
		expect(completionOrder).toEqual(["c", "b", "d", "e", "a"]);
		expect(result.details?.results.map((r) => r.agent)).toEqual(["a", "b", "c", "d", "e"]);
		expect(textOf(result)).toContain("Parallel: 5/5 succeeded");
	});

	test("keeps successful sibling output when only some tasks fail", async () => {
		const { runner } = createRunner((request) => {
			if (request.agent === "b")
				return singleResult("b", undefined, { exitCode: 1, stopReason: "error", errorMessage: "boom" });
			return singleResult(request.agent, `${request.agent}-out`);
		});
		const result = await runPreparedDispatch(
			preparedDispatch("parallel", [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
				{ agent: "c", task: "3" },
			]),
			runner,
			undefined,
			undefined,
		);

		const text = textOf(result);
		expect(text).toBe(
			[
				"Parallel: 2/3 succeeded",
				"",
				"### [a] completed",
				"",
				"a-out",
				"",
				"---",
				"",
				"### [b] failed (error)",
				"",
				"boom",
				"",
				"---",
				"",
				"### [c] completed",
				"",
				"c-out",
			].join("\n"),
		);
		expect(result.isError).toBeUndefined();
		expect(result.details?.results.map((r) => r.agent)).toEqual(["a", "b", "c"]);
		expect(result.details?.dispatchStatus).toBe("completed");
		// The failure stays in details for the UI even though the aggregate is not an error.
		expect(isFailedResult(result.details?.results[1] ?? {})).toBe(true);
	});

	test("marks a fully-failed parallel dispatch as failed", async () => {
		const { runner } = createRunner((request) =>
			singleResult(request.agent, undefined, { exitCode: 1, stopReason: "error", errorMessage: "boom" }),
		);
		const result = await runPreparedDispatch(
			preparedDispatch("parallel", [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
			]),
			runner,
			undefined,
			undefined,
		);
		expect(result.details?.dispatchStatus).toBe("failed");
	});

	test("marks a parallel dispatch with an aborted task as aborted", async () => {
		const { runner } = createRunner((request) => {
			if (request.agent === "b")
				return singleResult("b", undefined, { exitCode: 0, stopReason: "aborted", errorMessage: "stopped" });
			return singleResult(request.agent, `${request.agent}-out`);
		});
		const result = await runPreparedDispatch(
			preparedDispatch("parallel", [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
			]),
			runner,
			undefined,
			undefined,
		);
		expect(result.details?.dispatchStatus).toBe("aborted");
	});

	test("streams running placeholders and running/done counts", async () => {
		const { runner, pending } = deferredRunner();
		const updates: Array<AgentToolResult<SubagentDetails>> = [];
		const dispatch = runPreparedDispatch(
			preparedDispatch(
				"parallel",
				[
					{ agent: "a", task: "1" },
					{ agent: "b", task: "2" },
				],
				{
					dispatchId: "dispatch-parallel-stream",
					agentScope: "both",
					projectAgentsDir: "/repo/.pi/agents",
				},
			),
			runner,
			undefined,
			(update) => updates.push(update),
		);

		pending[0]?.request.onUpdate?.({
			content: [{ type: "text", text: "partial-a" }],
			details: pending[0].request.makeDetails([singleResult("a", "partial-a", { exitCode: -1 })], "started"),
		});
		const running = updates.at(-1);
		expect(textOf(running as AgentToolResult<SubagentDetails>)).toBe("Parallel: 0/2 done, 2 running...");
		expect(running?.details).toMatchObject({
			dispatchId: "dispatch-parallel-stream",
			execution: "blocking",
			agentScope: "both",
			projectAgentsDir: "/repo/.pi/agents",
			mode: "parallel",
			dispatchStatus: "started",
		});
		expect(running?.details?.results.map((r) => r.exitCode)).toEqual([-1, -1]);

		pending[0]?.resolve(singleResult("a", "a-out"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const half = updates.at(-1);
		expect(textOf(half as AgentToolResult<SubagentDetails>)).toBe("Parallel: 1/2 done, 1 running...");

		pending[1]?.resolve(singleResult("b", "b-out"));
		const result = await dispatch;
		expect(result.details?.results.map((r) => r.agent)).toEqual(["a", "b"]);
	});
});

describe("50 KB parallel output cap", () => {
	test("truncates oversized parallel task output and preserves full details", async () => {
		const huge = "a".repeat(PER_TASK_OUTPUT_CAP + 8800);
		const { runner } = createRunner(() => singleResult("a", huge));
		const result = await runPreparedDispatch(
			preparedDispatch("parallel", [{ agent: "a", task: "t" }]),
			runner,
			undefined,
			undefined,
		);

		const text = textOf(result);
		expect(text).toContain(
			"[Output truncated: 8800 bytes omitted. Full output preserved in tool details.]",
		);
		const visible = text.slice(text.indexOf("### [a] completed\n\n") + "### [a] completed\n\n".length);
		const withoutSuffix = visible.split("\n\n[Output truncated:")[0] ?? "";
		expect(Buffer.byteLength(withoutSuffix, "utf8")).toBeLessThanOrEqual(PER_TASK_OUTPUT_CAP);
		// Full output remains in details.
		expect(result.details?.results[0]?.messages[0]).toMatchObject({
			content: [{ type: "text", text: huge }],
		});
	});

	test("does not truncate output exactly at the cap", async () => {
		const atCap = "a".repeat(PER_TASK_OUTPUT_CAP);
		const { runner } = createRunner(() => singleResult("a", atCap));
		const result = await runPreparedDispatch(
			preparedDispatch("parallel", [{ agent: "a", task: "t" }]),
			runner,
			undefined,
			undefined,
		);
		expect(textOf(result)).toContain(atCap);
		expect(textOf(result)).not.toContain("[Output truncated:");
	});

	test("counts bytes, not characters, for multibyte output", async () => {
		const multibyte = "é".repeat(PER_TASK_OUTPUT_CAP);
		const { runner } = createRunner(() => singleResult("a", multibyte));
		const result = await runPreparedDispatch(
			preparedDispatch("parallel", [{ agent: "a", task: "t" }]),
			runner,
			undefined,
			undefined,
		);

		const text = textOf(result);
		expect(text).toContain("[Output truncated: 51200 bytes omitted. Full output preserved in tool details.]");
		const visible = text.slice(text.indexOf("### [a] completed\n\n") + "### [a] completed\n\n".length);
		const withoutSuffix = visible.split("\n\n[Output truncated:")[0] ?? "";
		expect(withoutSuffix).toBe("é".repeat(PER_TASK_OUTPUT_CAP / 2));
		expect(Buffer.byteLength(withoutSuffix, "utf8")).toBe(PER_TASK_OUTPUT_CAP);
	});

	test("does not truncate single or chain output", async () => {
		const huge = "a".repeat(PER_TASK_OUTPUT_CAP + 100);
		const single = createRunner(() => singleResult("a", huge));
		const singleResultOut = await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "a", task: "t" }]),
			single.runner,
			undefined,
			undefined,
		);
		expect(textOf(singleResultOut)).toBe(huge);
		expect(textOf(singleResultOut)).not.toContain("[Output truncated:");

		const chain = createRunner(() => singleResult("a", huge));
		const chainResult = await runPreparedDispatch(
			preparedDispatch("chain", [{ agent: "a", task: "t" }]),
			chain.runner,
			undefined,
			undefined,
		);
		expect(textOf(chainResult)).toBe(huge);
		expect(textOf(chainResult)).not.toContain("[Output truncated:");
	});
});

describe("aborted result detection", () => {
	test("only treats an aborted stopReason as aborted", () => {
		expect(isAbortedResult({ stopReason: "aborted" })).toBe(true);
		expect(isAbortedResult({ stopReason: "error" })).toBe(false);
		expect(isAbortedResult({ stopReason: "end" })).toBe(false);
		expect(isAbortedResult({})).toBe(false);
	});
});

describe("partial results on child rejection", () => {
	test("keeps successful parallel siblings when a child throws", async () => {
		const { runner } = createRunner((request) => {
			if (request.agent === "b") throw new Error("child exploded");
			return singleResult(request.agent, `${request.agent}-out`);
		});
		const result = await runPreparedDispatch(
			preparedDispatch("parallel", [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
				{ agent: "c", task: "3" },
			]),
			runner,
			undefined,
			undefined,
		);

		expect(result.details?.results.map((r) => r.agent)).toEqual(["a", "b", "c"]);
		expect(isFailedResult(result.details?.results[1] ?? {})).toBe(true);
		expect(result.details?.dispatchStatus).toBe("completed");
		const text = textOf(result);
		expect(text).toContain("a-out");
		expect(text).toContain("c-out");
		expect(text).toContain("child exploded");
	});

	test("classifies a rejected child as aborted when the dispatch signal aborts mid-run", async () => {
		const controller = new AbortController();
		const { runner } = createRunner(() => {
			controller.abort();
			throw new Error("aborted by parent");
		});
		const result = await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "a", task: "1" }]),
			runner,
			controller.signal,
			undefined,
		);

		expect(result.details?.dispatchStatus).toBe("aborted");
		expect(textOf(result)).toBe("Agent aborted: aborted by parent");
	});

	test("preserves and reclassifies a mid-flight abort snapshot from SubagentAbortError", async () => {
		const { runner } = createRunner((request) => {
			// Mirrors `runSingleAgent`'s snapshot before it sets stopReason.
			throw new SubagentAbortError(singleResult(request.agent, "half written", { exitCode: -1, state: "aborting" }));
		});
		const result = await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "a", task: "1" }]),
			runner,
			undefined,
			undefined,
		);

		expect(result.details?.dispatchStatus).toBe("aborted");
		expect(result.details?.results[0]?.stopReason).toBe("aborted");
		expect(result.details?.results[0]?.messages).toEqual([assistant("half written")]);
	});

	test("uses a fallback abort diagnostic when the snapshot has no output", async () => {
		const { runner } = createRunner((request) => {
			throw new SubagentAbortError(singleResult(request.agent, undefined, { exitCode: -1, state: "aborting" }));
		});
		const result = await runPreparedDispatch(
			preparedDispatch("single", [{ agent: "a", task: "1" }]),
			runner,
			undefined,
			undefined,
		);

		expect(result.details?.dispatchStatus).toBe("aborted");
		expect(textOf(result)).toBe("Agent aborted: Subagent was aborted");
	});

	test("stamps cwd on synthesized failure results", async () => {
		const { runner } = createRunner(() => {
			throw new Error("boom");
		});
		const dispatch = preparedDispatch(
			"parallel",
			[
				{ agent: "a", task: "1", cwd: "/work/a" },
				{ agent: "b", task: "2" },
			],
			{ cwd: "/parent" },
		);
		const result = await runPreparedDispatch(dispatch, runner, undefined, undefined);

		expect(result.details?.results[0]?.cwd).toBe("/work/a");
		expect(result.details?.results[1]?.cwd).toBe("/parent");
	});
});

describe("backend metadata propagation", () => {
	test("carries backend and retention through synthetic failures and details", async () => {
		const dispatch = preparedDispatch("single", [{ agent: "worker", task: "t" }], {
			backend: "herdr",
			herdrRetention: "always",
		});
		const deps: DispatchRuntimeDependencies = {
			runSingle: async () => {
				throw new Error("boom");
			},
		};
		const result = await runPreparedDispatch(dispatch, deps, undefined, undefined);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ backend: "herdr", herdrRetention: "always" });
		expect(result.details?.results[0]).toMatchObject({ backend: "herdr", state: "failed" });
	});

	test("omits backend metadata for the default process dispatch", async () => {
		const dispatch = preparedDispatch("single", [{ agent: "worker", task: "t" }]);
		const deps: DispatchRuntimeDependencies = {
			runSingle: async (request) => singleResult(request.agent, "ok", { runId: request.runId }),
		};
		const result = await runPreparedDispatch(dispatch, deps, undefined, undefined);
		expect(result.details?.backend).toBeUndefined();
		expect(result.details?.herdrRetention).toBeUndefined();
		expect(result.details?.results[0]?.backend).toBeUndefined();
	});
});
