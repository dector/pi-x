/**
 * Parent-side control operation tests.
 *
 * Covers validation, run/dispatch addressing, stop escalation, steer
 * delivery/partial failure, error semantics (Pi 0.85.1 only honors a thrown
 * error), the log/render surface, and the compatibility seam that keeps an
 * action-less request a normal dispatch.
 *
 * The control logic is pure, so most tests use a fake runtime. The lifecycle
 * tests wire the real `SubagentRegistry` + `AsyncDispatchManager` +
 * `runPreparedDispatch` to prove a stop produces one aborted aggregate and
 * completes the registry entry.
 */

import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { persistedAgentLogEntries } from "./agent-log.ts";
import {
	executeSubagentControl,
	formatControlCall,
	isSubagentControlRequest,
	parseSubagentControl,
	type SubagentControlRuntime,
} from "./control-ops.ts";
import { runPreparedDispatch, SubagentAbortError, type DispatchRuntimeDependencies, type SingleRunRequest } from "./dispatch.ts";
import { emptyUsage } from "./events.ts";
import {
	AsyncDispatchManager,
	type CompletionDeliveryOptions,
	type SubagentCompletionMessage,
} from "./lifecycle.ts";
import { SubagentRegistry, sendSteer, type SubagentRunRuntime } from "./registry.ts";
import type { RpcChild } from "./rpc-client.ts";
import { RunStopController } from "./run-stop.ts";
import type { PreparedSubagentDispatch, RpcCommand, RpcResponse, SingleResult, SubagentDetails } from "./types.ts";

function makeRun(overrides: Partial<SubagentRunRuntime> & { runId: string }): SubagentRunRuntime {
	return {
		agentName: "worker",
		task: "do the thing",
		cwd: "/tmp/repo",
		startedAt: Date.now(),
		result: {
			agent: "worker",
			agentSource: "user",
			task: "do the thing",
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: emptyUsage(),
		},
		...overrides,
	};
}

function stubChild(
	handler: (command: RpcCommand, timeoutMs: number) => RpcResponse | Promise<RpcResponse>,
	state: { exited?: boolean } = {},
): RpcChild {
	return {
		pid: 1,
		get exited() {
			return state.exited === true;
		},
		stderr: "",
		exit: Promise.resolve({ code: 0, signal: null }),
		request: async (command, timeoutMs) => handler(command, timeoutMs),
		send: () => {},
		respondUi: () => {},
		terminate: async () => {},
	};
}

interface RuntimeHarness {
	runtime: SubagentControlRuntime;
	abortedDispatches: string[];
	steers: Array<{ runId: string; message: string }>;
}

function createRuntime(
	runs: SubagentRunRuntime[],
	options: {
		abortDispatch?: (dispatchId: string) => boolean;
		steer?: (run: SubagentRunRuntime, message: string, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<void>;
	} = {},
): RuntimeHarness {
	const abortedDispatches: string[] = [];
	const steers: Array<{ runId: string; message: string }> = [];
	const runtime: SubagentControlRuntime = {
		runs: () => runs,
		getRun: (runId) => runs.find((run) => run.runId === runId),
		abortDispatch: (dispatchId) => {
			abortedDispatches.push(dispatchId);
			return options.abortDispatch ? options.abortDispatch(dispatchId) : true;
		},
		steer: async (run, message, steerOptions) => {
			steers.push({ runId: run.runId, message });
			if (options.steer) await options.steer(run, message, steerOptions);
		},
	};
	return { runtime, abortedDispatches, steers };
}

function textOf(result: AgentToolResult<SubagentDetails>): string {
	const part = result.content[0];
	return part && part.type === "text" ? part.text : "";
}

function sortedRunIds(result: AgentToolResult<SubagentDetails>): string[] {
	return [...(result.details.control?.runIds ?? [])].sort();
}

describe("control request validation", () => {
	test("requires an explicit stop/steer action", () => {
		expect(parseSubagentControl({})).toEqual({
			ok: false,
			error: 'Unknown subagent action undefined. Use "stop" or "steer".',
		});
		expect(parseSubagentControl({ action: "pause" }).ok).toBe(false);
	});

	test("rejects every dispatch-only field mixed with a control action", () => {
		const dispatchFields: Array<Record<string, unknown>> = [
			{ agent: "worker" },
			{ task: "do it" },
			{ tasks: [] },
			{ chain: [] },
			{ execution: "async" },
			{ cwd: "/tmp" },
			{ agentScope: "user" },
			{ confirmProjectAgents: true },
		];
		for (const field of dispatchFields) {
			const result = parseSubagentControl({ action: "stop", dispatchId: "d-1", ...field });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("dispatch fields");
		}
	});

	test("requires exactly one of dispatchId or runId (trimmed)", () => {
		expect(parseSubagentControl({ action: "stop" }).ok).toBe(false);
		expect(parseSubagentControl({ action: "stop", dispatchId: "   " }).ok).toBe(false);
		expect(parseSubagentControl({ action: "stop", dispatchId: "d-1", runId: "sa-1" }).ok).toBe(false);
	});

	test("requires a non-empty steer message", () => {
		expect(parseSubagentControl({ action: "steer", runId: "sa-1" }).ok).toBe(false);
		expect(parseSubagentControl({ action: "steer", runId: "sa-1", message: "   " }).ok).toBe(false);
	});

	test("parses stop and steer targets, trimming ids but preserving the message", () => {
		expect(parseSubagentControl({ action: "stop", dispatchId: "  d-1  " })).toEqual({
			ok: true,
			request: { action: "stop", target: { kind: "dispatch", dispatchId: "d-1" } },
		});
		expect(parseSubagentControl({ action: "steer", runId: " sa-1 ", message: " focus on auth " })).toEqual({
			ok: true,
			request: { action: "steer", target: { kind: "run", runId: "sa-1" }, message: " focus on auth " },
		});
	});

	test("isSubagentControlRequest only matches a present action", () => {
		expect(isSubagentControlRequest({})).toBe(false);
		expect(isSubagentControlRequest({ action: undefined })).toBe(false);
		expect(isSubagentControlRequest({ action: null })).toBe(false);
		expect(isSubagentControlRequest({ action: "stop" })).toBe(true);
	});
});

describe("stop control", () => {
	test("stops one run through its stop handle and derives its execution metadata", async () => {
		let aborted = 0;
		const run = makeRun({ runId: "sa-1", execution: "blocking", abort: () => aborted++ });
		const { runtime } = createRuntime([run]);

		const result = await executeSubagentControl({ action: "stop", target: { kind: "run", runId: "sa-1" } }, runtime);

		expect(aborted).toBe(1);
		expect(result.details.control).toMatchObject({ action: "stop", targetKind: "run", targetId: "sa-1", runIds: ["sa-1"] });
		expect(result.details.execution).toBe("blocking");
		expect(result.details.dispatchStatus).toBeUndefined();
		expect(textOf(result)).toContain("sa-1");
	});

	test("repeated stop still reaches the run so it can escalate", async () => {
		const calls: string[] = [];
		const run = makeRun({ runId: "sa-1", abort: () => calls.push("request") });
		const { runtime } = createRuntime([run]);

		await executeSubagentControl({ action: "stop", target: { kind: "run", runId: "sa-1" } }, runtime);
		await executeSubagentControl({ action: "stop", target: { kind: "run", runId: "sa-1" } }, runtime);

		expect(calls).toEqual(["request", "request"]);
	});

	test("throws for an unknown run and for a finished run", async () => {
		const finished = makeRun({ runId: "sa-done", completedAt: Date.now() });
		const { runtime } = createRuntime([finished]);

		await expect(
			executeSubagentControl({ action: "stop", target: { kind: "run", runId: "missing" } }, runtime),
		).rejects.toThrow("missing");

		await expect(
			executeSubagentControl({ action: "stop", target: { kind: "run", runId: "sa-done" } }, runtime),
		).rejects.toThrow("already finished");
	});

	test("stops every active run of a dispatch and aborts the manager controller", async () => {
		const aborts: string[] = [];
		const runs = [
			makeRun({ runId: "sa-1", dispatchId: "d-1", execution: "async", abort: () => aborts.push("sa-1") }),
			makeRun({ runId: "sa-2", dispatchId: "d-1", execution: "async", abort: () => aborts.push("sa-2") }),
			makeRun({ runId: "sa-done", dispatchId: "d-1", completedAt: Date.now(), abort: () => aborts.push("sa-done") }),
			makeRun({ runId: "sa-other", dispatchId: "d-other", abort: () => aborts.push("sa-other") }),
		];
		const { runtime, abortedDispatches } = createRuntime(runs);

		const result = await executeSubagentControl(
			{ action: "stop", target: { kind: "dispatch", dispatchId: "d-1" } },
			runtime,
		);

		expect(abortedDispatches).toEqual(["d-1"]);
		expect([...aborts].sort()).toEqual(["sa-1", "sa-2"]);
		expect(sortedRunIds(result)).toEqual(["sa-1", "sa-2"]);
		expect(result.details.execution).toBe("async");
		expect(textOf(result)).toContain("aborted");
	});

	test("omits execution metadata when the targeted runs disagree", async () => {
		const runs = [
			makeRun({ runId: "sa-1", dispatchId: "d-1", execution: "async", abort: () => {} }),
			makeRun({ runId: "sa-2", dispatchId: "d-1", execution: "blocking", abort: () => {} }),
		];
		const { runtime } = createRuntime(runs);
		const result = await executeSubagentControl(
			{ action: "stop", target: { kind: "dispatch", dispatchId: "d-1" } },
			runtime,
		);
		expect(result.details.execution).toBeUndefined();
	});

	test("stops blocking runs when the manager does not own the dispatch", async () => {
		const aborts: string[] = [];
		const runs = [makeRun({ runId: "sa-1", dispatchId: "d-1", execution: "blocking", abort: () => aborts.push("sa-1") })];
		const { runtime } = createRuntime(runs, { abortDispatch: () => false });

		const result = await executeSubagentControl(
			{ action: "stop", target: { kind: "dispatch", dispatchId: "d-1" } },
			runtime,
		);

		expect(aborts).toEqual(["sa-1"]);
		expect(result.details.dispatchId).toBe("d-1");
	});

	test("throws when neither a manager handle nor a run matches", async () => {
		const { runtime } = createRuntime([], { abortDispatch: () => false });
		await expect(
			executeSubagentControl({ action: "stop", target: { kind: "dispatch", dispatchId: "d-missing" } }, runtime),
		).rejects.toThrow("d-missing");
	});
});

describe("steer control", () => {
	test("delivers a message to one run", async () => {
		const run = makeRun({ runId: "sa-1", execution: "async" });
		const { runtime, steers } = createRuntime([run]);

		const result = await executeSubagentControl(
			{ action: "steer", target: { kind: "run", runId: "sa-1" }, message: "focus" },
			runtime,
		);

		expect(steers).toEqual([{ runId: "sa-1", message: "focus" }]);
		expect(result.details.control).toMatchObject({ action: "steer", targetId: "sa-1", runIds: ["sa-1"] });
	});

	test("forwards the tool signal and RPC deadline to the steer transport", async () => {
		const run = makeRun({ runId: "sa-1" });
		const seen: Array<{ signal?: AbortSignal; timeoutMs?: number }> = [];
		const { runtime } = createRuntime([run], {
			steer: async (_run, _message, options) => {
				seen.push(options ?? {});
			},
		});
		const controller = new AbortController();
		await executeSubagentControl(
			{ action: "steer", target: { kind: "run", runId: "sa-1" }, message: "x" },
			runtime,
			{ signal: controller.signal, timeoutMs: 1234 },
		);
		expect(seen).toEqual([{ signal: controller.signal, timeoutMs: 1234 }]);
	});

	test("rejects before steering when the tool signal is already aborted", async () => {
		const run = makeRun({ runId: "sa-1" });
		const { runtime, steers } = createRuntime([run]);
		const controller = new AbortController();
		controller.abort();
		await expect(
			executeSubagentControl(
				{ action: "steer", target: { kind: "run", runId: "sa-1" }, message: "x" },
				runtime,
				{ signal: controller.signal },
			),
		).rejects.toThrow("aborted");
		expect(steers).toEqual([]);
	});

	test("throws a transport failure and unknown/finished runs", async () => {
		const runs = [makeRun({ runId: "sa-1" }), makeRun({ runId: "sa-done", completedAt: Date.now() })];
		const { runtime } = createRuntime(runs, {
			steer: async () => {
				throw new Error("Run is no longer active");
			},
		});

		await expect(
			executeSubagentControl({ action: "steer", target: { kind: "run", runId: "sa-1" }, message: "x" }, runtime),
		).rejects.toThrow("Run is no longer active");

		await expect(
			executeSubagentControl({ action: "steer", target: { kind: "run", runId: "nope" }, message: "x" }, runtime),
		).rejects.toThrow("nope");

		await expect(
			executeSubagentControl({ action: "steer", target: { kind: "run", runId: "sa-done" }, message: "x" }, runtime),
		).rejects.toThrow("already finished");
	});

	test("broadcasts a dispatch steer to every active run only", async () => {
		const runs = [
			makeRun({ runId: "sa-1", dispatchId: "d-1" }),
			makeRun({ runId: "sa-2", dispatchId: "d-1" }),
			makeRun({ runId: "sa-done", dispatchId: "d-1", completedAt: Date.now() }),
			makeRun({ runId: "sa-other", dispatchId: "d-2" }),
		];
		const { runtime, steers } = createRuntime(runs);

		const result = await executeSubagentControl(
			{ action: "steer", target: { kind: "dispatch", dispatchId: "d-1" }, message: "go" },
			runtime,
		);

		expect(steers.map((item) => item.runId).sort()).toEqual(["sa-1", "sa-2"]);
		expect(sortedRunIds(result)).toEqual(["sa-1", "sa-2"]);
	});

	test("keeps partial dispatch delivery as success and records failures", async () => {
		const runs = [makeRun({ runId: "sa-1", dispatchId: "d-1" }), makeRun({ runId: "sa-2", dispatchId: "d-1" })];
		const { runtime } = createRuntime(runs, {
			steer: async (run) => {
				if (run.runId === "sa-2") throw new Error("exited");
			},
		});

		const result = await executeSubagentControl(
			{ action: "steer", target: { kind: "dispatch", dispatchId: "d-1" }, message: "go" },
			runtime,
		);

		expect(result.details.control?.runIds).toEqual(["sa-1"]);
		expect(result.details.control?.failures).toEqual([{ runId: "sa-2", error: "exited" }]);
		expect(textOf(result)).toContain("sa-2");
	});

	test("throws when no active run can be steered", async () => {
		const runs = [makeRun({ runId: "sa-1", dispatchId: "d-1" })];
		const { runtime } = createRuntime(runs, {
			steer: async () => {
				throw new Error("gone");
			},
		});

		await expect(
			executeSubagentControl({ action: "steer", target: { kind: "dispatch", dispatchId: "d-1" }, message: "go" }, runtime),
		).rejects.toThrow("gone");

		await expect(
			executeSubagentControl({ action: "steer", target: { kind: "dispatch", dispatchId: "d-empty" }, message: "go" }, runtime),
		).rejects.toThrow("d-empty");
	});
});

describe("control surface", () => {
	test("a control result is never surfaced as completed history", async () => {
		const run = makeRun({ runId: "sa-1", abort: () => {} });
		const { runtime } = createRuntime([run]);
		const result = await executeSubagentControl({ action: "stop", target: { kind: "run", runId: "sa-1" } }, runtime);

		const entries = persistedAgentLogEntries([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					toolCallId: "call-control",
					timestamp: Date.now(),
					details: result.details,
				},
			},
		]);
		expect(entries).toEqual([]);
	});

	test("renders control calls with their target and a bounded steer preview", () => {
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		expect(formatControlCall({ action: "stop", runId: "sa-1" }, theme)).toBe("subagent stop run sa-1");
		expect(formatControlCall({ action: "steer", dispatchId: "d-1", message: "focus" }, theme)).toBe(
			"subagent steer dispatch d-1\n  focus",
		);
		expect(formatControlCall({ action: "stop" }, theme)).toContain("?(missing target)");

		const long = "x".repeat(80);
		const rendered = formatControlCall({ action: "steer", runId: "sa-1", message: long }, theme);
		expect(rendered).toContain(`${"x".repeat(60)}...`);
		expect(rendered).not.toContain(long);
	});

	test("steer reaches the child over the real registry + native RPC transport", async () => {
		const registry = new SubagentRegistry(30);
		const seen: RpcCommand[] = [];
		const run = makeRun({
			runId: "sa-1",
			execution: "async",
			child: stubChild((command) => {
				seen.push(command);
				return { type: "response", command: "steer", success: true };
			}),
		});
		registry.start(run);

		const runtime: SubagentControlRuntime = {
			runs: () => registry.list(),
			getRun: (runId) => registry.get(runId),
			abortDispatch: () => false,
			steer: (target, message, options) => sendSteer(target, message, options),
		};

		const result = await executeSubagentControl(
			{ action: "steer", target: { kind: "run", runId: "sa-1" }, message: "focus on auth" },
			runtime,
		);

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ type: "steer", message: "focus on auth" });
		expect(result.details.control?.runIds).toEqual(["sa-1"]);
	});
});

// --- lifecycle integration -------------------------------------------------

const usage = emptyUsage();

function preparedDispatch(overrides: Partial<PreparedSubagentDispatch> = {}): PreparedSubagentDispatch {
	return {
		dispatchId: "d-1",
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

/**
 * Runner mirroring `runSingleAgent`'s per-run stop wiring: a `RunStopController`
 * is chained to the dispatch signal, registered with the registry, and throws
 * `SubagentAbortError` once stopped. `completes` lets a test mark a sibling as
 * finishing normally.
 */
function controlledRunner(
	registry: SubagentRegistry,
	options: { dispatchId?: string; completes?: (runId: string) => boolean } = {},
): DispatchRuntimeDependencies {
	const dispatchId = options.dispatchId ?? "d-1";
	return {
		runSingle: async (request: SingleRunRequest): Promise<SingleResult> => {
			const current: SingleResult = {
				agent: request.agent,
				agentSource: "user",
				task: request.task,
				cwd: request.cwd ?? "/tmp/repo",
				exitCode: -1,
				messages: [],
				stderr: "",
				usage,
				runId: request.runId,
				state: "running",
			};
			let release!: () => void;
			const finished = new Promise<void>((resolve) => {
				release = resolve;
			});
			let aborted = false;
			const stop = new RunStopController(
				{
					requestAbort: () => {
						aborted = true;
						release();
					},
					terminate: () => {
						aborted = true;
						release();
					},
				},
				{ graceMs: 5, onAbort: () => (current.state = "aborting") },
			);
			const onSignalAbort = () => {
				if (!stop.stopped) stop.request();
			};
			if (request.signal) {
				if (request.signal.aborted) onSignalAbort();
				else request.signal.addEventListener("abort", onSignalAbort, { once: true });
			}
			registry.start({
				runId: request.runId,
				agentName: request.agent,
				task: request.task,
				cwd: request.cwd ?? "/tmp/repo",
				startedAt: Date.now(),
				result: current,
				dispatchId,
				execution: "async",
				abort: () => stop.request(),
			});
			try {
				if (options.completes?.(request.runId)) {
					current.exitCode = 0;
					current.state = "settled";
					return current;
				}
				await finished;
				if (aborted) throw new SubagentAbortError(current);
				current.exitCode = 0;
				return current;
			} finally {
				request.signal?.removeEventListener("abort", onSignalAbort);
				stop.dispose();
				registry.complete(request.runId);
			}
		},
	};
}

interface Delivered {
	message: SubagentCompletionMessage;
	options: CompletionDeliveryOptions;
}

function createLifecycle(): {
	registry: SubagentRegistry;
	manager: AsyncDispatchManager;
	delivered: Delivered[];
	runtime: SubagentControlRuntime;
} {
	const registry = new SubagentRegistry(30);
	const delivered: Delivered[] = [];
	const manager = new AsyncDispatchManager({
		deliver: (message, options) => delivered.push({ message, options }),
	});
	const runtime: SubagentControlRuntime = {
		runs: () => registry.list(),
		getRun: (runId) => registry.get(runId),
		abortDispatch: (dispatchId) => manager.abort(dispatchId),
		steer: async () => {},
	};
	return { registry, manager, delivered, runtime };
}

describe("stop through the detached lifecycle", () => {
	test("stopping one run completes its registry entry and delivers an aborted aggregate", async () => {
		const { registry, manager, delivered, runtime } = createLifecycle();
		const dispatch = preparedDispatch();
		const handle = manager.start(dispatch, (signal) =>
			runPreparedDispatch(dispatch, controlledRunner(registry), signal, undefined),
		);

		// The registry entry is created synchronously as the run starts.
		expect(registry.get("sa-1")).toBeDefined();

		const result = await executeSubagentControl({ action: "stop", target: { kind: "run", runId: "sa-1" } }, runtime);

		await handle?.promise;

		expect(registry.get("sa-1")?.completedAt).toBeDefined();
		expect(manager.size).toBe(0);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.details?.dispatchStatus).toBe("aborted");
		expect(delivered[0]?.message.details?.results[0]?.stopReason).toBe("aborted");
		expect(delivered[0]?.message.content).toContain("sa-1");
	});

	test("stopping a dispatch aborts its controller and still delivers exactly one aborted aggregate", async () => {
		const { registry, manager, delivered, runtime } = createLifecycle();
		const dispatch = preparedDispatch({
			mode: "parallel",
			items: [
				{ runId: "sa-1", agent: "worker", task: "one" },
				{ runId: "sa-2", agent: "worker", task: "two" },
			],
		});
		const handle = manager.start(dispatch, (signal) =>
			runPreparedDispatch(dispatch, controlledRunner(registry), signal, undefined),
		);

		const result = await executeSubagentControl(
			{ action: "stop", target: { kind: "dispatch", dispatchId: "d-1" } },
			runtime,
		);
		expect(sortedRunIds(result)).toEqual(["sa-1", "sa-2"]);

		await handle?.promise;

		expect(registry.get("sa-1")?.completedAt).toBeDefined();
		expect(registry.get("sa-2")?.completedAt).toBeDefined();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.message.details?.dispatchStatus).toBe("aborted");
	});

	test("stopping one sibling leaves the other running to completion", async () => {
		const { registry, manager, delivered, runtime } = createLifecycle();
		const dispatch = preparedDispatch({
			mode: "parallel",
			items: [
				{ runId: "sa-1", agent: "worker", task: "one" },
				{ runId: "sa-2", agent: "worker", task: "two" },
			],
		});
		const handle = manager.start(dispatch, (signal) =>
			runPreparedDispatch(dispatch, controlledRunner(registry, { completes: (runId) => runId === "sa-2" }), signal, undefined),
		);

		const result = await executeSubagentControl({ action: "stop", target: { kind: "run", runId: "sa-1" } }, runtime);

		await handle?.promise;
		expect(delivered).toHaveLength(1);
		const results = delivered[0]?.message.details?.results ?? [];
		const sibling = results.find((item) => item.runId === "sa-2");
		expect(sibling?.exitCode).toBe(0);
		expect(sibling?.stopReason).not.toBe("aborted");
		expect(registry.get("sa-2")?.completedAt).toBeDefined();
	});

	test("a normal dispatch without action is not a control request", () => {
		// The execute branch keys off this predicate, so a dispatch-shaped call
		// keeps its existing prepare/run path.
		const dispatchCall: { action?: unknown; agent: string; task: string } = { agent: "worker", task: "do it" };
		expect(isSubagentControlRequest(dispatchCall)).toBe(false);
	});
});
