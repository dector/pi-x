/**
 * Unified dispatch lifecycle tests.
 *
 * These pin the blocking-attached / detach-to-background behavior on top of the
 * existing async ownership: in-line settlement vs exactly-one completion, parent
 * signal unlink, onUpdate gating, acknowledgement shape, background marking, and
 * the shutdown races that must not hang a blocking tool call.
 */

import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { runPreparedDispatch } from "./dispatch.ts";
import { herdrBackgroundPayload } from "./herdr-background.ts";
import {
	AsyncDispatchManager,
	DispatchLifecycleManager,
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
		execution: "blocking",
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

function textOf(result: AgentToolResult<SubagentDetails>): string {
	const part = result.content[0];
	return part?.type === "text" ? part.text : "";
}

interface Delivered {
	message: SubagentCompletionMessage;
	options: CompletionDeliveryOptions;
}

function createManager() {
	const delivered: Delivered[] = [];
	const manager = new DispatchLifecycleManager({
		deliver: (message, options) => delivered.push({ message, options }),
	});
	return { manager, delivered };
}

/**
 * A runner whose single pending call the test settles manually. It records the
 * signal and the manager-supplied (gated) onUpdate so tests can emit progress.
 */
function controllableRun() {
	let resolve!: (result: AgentToolResult<SubagentDetails>) => void;
	let reject!: (error: unknown) => void;
	const signals: AbortSignal[] = [];
	const updateCallbacks: Array<((partial: AgentToolResult<SubagentDetails>) => void) | undefined> = [];
	const run = (signal: AbortSignal, onUpdate?: (partial: AgentToolResult<SubagentDetails>) => void) => {
		signals.push(signal);
		updateCallbacks.push(onUpdate);
		return new Promise<AgentToolResult<SubagentDetails>>((res, rej) => {
			resolve = res;
			reject = rej;
		});
	};
	return {
		run,
		signals,
		updateCallbacks,
		resolve: (result: AgentToolResult<SubagentDetails>) => resolve(result),
		reject: (error: unknown) => reject(error),
		emit: (partial: AgentToolResult<SubagentDetails>) => updateCallbacks.at(-1)?.(partial),
	};
}

function progressUpdate(text: string): AgentToolResult<SubagentDetails> {
	return { content: [{ type: "text", text }], details: undefined };
}

describe("attached blocking settlement", () => {
	test("returns the aggregate in-line and injects no completion", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();

		const handle = manager.start(dispatch, run.run, { attach: {} });
		expect(handle).toBeDefined();
		expect(handle?.ownership).toBe("attached");
		expect(manager.isAttached(dispatch.dispatchId)).toBe(true);

		const aggregateResult = aggregate(dispatch, [singleResult("worker", "sa-1", "done")]);
		run.resolve(aggregateResult);

		await expect(handle?.result).resolves.toBe(aggregateResult);
		await handle?.promise;

		expect(delivered).toHaveLength(0);
		expect(handle?.ownership).toBe("settled");
		expect(manager.isAttached(dispatch.dispatchId)).toBe(false);
		expect(manager.size).toBe(0);
	});

	test("rejects the blocking tool call when the runner rejects while attached", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const handle = manager.start(dispatch, run.run, { attach: {} });

		run.reject(new Error("orchestration exploded"));
		await expect(handle?.result).rejects.toThrow("orchestration exploded");
		await handle?.promise;

		// A blocking dispatch injects no completion; the throw is the terminal outcome.
		expect(delivered).toHaveLength(0);
		expect(handle?.ownership).toBe("settled");
		expect(manager.size).toBe(0);
	});

	test("keeps the shutdown abort result when the runner rejects later", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const handle = manager.start(dispatch, run.run, { attach: {} });

		const shutdown = manager.shutdown();
		run.reject(new Error("late failure"));
		// The already-resolved abort result wins; a late rejection must not surface.
		await expect(handle?.result).resolves.toMatchObject({ details: { dispatchStatus: "aborted" } });
		await shutdown;
		expect(delivered).toHaveLength(0);
	});

	test("a handle without attach is detached from launch and injects one completion", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch({ execution: "async" });
		const run = controllableRun();

		const handle = manager.start(dispatch, run.run);
		expect(handle?.ownership).toBe("detached");

		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await handle?.promise;

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.customType).toBe(SUBAGENT_COMPLETION_CUSTOM_TYPE);
		expect(delivered[0]?.message.details?.dispatchStatus).toBe("completed");
	});
});

describe("detach", () => {
	test("resolves the blocking call with an acknowledgement and keeps the same child running", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const detachedIds: string[] = [];
		const handle = manager.start(dispatch, run.run, {
			attach: {},
			onDetach: (dispatchId) => detachedIds.push(dispatchId),
		});

		const outcome = manager.detach(dispatch.dispatchId);
		expect(outcome.ok).toBe(true);
		expect(detachedIds).toEqual([dispatch.dispatchId]);
		expect(handle?.ownership).toBe("detached");
		expect(handle?.everDetached).toBe(true);
		expect(manager.isAttached(dispatch.dispatchId)).toBe(false);

		const acknowledgement = await handle?.result;
		expect(acknowledgement?.details).toMatchObject({
			dispatchId: dispatch.dispatchId,
			execution: "blocking",
			dispatchStatus: "started",
			results: [],
		});
		expect(textOf(acknowledgement as AgentToolResult<SubagentDetails>)).toContain("detached");
		expect(textOf(acknowledgement as AgentToolResult<SubagentDetails>)).toContain("continues in the background");

		// The child is untouched and no completion has arrived yet.
		expect(run.signals[0]?.aborted).toBe(false);
		expect(delivered).toHaveLength(0);

		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await handle?.promise;

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.details?.dispatchStatus).toBe("completed");
	});

	test("a second detach is rejected without duplicating anything", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const handle = manager.start(dispatch, run.run, { attach: {} });

		expect(manager.detach(dispatch.dispatchId).ok).toBe(true);
		const second = manager.detach(dispatch.dispatchId);
		expect(second.ok).toBe(false);
		expect(second.reason).toBe("already-detached");

		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await handle?.promise;
		expect(delivered).toHaveLength(1);
	});

	test("detach after settlement is an error and injects nothing extra", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const handle = manager.start(dispatch, run.run, { attach: {} });

		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await handle?.result;
		const outcome = manager.detach(dispatch.dispatchId);

		expect(outcome.ok).toBe(false);
		expect(outcome.message).toContain(dispatch.dispatchId);
		await handle?.promise;
		expect(delivered).toHaveLength(0);
	});

	test("detach during a completion-vs-detach race never both delivers and returns an aggregate", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const handle = manager.start(dispatch, run.run, { attach: {} });

		// Detach first; the settle that lands afterwards must deliver exactly once.
		expect(manager.detach(dispatch.dispatchId).ok).toBe(true);
		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "after-detach")]));
		await handle?.promise;

		const acknowledgement = await handle?.result;
		expect(acknowledgement?.details?.dispatchStatus).toBe("started");
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.content).toContain("after-detach");
	});

	test("a detached runner rejection still delivers one failed completion", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const handle = manager.start(dispatch, run.run, { attach: {} });
		expect(manager.detach(dispatch.dispatchId).ok).toBe(true);

		run.reject(new Error("after detach"));
		await handle?.promise;

		await expect(handle?.result).resolves.toMatchObject({ details: { dispatchStatus: "started" } });
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.details?.dispatchStatus).toBe("failed");
		expect(delivered[0]?.message.content).toContain("after detach");
	});

	test("rejects detach once shutdown began so it cannot promise a suppressed completion", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		let detachedCalls = 0;
		const handle = manager.start(dispatch, run.run, {
			attach: {},
			onDetach: () => {
				detachedCalls += 1;
			},
		});

		const shutdown = manager.shutdown();
		const outcome = manager.detach(dispatch.dispatchId);
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toBe("stale");
		expect(handle?.ownership).toBe("attached");
		expect(handle?.everDetached).toBe(false);
		expect(detachedCalls).toBe(0);

		// Shutdown already resolved the blocking call, so it cannot hang.
		const result = await handle?.result;
		expect(result?.details?.dispatchStatus).toBe("aborted");

		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await shutdown;
		expect(delivered).toHaveLength(0);
	});

	test("rejects detach for a stale epoch after reset into a replacement session", async () => {
		const { manager } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const handle = manager.start(dispatch, run.run, { attach: {} });

		const shutdown = manager.shutdown();
		manager.reset();
		const outcome = manager.detach(dispatch.dispatchId);
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toBe("stale");
		expect(handle?.ownership).toBe("attached");

		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await shutdown;
	});
});

describe("parent signal forwarding", () => {
	test("forwards a parent abort while attached", async () => {
		const { manager } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const parent = new AbortController();
		const handle = manager.start(dispatch, run.run, { attach: { parentSignal: parent.signal } });

		expect(handle?.controller.signal.aborted).toBe(false);
		parent.abort();
		expect(handle?.controller.signal.aborted).toBe(true);
	});

	test("unlinks parent abort forwarding on detach", async () => {
		const { manager } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const parent = new AbortController();
		const handle = manager.start(dispatch, run.run, { attach: { parentSignal: parent.signal } });

		expect(manager.detach(dispatch.dispatchId).ok).toBe(true);
		parent.abort();

		expect(handle?.controller.signal.aborted).toBe(false);
		expect(run.signals[0]?.aborted).toBe(false);
	});

	test("an already-aborted parent signal aborts a newly attached dispatch", () => {
		const { manager } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const parent = new AbortController();
		parent.abort();

		const handle = manager.start(dispatch, run.run, { attach: { parentSignal: parent.signal } });
		expect(handle?.controller.signal.aborted).toBe(true);
	});
});

describe("onUpdate gating", () => {
	test("streams while attached and stops the moment it is detached", () => {
		const { manager } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const updates: string[] = [];
		manager.start(dispatch, run.run, {
			attach: { onUpdate: (partial) => updates.push(textOf(partial)) },
		});

		run.emit(progressUpdate("first"));
		expect(updates).toEqual(["first"]);

		expect(manager.detach(dispatch.dispatchId).ok).toBe(true);
		run.emit(progressUpdate("second"));
		expect(updates).toEqual(["first"]);
	});

	test("never forwards updates after an attached settle", async () => {
		const { manager } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const updates: string[] = [];
		const handle = manager.start(dispatch, run.run, {
			attach: { onUpdate: (partial) => updates.push(textOf(partial)) },
		});

		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await handle?.result;
		run.emit(progressUpdate("late"));
		expect(updates).toHaveLength(0);
	});
});

describe("background marking", () => {
	test("calls onDetach exactly once on detach and never on a normal settle", async () => {
		const { manager } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		let detached = 0;
		const handle = manager.start(dispatch, run.run, {
			attach: {},
			onDetach: () => {
				detached += 1;
			},
		});

		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await handle?.promise;
		expect(detached).toBe(0);
	});

	test("swallows an onDetach failure so the transition still completes", async () => {
		const { manager } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const handle = manager.start(dispatch, run.run, {
			attach: {},
			onDetach: () => {
				throw new Error("registry glitch");
			},
		});

		expect(manager.detach(dispatch.dispatchId).ok).toBe(true);
		expect(handle?.ownership).toBe("detached");
	});

	test("turns on a Herdr background lease on detach and clears it after settle", async () => {
		const { manager } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const leases: Array<{ id: string; active: boolean }> = [];

		const handle = manager.start(dispatch, run.run, {
			attach: {},
			onDetach: (dispatchId) => leases.push(herdrBackgroundPayload(dispatchId, true)),
		});
		// Mirrors `index.ts`: only a detach ever holds a lease, so clear on settle
		// only when the handle was actually detached.
		const clearDetachedLease = (): void => {
			if (handle?.everDetached) leases.push(herdrBackgroundPayload(dispatch.dispatchId, false));
		};
		void handle?.promise.then(clearDetachedLease, clearDetachedLease);

		expect(manager.detach(dispatch.dispatchId).ok).toBe(true);
		expect(leases).toEqual([{ id: `subagent:${dispatch.dispatchId}`, active: true }]);

		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await handle?.promise;

		expect(leases).toEqual([
			{ id: `subagent:${dispatch.dispatchId}`, active: true },
			{ id: `subagent:${dispatch.dispatchId}`, active: false },
		]);
	});

	test("never holds a Herdr lease for a blocking dispatch that settles attached", async () => {
		const { manager } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const leases: Array<{ id: string; active: boolean }> = [];

		const handle = manager.start(dispatch, run.run, {
			attach: {},
			onDetach: (dispatchId) => leases.push(herdrBackgroundPayload(dispatchId, true)),
		});
		const clearDetachedLease = (): void => {
			if (handle?.everDetached) leases.push(herdrBackgroundPayload(dispatch.dispatchId, false));
		};
		void handle?.promise.then(clearDetachedLease, clearDetachedLease);

		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await handle?.promise;

		expect(leases).toHaveLength(0);
	});
});

describe("shutdown races", () => {
	test("resolves an attached blocking result immediately so the tool call cannot hang", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const handle = manager.start(dispatch, run.run, { attach: {} });

		const shutdown = manager.shutdown();
		const result = await handle?.result;
		expect(result?.details?.dispatchStatus).toBe("aborted");

		// Drain still waits for the runner to settle before shutdown resolves.
		let drained = false;
		void shutdown.then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);

		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await shutdown;
		expect(delivered).toHaveLength(0);
		expect(manager.size).toBe(0);
	});

	test("suppresses a detached completion once shutdown began", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const handle = manager.start(dispatch, run.run, { attach: {} });

		expect(manager.detach(dispatch.dispatchId).ok).toBe(true);
		const shutdown = manager.shutdown();
		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "done")]));
		await shutdown;

		expect(delivered).toHaveLength(0);
		expect(handle?.ownership).toBe("settled");
	});

	test("does not deliver a stale completion after reset into a replacement session", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const run = controllableRun();
		const handle = manager.start(dispatch, run.run, { attach: {} });
		expect(manager.detach(dispatch.dispatchId).ok).toBe(true);

		const shutdown = manager.shutdown();
		manager.reset();
		run.resolve(aggregate(dispatch, [singleResult("worker", "sa-1", "stale")]));
		await shutdown;
		expect(delivered).toHaveLength(0);
		expect(handle?.ownership).toBe("settled");
	});
});

describe("alias compatibility", () => {
	test("AsyncDispatchManager is the same lifecycle manager", () => {
		expect(AsyncDispatchManager).toBe(DispatchLifecycleManager);
	});
});

describe("attached runner integration", () => {
	test("orchestrates a real blocking dispatch and returns the aggregate in-line", async () => {
		const { manager, delivered } = createManager();
		const dispatch = preparedDispatch();
		const handle = manager.start(
			dispatch,
			(signal, onUpdate) =>
				runPreparedDispatch(
					dispatch,
					{ runSingle: async (request) => singleResult(request.agent, request.runId, `${request.agent}-out`) },
					signal,
					onUpdate,
				),
			{ attach: {} },
		);

		await handle?.promise;
		const result = await handle?.result;
		expect(result?.details?.dispatchStatus).toBe("completed");
		expect(textOf(result as AgentToolResult<SubagentDetails>)).toBe("worker-out");
		expect(delivered).toHaveLength(0);
	});
});
