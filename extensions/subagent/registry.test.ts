import { expect, test } from "bun:test";
import { sendControl, sendSteer, SubagentRegistry, type SubagentRunRuntime } from "./registry.ts";
import type { RpcChild } from "./rpc-client.ts";
import type { RpcCommand, RpcResponse } from "./types.ts";
import { emptyUsage } from "./events.ts";

function run(id: string) {
	return {
		runId: id,
		agentName: "worker",
		task: id,
		cwd: "/tmp",
		startedAt: Date.now(),
		result: { agent: "worker", agentSource: "user" as const, task: id, exitCode: 0, messages: [], stderr: "", usage: emptyUsage() },
	};
}

function stubChild(
	handler: (command: RpcCommand, timeoutMs: number) => RpcResponse,
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

function runWithChild(id: string, child: RpcChild, overrides: Partial<SubagentRunRuntime> = {}): SubagentRunRuntime {
	return { ...run(id), child, ...overrides };
}

test("registry orders active runs first and bounds completed history", () => {
	const registry = new SubagentRegistry(1);
	registry.start(run("one"));
	registry.complete("one");
	registry.start(run("two"));
	registry.complete("two");
	registry.start(run("active"));
	expect(registry.list().map((item) => item.runId)).toEqual(["active", "two"]);
	registry.complete("active");
	registry.complete("active");
	expect(registry.list()).toHaveLength(1);
});

test("registry notifies on start and on each completion", () => {
	const changes: number[] = [];
	const registry = new SubagentRegistry(30, () => changes.push(registry.list().filter((item) => !item.completedAt).length));
	registry.start(run("one"));
	registry.start(run("two"));
	registry.complete("one");
	registry.complete("one");
	registry.complete("two");
	expect(changes).toEqual([1, 2, 1, 0]);
});

test("sendSteer sends the native steer command and surfaces child rejection", async () => {
	const seen: RpcCommand[] = [];
	const run = runWithChild(
		"sa-1",
		stubChild((command) => {
			seen.push(command);
			return { type: "response", command: "steer", success: true };
		}),
	);
	await sendSteer(run, "focus on auth");
	expect(seen).toHaveLength(1);
	expect(seen[0]).toMatchObject({ type: "steer", message: "focus on auth" });

	const rejected = runWithChild("sa-2", stubChild(() => ({ type: "response", command: "steer", success: false, error: "not streaming" })));
	await expect(sendSteer(rejected, "x")).rejects.toThrow("not streaming");
});

test("sendSteer and sendControl refuse an inactive run", async () => {
	await expect(sendSteer(runWithChild("sa-1", stubChild(() => ({ type: "response", command: "steer", success: true })), { completedAt: Date.now() }), "x")).rejects.toThrow(
		"no longer active",
	);
	await expect(sendControl(run("sa-2") as SubagentRunRuntime, "pause")).rejects.toThrow("no longer active");
});

test("sendSteer refuses an already-aborted signal without contacting the child", async () => {
	const seen: RpcCommand[] = [];
	const run = runWithChild(
		"sa-1",
		stubChild((command) => {
			seen.push(command);
			return { type: "response", command: "steer", success: true };
		}),
	);
	const controller = new AbortController();
	controller.abort();
	await expect(sendSteer(run, "x", { signal: controller.signal })).rejects.toThrow("aborted");
	expect(seen).toHaveLength(0);
});

test("sendSteer stops waiting when the parent signal fires mid-request", async () => {
	const child = stubChild(() => ({ type: "response", command: "steer", success: true }));
	child.request = () => new Promise<RpcResponse>(() => {});
	const run = runWithChild("sa-1", child);
	const controller = new AbortController();
	const pending = sendSteer(run, "x", { signal: controller.signal });
	controller.abort();
	await expect(pending).rejects.toThrow("aborted");
});

test("sendControl still accepts a numeric timeout", async () => {
	let seenTimeout = 0;
	const run = runWithChild(
		"sa-1",
		stubChild((_command, timeoutMs) => {
			seenTimeout = timeoutMs;
			return { type: "response", command: "prompt", success: true };
		}),
	);
	await sendControl(run, "pause", 1234);
	expect(seenTimeout).toBe(1234);
});
