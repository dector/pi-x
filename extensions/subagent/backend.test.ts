import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ProcessSubagentBackend } from "./backend.ts";
import type { RpcChildEvents } from "./rpc-client.ts";
import type { RpcResponse, RpcStreamEvent } from "./types.ts";

const FAKE_CHILD = join(import.meta.dir, "fixtures/fake-rpc-child.mjs");

const children: Array<{ terminate(options?: { graceMs?: number }): Promise<void> }> = [];

afterEach(async () => {
	while (children.length > 0) {
		const child = children.pop();
		try {
			await child?.terminate({ graceMs: 50 });
		} catch {
			// Already gone.
		}
	}
});

function events(): RpcChildEvents {
	return {
		onStreamEvent: (_event: RpcStreamEvent) => {},
		onExtensionUiRequest: () => {},
	};
}

describe("ProcessSubagentBackend", () => {
	test("reports the process backend kind", () => {
		expect(new ProcessSubagentBackend().kind).toBe("process");
	});

	test("spawns a child that correlates RPC requests like the direct spawn", async () => {
		const backend = new ProcessSubagentBackend();
		const child = await backend.spawn(
			{
				command: process.execPath,
				args: [FAKE_CHILD],
				cwd: import.meta.dir,
				events: events(),
			},
			{ runId: "run-1", dispatchId: "dispatch-1", agent: "worker" },
		);
		children.push(child);
		const responses: RpcResponse[] = await Promise.all([
			child.request({ id: "one", type: "ping", value: 1 }, 1000),
			child.request({ id: "two", type: "ping", value: 2 }, 1000),
		]);
		expect(responses[0].success && responses[0].data).toBe(1);
		expect(responses[1].success && responses[1].data).toBe(2);
		expect(child.exited).toBe(false);
	});

	test("propagates child exit to pending requests", async () => {
		const backend = new ProcessSubagentBackend();
		const child = await backend.spawn(
			{
				command: process.execPath,
				args: [FAKE_CHILD, "exit"],
				cwd: import.meta.dir,
				events: events(),
			},
			{ runId: "run-2", dispatchId: "dispatch-2", agent: "worker" },
		);
		children.push(child);
		await expect(child.request({ id: "prompt", type: "prompt", message: "x" }, 1000)).rejects.toThrow(
			"exited before responding",
		);
		expect(child.exited).toBe(true);
	});
});
