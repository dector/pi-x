import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HerdrSubagentBackend, ProcessSubagentBackend, retainedHerdrLocation } from "./backend.ts";
import type { HerdrBridgeBootstrap } from "./herdr-bridge.ts";
import type { HerdrAcquireOptions, HerdrPaneLease, ParentHerdrTab } from "./herdr-tab.ts";
import type { RpcChild, RpcChildEvents, RpcExit } from "./rpc-client.ts";
import type { PreparedDispatchItem, RpcCommand, RpcExtensionUiResponse, RpcResponse, RpcStreamEvent } from "./types.ts";

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

function fakeRpcChild(): RpcChild {
	return {
		pid: 4242,
		exited: false,
		stderr: "",
		exit: Promise.resolve<RpcExit>({ code: 0, signal: null }),
		request: async (command: RpcCommand) => ({ id: command.id, type: "response", command: command.type, success: true }),
		send: (_command: RpcCommand | RpcExtensionUiResponse) => {},
		respondUi: (_response: RpcExtensionUiResponse) => {},
		terminate: async () => {},
	};
}

function fakeLease(
	released: string[],
	paneId = "w1:p2",
	releaseOptions: Array<{ retain?: boolean }> = [],
): HerdrPaneLease {
	return {
		tabId: "w1:t1",
		paneId,
		runId: "sa-1",
		get retained() {
			return released.includes("success") || released.includes("failed") || released.includes("aborted");
		},
		release: async (outcome, options) => {
			released.push(outcome);
			releaseOptions.push({ retain: options?.retain });
		},
	};
}

function fakeHerdrTab(
	lease: HerdrPaneLease,
	acquired: Array<{ run: PreparedDispatchItem; options?: HerdrAcquireOptions }>,
): ParentHerdrTab {
	return {
		ensureTab: async () => "w1:t1",
		probe: async () => {},
		acquire: async (run, options) => {
			acquired.push({ run, options });
			return lease;
		},
		focus: async () => {},
		focusLocation: async () => {},
		closeRetainedLocation: async () => false,
		paneStatus: async () => "active",
		dispose: async () => {},
	};
}

describe("HerdrSubagentBackend", () => {
	test("leases a pane, launches the bridge, and releases with the run outcome", async () => {
		const released: string[] = [];
		const acquired: Array<{ run: PreparedDispatchItem; options?: HerdrAcquireOptions }> = [];
		let launched: { paneId: string; bootstrap: HerdrBridgeBootstrap } | undefined;
		let childOptions: { display?: unknown } | undefined;
		const backend = new HerdrSubagentBackend({
			tab: fakeHerdrTab(fakeLease(released), acquired),
			launcher: {
				assertAvailable: () => {},
				launch: async (paneId, bootstrap) => {
					launched = { paneId, bootstrap };
				},
			},
			createChild: async (options) => {
				childOptions = options;
				await options.launch({ socketPath: "/tmp/s.sock", tokenFile: "/tmp/tok", token: "secret" });
				return fakeRpcChild();
			},
		});

		const child = await backend.spawn(
			{ command: "pi", args: ["--mode", "rpc"], cwd: "/work", events: events() },
			{ runId: "sa-1", dispatchId: "dispatch-1", agent: "worker", task: "do it", herdrRetention: "always" },
		);

		expect(backend.kind).toBe("herdr");
		expect(acquired[0]?.run).toMatchObject({ runId: "sa-1", agent: "worker", task: "do it" });
		expect(acquired[0]?.options?.retention).toBe("always");
		expect(launched?.paneId).toBe("w1:p2");
		expect(launched?.bootstrap.socketPath).toBe("/tmp/s.sock");
		expect(childOptions?.display).toEqual({
			agent: "worker",
			runId: "sa-1",
			dispatchId: "dispatch-1",
			retention: "always",
		});
		expect(child.herdr).toMatchObject({ tabId: "w1:t1", paneId: "w1:p2" });
		await child.release?.("success");
		expect(released).toEqual(["success"]);
		expect(child.herdr?.retained).toBe(true);
	});

	test("releases the pane as failed when the bridge launch throws", async () => {
		const released: string[] = [];
		const releaseOptions: Array<{ retain?: boolean }> = [];
		const acquired: Array<{ run: PreparedDispatchItem; options?: HerdrAcquireOptions }> = [];
		const backend = new HerdrSubagentBackend({
			tab: fakeHerdrTab(fakeLease(released, "w1:p2", releaseOptions), acquired),
			launcher: { assertAvailable: () => {}, launch: async () => {} },
			createChild: async () => {
				throw new Error("bridge boom");
			},
		});

		await expect(
			backend.spawn(
				{ command: "pi", args: [], cwd: "/work", events: events() },
				{ runId: "sa-1", dispatchId: "dispatch-1", agent: "worker" },
			),
		).rejects.toThrow("bridge boom");
		expect(released).toEqual(["failed"]);
		// The bridge never launched, so the empty pane must not be retained.
		expect(releaseOptions).toEqual([{ retain: false }]);
	});

	test("forwards a chain key so chain steps can share one pane", async () => {
		const released: string[] = [];
		const acquired: Array<{ run: PreparedDispatchItem; options?: HerdrAcquireOptions }> = [];
		const backend = new HerdrSubagentBackend({
			tab: fakeHerdrTab(fakeLease(released), acquired),
			launcher: { assertAvailable: () => {}, launch: async () => {} },
			createChild: async (options) => {
				await options.launch({ socketPath: "/tmp/s.sock", tokenFile: "/tmp/tok", token: "secret" });
				return fakeRpcChild();
			},
		});

		await backend.spawn(
			{ command: "pi", args: [], cwd: "/work", events: events() },
			{ runId: "sa-1", dispatchId: "dispatch-1", agent: "worker", chainKey: "dispatch-1" },
		);
		expect(acquired[0]?.options?.chainKey).toBe("dispatch-1");
	});
});

describe("retainedHerdrLocation", () => {
	test("keeps only a retained location and drops a recycled one", () => {
		expect(retainedHerdrLocation({ tabId: "w1:t1", paneId: "w1:p2", retained: true })).toEqual({
			tabId: "w1:t1",
			paneId: "w1:p2",
			retained: true,
		});
		expect(retainedHerdrLocation({ tabId: "w1:t1", paneId: "w1:p2", retained: false })).toBeUndefined();
		expect(retainedHerdrLocation(undefined)).toBeUndefined();
	});
});
