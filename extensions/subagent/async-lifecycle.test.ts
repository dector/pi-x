/**
 * Stage 4 detached-dispatch lifecycle tests.
 *
 * These drive `AsyncDispatchManager` directly with deferred runner promises and
 * a delivery spy. They pin the ownership and delivery races the parent tool
 * invocation can no longer observe: return-before-settle, parent-signal
 * isolation, exactly-once completion, exception conversion, manager abort,
 * bookkeeping cleanup, and shutdown suppression.
 */

import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { buildDispatchExceptionResult, runPreparedDispatch, SubagentAbortError } from "./dispatch.ts";
import {
	AsyncDispatchManager,
	SUBAGENT_COMPLETION_CUSTOM_TYPE,
	type CompletionDeliveryOptions,
	type SubagentCompletionMessage,
} from "./lifecycle.ts";
import type { PreparedSubagentDispatch, SingleResult, SubagentDetails } from "./types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function assistant(text: string) {
	return { role: "assistant", content: [{ type: "text", text }], usage, stopReason: "end" };
}

function singleResult(agent: string, runId: string, output: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent,
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [assistant(output)],
		stderr: "",
		usage,
		runId,
		...overrides,
	};
}

function preparedDispatch(overrides: Partial<PreparedSubagentDispatch> = {}): PreparedSubagentDispatch {
	return {
		dispatchId: "dispatch-1",
		execution: "async",
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		agents: [],
		dispatchDefaults: {},
		cwd: "/tmp/repo",
		items: [{ runId: "sa-1", agent: "worker", task: "do it" }],
		...overrides,
	};
}

function aggregate(
	dispatch: PreparedSubagentDispatch,
	results: SingleResult[],
	status: SubagentDetails["dispatchStatus"] = "completed",
): AgentToolResult<SubagentDetails> {
	return {
		content: [{ type: "text", text: "aggregate" }],
		details: {
			mode: dispatch.mode,
			execution: dispatch.execution,
			dispatchId: dispatch.dispatchId,
			dispatchStatus: status,
			agentScope: dispatch.agentScope,
			projectAgentsDir: dispatch.projectAgentsDir,
			results,
		},
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

/** A runner whose single pending call the test resolves or rejects manually. */
function deferredRun() {
	let resolve!: (result: AgentToolResult<SubagentDetails>) => void;
	let reject!: (error: unknown) => void;
	const signals: AbortSignal[] = [];
	const run = (signal: AbortSignal) => {
		signals.push(signal);
		return new Promise<AgentToolResult<SubagentDetails>>((res, rej) => {
			resolve = res;
			reject = rej;
		});
	};
	return { run, signals, resolve: (result: AgentToolResult<SubagentDetails>) => resolve(result), reject: (error: unknown) => reject(error) };
}

describe("start ownership", () => {
	test("returns before the runner settles and stores the handle immediately", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const deferred = deferredRun();

		const handle = manager.start(dispatch, deferred.run);

		// Ownership is registered before returning the acknowledgement.
		expect(manager.size).toBe(1);
		expect(manager.get(dispatch.dispatchId)).toBe(handle);
		expect(handle.dispatchId).toBe("dispatch-1");
		expect(deferred.signals).toHaveLength(1);
		expect(delivered).toHaveLength(0);

		deferred.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await handle.promise;

		expect(delivered).toHaveLength(1);
		expect(manager.size).toBe(0);
	});

	test("isolates the detached run from the parent tool signal", async () => {
		const { manager } = createManager();
		const dispatch = preparedDispatch();
		const deferred = deferredRun();
		const parent = new AbortController();

		const handle = manager.start(dispatch, deferred.run);
		// The runner receives the dispatch controller's signal, not the parent's.
		expect(deferred.signals[0]).toBe(handle.controller.signal);
		expect(deferred.signals[0]).not.toBe(parent.signal);

		parent.abort();
		expect(deferred.signals[0]?.aborted).toBe(false);

		deferred.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await handle.promise;
	});
});

describe("completion delivery", () => {
	test("emits one follow-up custom message with triggerTurn and dispatch details", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch({
			mode: "parallel",
			dispatchId: "dispatch-42",
			items: [
				{ runId: "sa-1", agent: "worker", task: "one" },
				{ runId: "sa-2", agent: "worker", task: "two" },
			],
		});
		const deferred = deferredRun();
		const handle = manager.start(dispatch, deferred.run);

		deferred.resolve(
			aggregate(dispatch, [
				singleResult("worker", "sa-1", "first"),
				singleResult("worker", "sa-2", "second"),
			]),
		);
		await handle.promise;

		expect(delivered).toHaveLength(1);
		const [{ message, options }] = delivered;
		expect(message.customType).toBe(SUBAGENT_COMPLETION_CUSTOM_TYPE);
		expect(message.display).toBe(true);
		expect(message.details).toMatchObject({
			mode: "parallel",
			execution: "async",
			dispatchId: "dispatch-42",
			dispatchStatus: "completed",
		});
		expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		// Content carries dispatch and run identity, tasks, and outputs.
		expect(message.content).toContain("dispatch-42");
		expect(message.content).toContain("sa-1");
		expect(message.content).toContain("sa-2");
		expect(message.content).toContain("first");
		expect(message.content).toContain("second");
	});

	test("converts a runner rejection into a terminal failed completion", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const deferred = deferredRun();
		const handle = manager.start(dispatch, deferred.run);

		deferred.reject(new Error("orchestration exploded"));
		await handle.promise;

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.details?.dispatchStatus).toBe("failed");
		expect(delivered[0]?.message.content).toContain("orchestration exploded");
		expect(manager.size).toBe(0);
	});

	test("delivers a partial-failure aggregate as completed with failure output intact", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch({
			items: [
				{ runId: "sa-1", agent: "worker", task: "one" },
				{ runId: "sa-2", agent: "worker", task: "two" },
			],
		});
		const deferred = deferredRun();
		const handle = manager.start(dispatch, deferred.run);

		deferred.resolve(
			aggregate(dispatch, [
				singleResult("worker", "sa-1", "ok"),
				singleResult("worker", "sa-2", "boom", {
					exitCode: 1,
					stopReason: "error",
					errorMessage: "boom",
				}),
			]),
		);
		await handle.promise;

		expect(delivered[0]?.message.content).toContain("Failure: boom");
		expect(delivered[0]?.message.content).toContain("Output: ok");
	});
});

describe("manager abort", () => {
	test("aborts the dispatch controller and still delivers the terminal aggregate", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const deferred = deferredRun();
		const handle = manager.start(dispatch, deferred.run);

		expect(manager.abort(dispatch.dispatchId)).toBe(true);
		expect(handle.controller.signal.aborted).toBe(true);

		deferred.resolve(
			aggregate(dispatch, [singleResult("worker", "sa-1", "", { stopReason: "aborted", errorMessage: "stopped" })], "aborted"),
		);
		await handle.promise;

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.details?.dispatchStatus).toBe("aborted");
		expect(manager.size).toBe(0);
	});

	test("returns false for an unknown dispatch id", () => {
		const { manager } = createManager();
		expect(manager.abort("missing")).toBe(false);
	});
});

describe("shutdown", () => {
	test("aborts every dispatch, awaits settlement, and suppresses completion injection", async () => {
		const { manager, delivered } = createManager();
		const first = preparedDispatch({ dispatchId: "dispatch-a" });
		const second = preparedDispatch({ dispatchId: "dispatch-b" });
		const a = deferredRun();
		const b = deferredRun();
		const handleA = manager.start(first, a.run);
		const handleB = manager.start(second, b.run);

		const shutdown = manager.shutdown();
		// Abort happens synchronously; delivery is already suppressed.
		expect(handleA.controller.signal.aborted).toBe(true);
		expect(handleB.controller.signal.aborted).toBe(true);
		expect(manager.shuttingDown).toBe(true);

		a.resolve(aggregate(first, [singleResult("worker", "sa-1", "a")]));
		b.resolve(aggregate(second, [singleResult("worker", "sa-1", "b")]));
		await shutdown;

		expect(delivered).toHaveLength(0);
		expect(manager.size).toBe(0);
	});

	test("does not resolve until in-flight runs settle", async () => {
		const { manager } = createManager();
		const dispatch = preparedDispatch();
		const deferred = deferredRun();
		manager.start(dispatch, deferred.run);

		let settled = false;
		const shutdown = manager.shutdown().then(() => {
			settled = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		deferred.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "ok")]));
		await shutdown;
		expect(settled).toBe(true);
	});

	test("reset clears the shutdown flag for a replacement session", async () => {
		const { manager, delivered } = createManager();
		await manager.shutdown();
		expect(manager.shuttingDown).toBe(true);
		manager.reset();
		expect(manager.shuttingDown).toBe(false);

		const dispatch = preparedDispatch();
		const deferred = deferredRun();
		const handle = manager.start(dispatch, deferred.run);
		deferred.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "ok")]));
		await handle.promise;
		expect(delivered).toHaveLength(1);
	});
});

describe("bookkeeping cleanup", () => {
	test("removes ownership after success, failure, and abort", async () => {
		const { manager } = createManager();

		const successDispatch = preparedDispatch({ dispatchId: "d-success" });
		const success = deferredRun();
		const successHandle = manager.start(successDispatch, success.run);
		success.resolve(aggregate(successDispatch, [singleResult("worker", "sa-1", "ok")]));
		await successHandle.promise;
		expect(manager.get("d-success")).toBeUndefined();

		const failureDispatch = preparedDispatch({ dispatchId: "d-failure" });
		const failure = deferredRun();
		const failureHandle = manager.start(failureDispatch, failure.run);
		failure.reject(new Error("nope"));
		await failureHandle.promise;
		expect(manager.get("d-failure")).toBeUndefined();

		const abortDispatch = preparedDispatch({ dispatchId: "d-abort" });
		const aborted = deferredRun();
		const abortHandle = manager.start(abortDispatch, aborted.run);
		manager.abort("d-abort");
		aborted.resolve(
			aggregate(abortDispatch, [singleResult("worker", "sa-1", "", { stopReason: "aborted" })], "aborted"),
		);
		await abortHandle.promise;
		expect(manager.get("d-abort")).toBeUndefined();
		expect(manager.size).toBe(0);
	});
});

describe("buildDispatchExceptionResult", () => {
	test("builds a failed aggregate carrying every prepared run id", () => {
		const dispatch = preparedDispatch({
			mode: "parallel",
			dispatchId: "d-err",
			items: [
				{ runId: "sa-1", agent: "a", task: "one" },
				{ runId: "sa-2", agent: "b", task: "two" },
			],
		});
		const result = buildDispatchExceptionResult(dispatch, new Error("kaboom"));

		expect(result.isError).toBe(true);
		expect(result.details?.dispatchStatus).toBe("failed");
		expect(result.details?.execution).toBe("async");
		expect(result.details?.results.map((single) => single.runId)).toEqual(["sa-1", "sa-2"]);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("kaboom");
	});
});

describe("shutdown and session-reset races", () => {
	test("a preparation that completes after shutdown cannot start an orphan", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const deferred = deferredRun();

		let preparationResolve!: () => void;
		const preparation = new Promise<void>((resolve) => {
			preparationResolve = resolve;
		});

		// Simulates execute(): await preparation, then start the detached run.
		const acceptance = (async () => {
			await preparation;
			return manager.start(dispatch, deferred.run);
		})();

		await manager.shutdown();
		preparationResolve();
		const handle = await acceptance;

		expect(handle).toBeUndefined();
		expect(manager.size).toBe(0);
		expect(deferred.signals).toHaveLength(0);
		expect(delivered).toHaveLength(0);
	});

	test("start after shutdown is refused", async () => {
		const { manager } = createManager();
		await manager.shutdown();

		const handle = manager.start(preparedDispatch(), deferredRun().run);

		expect(handle).toBeUndefined();
		expect(manager.size).toBe(0);
	});

	test("a stale handle cannot deliver after reset into the replacement session", async () => {
		const { manager, delivered } = createManager();
		const staleDispatch = preparedDispatch({ dispatchId: "stale" });
		const stale = deferredRun();
		manager.start(staleDispatch, stale.run);

		const shutdown = manager.shutdown();
		// The replacement session starts while the old handle is still in flight.
		manager.reset();
		expect(manager.shuttingDown).toBe(false);

		stale.resolve(aggregate(staleDispatch, [singleResult("worker", "sa-stale", "stale")]));
		await shutdown;
		expect(delivered).toHaveLength(0);

		// New session work is accepted and delivered normally.
		const freshDispatch = preparedDispatch({ dispatchId: "fresh" });
		const fresh = deferredRun();
		const freshHandle = manager.start(freshDispatch, fresh.run);
		expect(freshHandle).toBeDefined();
		fresh.resolve(aggregate(freshDispatch, [singleResult("worker", "sa-fresh", "fresh")]));
		await freshHandle?.promise;
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.content).toContain("fresh");
		expect(manager.size).toBe(0);
	});

	test("a replacement dispatch survives the old session's shutdown while it drains", async () => {
		const { manager, delivered } = createManager();
		const oldDispatch = preparedDispatch({ dispatchId: "old" });
		const oldRun = deferredRun();
		manager.start(oldDispatch, oldRun.run);

		const shutdown = manager.shutdown();
		manager.reset();

		const freshDispatch = preparedDispatch({ dispatchId: "new" });
		const freshRun = deferredRun();
		const freshHandle = manager.start(freshDispatch, freshRun.run);
		expect(freshHandle).toBeDefined();

		oldRun.resolve(aggregate(oldDispatch, [singleResult("worker", "sa-old", "old")]));
		await shutdown;
		expect(delivered).toHaveLength(0);
		expect(manager.get("new")).toBe(freshHandle);

		freshRun.resolve(aggregate(freshDispatch, [singleResult("worker", "sa-new", "fresh")]));
		await freshHandle?.promise;
		expect(delivered).toHaveLength(1);
		expect(manager.size).toBe(0);
	});

	test("canStart reflects shutdown and an already-aborted parent signal", async () => {
		const { manager } = createManager();
		expect(manager.canStart()).toBe(true);

		const parent = new AbortController();
		parent.abort();
		expect(manager.canStart(parent.signal)).toBe(false);

		await manager.shutdown();
		expect(manager.canStart()).toBe(false);
	});
});

describe("partial results and abort classification through the real runner", () => {
	test("keeps successful parallel siblings when one child throws", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch({
			mode: "parallel",
			dispatchId: "d-partial",
			items: [
				{ runId: "sa-1", agent: "a", task: "one" },
				{ runId: "sa-2", agent: "b", task: "two" },
				{ runId: "sa-3", agent: "c", task: "three" },
			],
		});
		const handle = manager.start(dispatch, (signal) =>
			runPreparedDispatch(
				dispatch,
				{
					runSingle: async (request) => {
						if (request.agent === "b") throw new Error("child exploded");
						return singleResult(request.agent, request.runId, `${request.agent}-out`);
					},
				},
				signal,
				undefined,
			),
		);
		await handle?.promise;

		expect(delivered).toHaveLength(1);
		const content = delivered[0]?.message.content ?? "";
		expect(content).toContain("Output: a-out");
		expect(content).toContain("Output: c-out");
		expect(content).toContain("Failure: child exploded");
		expect(content).toContain("2/3 succeeded");
		expect(delivered[0]?.message.details?.results.map((single) => single.agent)).toEqual(["a", "b", "c"]);
		expect(manager.size).toBe(0);
	});

	test("classifies an aborted child as aborted and preserves its partial output", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch({ dispatchId: "d-abort" });
		const handle = manager.start(dispatch, (signal) =>
			runPreparedDispatch(
				dispatch,
				{
					runSingle: async (request) => {
						// Mirrors `runSingleAgent`'s mid-flight snapshot: no stopReason yet.
						throw new SubagentAbortError(
							singleResult(request.agent, request.runId, "partial output", { exitCode: -1, state: "aborting" }),
						);
					},
				},
				signal,
				undefined,
			),
		);
		await handle?.promise;

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.details?.dispatchStatus).toBe("aborted");
		expect(delivered[0]?.message.content).toContain("partial output");
	});
});

describe("delivery guards", () => {
	test("swallows a delivery exception and still removes ownership", async () => {
		const manager = new AsyncDispatchManager({
			deliver: () => {
				throw new Error("stale extension instance");
			},
		});
		const dispatch = preparedDispatch();
		const deferred = deferredRun();
		const handle = manager.start(dispatch, deferred.run);

		deferred.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "ok")]));
		await handle?.promise;

		expect(manager.size).toBe(0);
	});

	test("delivers a fallback completion when formatting throws", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch({ dispatchId: "d-bad-format" });
		const badDetails = { get results(): never { throw new Error("corrupt details"); } } as unknown as SubagentDetails;
		const handle = manager.start(dispatch, async () => ({
			content: [{ type: "text", text: "ignored" }],
			details: badDetails,
		}));
		await handle?.promise;

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.content).toContain("could not be formatted");
		expect(delivered[0]?.message.content).toContain("d-bad-format");
		expect(manager.size).toBe(0);
	});

	test("does not reject for a malformed runner result", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch({ dispatchId: "d-malformed" });
		const handle = manager.start(
			dispatch,
			async () => null as unknown as AgentToolResult<SubagentDetails>,
		);
		await handle?.promise;

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.content).toContain("could not be formatted");
		expect(manager.size).toBe(0);
	});
});
