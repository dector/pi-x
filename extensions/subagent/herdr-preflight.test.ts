/**
 * Stage 4 tests for Herdr detection, preflight validation, and the pane bridge
 * launcher. A minimal fake client/tab lets every predictable failure path be
 * exercised without a live Herdr server.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { HerdrClient, HerdrEnvironment } from "./herdr-client.ts";
import type { ParentHerdrTab } from "./herdr-tab.ts";
import {
	assertHerdrBridgeAvailable,
	createHerdrBridgeLauncher,
	preflightHerdr,
	resolveHerdrBridgeRuntime,
	shellQuote,
} from "./herdr-preflight.ts";

const BASE_ENV: NodeJS.ProcessEnv = {
	HERDR_ENV: "1",
	HERDR_SOCKET_PATH: "/tmp/herdr.sock",
	HERDR_PANE_ID: "w1:p1",
	HERDR_WORKSPACE_ID: "w1",
};

function fakeTab(overrides: Partial<ParentHerdrTab> = {}): ParentHerdrTab {
	return {
		ensureTab: async () => "w1:t1",
		acquire: async () => {
			throw new Error("not used");
		},
		focus: async () => {},
		dispose: async () => {},
		...overrides,
	} as ParentHerdrTab;
}

function fakeClient(overrides: Partial<HerdrClient> = {}): HerdrClient {
	return {
		environment: {} as HerdrEnvironment,
		ping: async () => ({ version: "0.9.1", protocol: 22 }),
		assertCompatible: async () => ({ version: "0.9.1", protocol: 22 }),
		getPane: async (paneId: string) => ({ paneId }) as never,
		...overrides,
	} as unknown as HerdrClient;
}

describe("preflightHerdr", () => {
	test("fails clearly when not running inside Herdr", async () => {
		const result = await preflightHerdr({
			env: {},
			createTab: () => fakeTab(),
			createClient: () => fakeClient(),
			assertBridgeAvailable: () => {},
			resolveExecutable: () => "/usr/bin/herdr",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("not_detected");
		expect(result.error).toContain("HERDR_ENV");
	});

	test("fails when the herdr executable is missing", async () => {
		const result = await preflightHerdr({
			env: BASE_ENV,
			createTab: () => fakeTab(),
			createClient: () => fakeClient(),
			assertBridgeAvailable: () => {},
			resolveExecutable: () => undefined,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("executable_missing");
	});

	test("fails when the pane bridge runtime is unavailable", async () => {
		const result = await preflightHerdr({
			env: BASE_ENV,
			createTab: () => fakeTab(),
			createClient: () => fakeClient(),
			assertBridgeAvailable: () => {
				throw new Error("the Bun runtime is required");
			},
			resolveExecutable: () => "/usr/bin/herdr",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("bridge_unavailable");
		expect(result.error).toContain("Bun runtime");
	});

	test("fails clearly when the server is unreachable", async () => {
		const result = await preflightHerdr({
			env: BASE_ENV,
			createTab: () => fakeTab(),
			createClient: () =>
				fakeClient({
					assertCompatible: async () => {
						throw new Error("connection refused");
					},
				}),
			assertBridgeAvailable: () => {},
			resolveExecutable: () => "/usr/bin/herdr",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("unreachable");
		expect(result.error).toContain("connection refused");
	});

	test("fails clearly when the parent pane is missing", async () => {
		const result = await preflightHerdr({
			env: BASE_ENV,
			createTab: () => fakeTab(),
			createClient: () =>
				fakeClient({
					getPane: async () => {
						throw new Error("pane not found");
					},
				}),
			assertBridgeAvailable: () => {},
			resolveExecutable: () => "/usr/bin/herdr",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("missing_parent");
		expect(result.error).toContain("w1:p1");
	});

	test("fails clearly when tab preparation fails", async () => {
		const result = await preflightHerdr({
			env: BASE_ENV,
			createTab: () =>
				fakeTab({
					ensureTab: async () => {
						throw new Error("split failed");
					},
				}),
			createClient: () => fakeClient(),
			assertBridgeAvailable: () => {},
			resolveExecutable: () => "/usr/bin/herdr",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("pane_unavailable");
	});

	test("returns the environment, client, and prepared tab on success", async () => {
		const tab = fakeTab();
		const result = await preflightHerdr({
			env: BASE_ENV,
			createTab: () => tab,
			createClient: () => fakeClient(),
			assertBridgeAvailable: () => {},
			resolveExecutable: () => "/usr/bin/herdr",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.environment.paneId).toBe("w1:p1");
		expect(result.tab).toBe(tab);
	});

	test("reuses an existing session tab without creating another", async () => {
		const tab = fakeTab();
		const client = fakeClient();
		let created = 0;
		const environment: HerdrEnvironment = {
			socketPath: BASE_ENV.HERDR_SOCKET_PATH as string,
			paneId: BASE_ENV.HERDR_PANE_ID as string,
			workspaceId: BASE_ENV.HERDR_WORKSPACE_ID as string,
		};
		const result = await preflightHerdr({
			env: BASE_ENV,
			existing: { environment, client, tab },
			createTab: () => {
				created += 1;
				return fakeTab();
			},
			createClient: () => {
				created += 1;
				return fakeClient();
			},
			assertBridgeAvailable: () => {},
			resolveExecutable: () => "/usr/bin/herdr",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.tab).toBe(tab);
		expect(result.client).toBe(client);
		expect(created).toBe(0);
	});
});

describe("resolveHerdrBridgeRuntime", () => {
	test("prefers a bun process.execPath", () => {
		const runtime = resolveHerdrBridgeRuntime({ PATH: "" }, { isExecutable: (path) => path === process.execPath });
		if (/^bun(\.exe)?$/i.test(process.execPath.split("/").pop() ?? "")) {
			expect(runtime).toBe(process.execPath);
		} else {
			// Non-bun test runtime: there is no bun on an empty PATH.
			expect(runtime).toBeUndefined();
		}
	});

	test("finds bun on PATH", () => {
		const dir = "/opt/tools/bin";
		const runtime = resolveHerdrBridgeRuntime(
			{ PATH: `${dir}:/usr/bin` },
			{ isExecutable: (path) => path === join(dir, "bun") },
		);
		expect(runtime).toBe(join(dir, "bun"));
	});

	test("returns undefined when no runtime is executable", () => {
		expect(resolveHerdrBridgeRuntime({ PATH: "/nope" }, { isExecutable: () => false })).toBeUndefined();
	});
});

describe("assertHerdrBridgeAvailable", () => {
	test("throws when the entry point is missing", () => {
		expect(() =>
			assertHerdrBridgeAvailable({ bridgeMainPath: "/does/not/exist.ts", resolveRuntime: () => "bun" }),
		).toThrow(/not found/);
	});

	test("throws when no runtime is available", () => {
		expect(() =>
			assertHerdrBridgeAvailable({
				bridgeMainPath: join(import.meta.dir, "herdr-preflight.ts"),
				resolveRuntime: () => undefined,
			}),
		).toThrow(/Bun runtime/);
	});

	test("passes when the entry point and runtime exist", () => {
		expect(() =>
			assertHerdrBridgeAvailable({
				bridgeMainPath: join(import.meta.dir, "herdr-preflight.ts"),
				resolveRuntime: () => "bun",
			}),
		).not.toThrow();
	});
});

describe("createHerdrBridgeLauncher", () => {
	test("shell-quotes only when needed", () => {
		expect(shellQuote("/tmp/plain-path")).toBe("/tmp/plain-path");
		expect(shellQuote("/tmp/with space")).toBe("'/tmp/with space'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	test("types the bootstrap command into the pane and presses Enter", async () => {
		const sent: Array<{ kind: string; value: unknown }> = [];
		const launcher = createHerdrBridgeLauncher({
			client: {
				sendText: async (paneId, text) => {
					sent.push({ kind: "text", value: { paneId, text } });
				},
				sendKeys: async (paneId, keys) => {
					sent.push({ kind: "keys", value: { paneId, keys } });
				},
			},
			env: {},
			bridgeMainPath: "/bridge/main.ts",
			resolveRuntime: () => "bun",
		});
		await launcher.launch("w1:p9", { socketPath: "/tmp/s.sock", tokenFile: "/tmp/tok", token: "secret" });
		expect(sent[0]).toEqual({
			kind: "text",
			value: { paneId: "w1:p9", text: "bun /bridge/main.ts --socket /tmp/s.sock --token-file /tmp/tok" },
		});
		expect(sent[1]).toEqual({ kind: "keys", value: { paneId: "w1:p9", keys: ["Enter"] } });
		// The one-time token value is never placed on the command line.
		expect(JSON.stringify(sent)).not.toContain("secret");
	});
});
