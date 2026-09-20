/**
 * Stage 0 characterization tests for the blocking dispatch contract.
 *
 * These tests pin the current single/parallel/chain behavior of the
 * orchestration seam in `dispatch.ts`. They use an injected fake single-run
 * function so no real Pi child process is spawned. `index.ts` wires the same
 * seam to `runSingleAgent()`.
 */

import { describe, expect, test } from "bun:test";
import {
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	PER_TASK_OUTPUT_CAP,
	runDispatch,
	type DispatchRunner,
	type SingleRunRequest,
} from "./dispatch.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { isFailedResult } from "./result-output.ts";
import type { SingleResult, SubagentDetails } from "./types.ts";

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

function makeDetails(mode: "single" | "parallel" | "chain") {
	return (results: SingleResult[]): SubagentDetails => ({
		mode,
		agentScope: "user",
		projectAgentsDir: null,
		results,
	});
}

/** Runner that records every call and resolves through the supplied handler. */
function createRunner(
	handler: (request: SingleRunRequest, index: number) => SingleResult | Promise<SingleResult>,
): { runner: DispatchRunner; calls: SingleRunRequest[] } {
	const calls: SingleRunRequest[] = [];
	const runner: DispatchRunner = {
		makeDetails,
		runSingle: async (request) => {
			calls.push(request);
			return handler(request, calls.length - 1);
		},
	};
	return { runner, calls };
}

/** Runner whose single runs stay pending until the test resolves them. */
function deferredRunner(): {
	runner: DispatchRunner;
	calls: SingleRunRequest[];
	pending: Array<{ request: SingleRunRequest; resolve: (result: SingleResult) => void }>;
} {
	const calls: SingleRunRequest[] = [];
	const pending: Array<{ request: SingleRunRequest; resolve: (result: SingleResult) => void }> = [];
	const runner: DispatchRunner = {
		makeDetails,
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
		const result = await runDispatch({ agent: "worker", task: "do it", cwd: "/tmp/work" }, runner, undefined, undefined);

		expect(textOf(result)).toBe("worker output");
		expect(result.isError).toBeUndefined();
		expect(result.details?.mode).toBe("single");
		expect(result.details?.results.map((r) => r.agent)).toEqual(["worker"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.task).toBe("do it");
		expect(calls[0]?.cwd).toBe("/tmp/work");
		expect(calls[0]?.step).toBeUndefined();
	});

	test("falls back to (no output) when the child produced no text", async () => {
		const { runner } = createRunner(() => singleResult("worker", undefined));
		const result = await runDispatch({ agent: "worker", task: "t" }, runner, undefined, undefined);
		expect(textOf(result)).toBe("(no output)");
		expect(result.isError).toBeUndefined();
	});

	test("failure text uses stopReason, then literal failed, and sets isError", async () => {
		const withReason = createRunner(() =>
			singleResult("worker", undefined, { exitCode: 1, stopReason: "error", errorMessage: "boom" }),
		);
		const reasonResult = await runDispatch({ agent: "worker", task: "t" }, withReason.runner, undefined, undefined);
		expect(textOf(reasonResult)).toBe("Agent error: boom");
		expect(reasonResult.isError).toBe(true);
		expect(isFailedResult(reasonResult.details?.results[0] ?? {})).toBe(true);

		const noReason = createRunner(() => singleResult("worker", undefined, { exitCode: 1, stderr: "trace" }));
		const noReasonResult = await runDispatch({ agent: "worker", task: "t" }, noReason.runner, undefined, undefined);
		expect(textOf(noReasonResult)).toBe("Agent failed: trace");
		expect(noReasonResult.isError).toBe(true);
	});
});

describe("signal and update forwarding", () => {
	test("forwards the abort signal to a single run", async () => {
		const controller = new AbortController();
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));

		await runDispatch({ agent: "worker", task: "t" }, runner, controller.signal, undefined);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.signal).toBe(controller.signal);
	});

	test("forwards onUpdate to the single run", async () => {
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));
		const updates: Array<AgentToolResult<SubagentDetails>> = [];
		const onUpdate = (update: AgentToolResult<SubagentDetails>) => updates.push(update);

		await runDispatch({ agent: "worker", task: "t" }, runner, undefined, onUpdate);

		expect(calls[0]?.onUpdate).toBe(onUpdate);
		const partial: AgentToolResult<SubagentDetails> = {
			content: [{ type: "text", text: "partial" }],
			details: makeDetails("single")([]),
		};
		calls[0]?.onUpdate?.(partial);
		expect(updates).toEqual([partial]);
	});

	test("forwards the abort signal to every parallel run", async () => {
		const controller = new AbortController();
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));

		await runDispatch(
			{
				tasks: [
					{ agent: "a", task: "1" },
					{ agent: "b", task: "2" },
					{ agent: "c", task: "3" },
				],
			},
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

		await runDispatch(
			{
				chain: [
					{ agent: "a", task: "1" },
					{ agent: "b", task: "2" },
				],
			},
			runner,
			controller.signal,
			undefined,
		);

		expect(calls).toHaveLength(2);
		expect(calls.map((call) => call.signal)).toEqual([controller.signal, controller.signal]);
	});

	test("returns the legacy invalid-parameters fallback instead of throwing", async () => {
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "ok"));
		runner.availableAgents = "scout (user), worker (project)";

		const result = await runDispatch({}, runner, undefined, undefined);

		expect(textOf(result)).toBe("Invalid parameters. Available agents: scout (user), worker (project)");
		expect(result.details?.mode).toBe("single");
		expect(result.details?.results).toEqual([]);
		expect(result.isError).toBeUndefined();
		expect(calls).toHaveLength(0);
	});
});

describe("chain dispatch", () => {
	test("interpolates {previous} from the prior step and preserves step numbers", async () => {
		const { runner, calls } = createRunner((request) => {
			if (request.agent === "a") return singleResult("a", "A-out");
			return singleResult("b", `seen:${request.task}`);
		});
		const result = await runDispatch(
			{
				chain: [
					{ agent: "a", task: "first" },
					{ agent: "b", task: "use {previous} twice {previous}" },
				],
			},
			runner,
			undefined,
			undefined,
		);

		expect(calls.map((c) => c.task)).toEqual(["first", "use A-out twice A-out"]);
		expect(calls.map((c) => c.step)).toEqual([1, 2]);
		expect(textOf(result)).toBe("seen:use A-out twice A-out");
		expect(result.details?.mode).toBe("chain");
		expect(result.details?.results.map((r) => r.agent)).toEqual(["a", "b"]);
		expect(result.isError).toBeUndefined();
	});

	test("stops at the first failed step and reports it", async () => {
		const { runner, calls } = createRunner((request) => {
			if (request.agent === "b")
				return singleResult("b", undefined, { exitCode: 1, stopReason: "error", errorMessage: "boom" });
			return singleResult(request.agent, `${request.agent}-out`);
		});
		const result = await runDispatch(
			{
				chain: [
					{ agent: "a", task: "1" },
					{ agent: "b", task: "2" },
					{ agent: "c", task: "3" },
				],
			},
			runner,
			undefined,
			undefined,
		);

		expect(textOf(result)).toBe("Chain stopped at step 2 (b): boom");
		expect(result.isError).toBe(true);
		expect(result.details?.results).toHaveLength(2);
		expect(calls.map((c) => c.agent)).toEqual(["a", "b"]);
	});

	test("streaming updates prepend completed prior results to the current partial", async () => {
		const { runner, pending } = deferredRunner();
		const updates: Array<AgentToolResult<SubagentDetails>> = [];
		const dispatch = runDispatch(
			{
				chain: [
					{ agent: "a", task: "1" },
					{ agent: "b", task: "2" },
				],
			},
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
			details: makeDetails("chain")([partial]),
		});

		const streamed = updates.at(-1);
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
		const runner: DispatchRunner = {
			makeDetails,
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

		const dispatch = runDispatch({ tasks }, runner, undefined, undefined);

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
		const result = await runDispatch(
			{
				tasks: [
					{ agent: "a", task: "1" },
					{ agent: "b", task: "2" },
					{ agent: "c", task: "3" },
				],
			},
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
		// The failure stays in details for the UI even though the aggregate is not an error.
		expect(isFailedResult(result.details?.results[1] ?? {})).toBe(true);
	});

	test("rejects more than the maximum parallel tasks before running any child", async () => {
		const { runner, calls } = createRunner((request) => singleResult(request.agent, "x"));
		const tasks = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, index) => ({
			agent: `a${index}`,
			task: "t",
		}));
		const result = await runDispatch({ tasks }, runner, undefined, undefined);

		expect(textOf(result)).toBe(`Too many parallel tasks (${MAX_PARALLEL_TASKS + 1}). Max is ${MAX_PARALLEL_TASKS}.`);
		expect(result.details?.results).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	test("streams running placeholders and running/done counts", async () => {
		const { runner, pending } = deferredRunner();
		const updates: Array<AgentToolResult<SubagentDetails>> = [];
		const dispatch = runDispatch(
			{
				tasks: [
					{ agent: "a", task: "1" },
					{ agent: "b", task: "2" },
				],
			},
			runner,
			undefined,
			(update) => updates.push(update),
		);

		pending[0]?.request.onUpdate?.({
			content: [{ type: "text", text: "partial-a" }],
			details: makeDetails("parallel")([singleResult("a", "partial-a", { exitCode: -1 })]),
		});
		const running = updates.at(-1);
		expect(textOf(running as AgentToolResult<SubagentDetails>)).toBe("Parallel: 0/2 done, 2 running...");
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
		const result = await runDispatch({ tasks: [{ agent: "a", task: "t" }] }, runner, undefined, undefined);

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
		const result = await runDispatch({ tasks: [{ agent: "a", task: "t" }] }, runner, undefined, undefined);
		expect(textOf(result)).toContain(atCap);
		expect(textOf(result)).not.toContain("[Output truncated:");
	});

	test("counts bytes, not characters, for multibyte output", async () => {
		const multibyte = "é".repeat(PER_TASK_OUTPUT_CAP);
		const { runner } = createRunner(() => singleResult("a", multibyte));
		const result = await runDispatch({ tasks: [{ agent: "a", task: "t" }] }, runner, undefined, undefined);

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
		const singleResultOut = await runDispatch({ agent: "a", task: "t" }, single.runner, undefined, undefined);
		expect(textOf(singleResultOut)).toBe(huge);
		expect(textOf(singleResultOut)).not.toContain("[Output truncated:");

		const chain = createRunner(() => singleResult("a", huge));
		const chainResult = await runDispatch({ chain: [{ agent: "a", task: "t" }] }, chain.runner, undefined, undefined);
		expect(textOf(chainResult)).toBe(huge);
		expect(textOf(chainResult)).not.toContain("[Output truncated:");
	});
});
