/**
 * Stage 2 bridge tests.
 *
 * The parent transport is exercised two ways:
 *  - against the real `herdr-bridge-main.ts` process with a fake RPC child
 *    (end-to-end handshake, relaying, Unicode, exit, termination, transcript);
 *  - against a raw socket peer for malformed, oversize, and timeout paths that a
 *    well-behaved bridge would never produce.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HERDR_BRIDGE_PROTOCOL,
	createHerdrBridgeChild,
	encodeFrame,
	probeHerdrBridgeListener,
	signalPid,
	type HerdrBridgeBootstrap,
	type HerdrBridgeFrame,
} from "./herdr-bridge.ts";
import type { RpcChildEvents, RpcExit } from "./rpc-client.ts";
import type { RpcResponse, RpcStreamEvent } from "./types.ts";

const BRIDGE_MAIN = join(import.meta.dir, "herdr-bridge-main.ts");
const FAKE_CHILD = join(import.meta.dir, "fixtures/bridge-fake-child.mjs");

const spawnedBridges: ChildProcess[] = [];
const openSockets: Socket[] = [];
const bridgeStdout: string[] = [];

afterEach(() => {
	for (const proc of spawnedBridges.splice(0)) {
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const socket of openSockets.splice(0)) socket.destroy();
	bridgeStdout.length = 0;
});

interface RecordedEvents {
	stream: RpcStreamEvent[];
	ui: unknown[];
	stderr: string[];
	diagnostics: string[];
	exits: RpcExit[];
	responses: RpcResponse[];
}

function recordEvents(): { events: RecordedEvents; hooks: RpcChildEvents } {
	const events: RecordedEvents = { stream: [], ui: [], stderr: [], diagnostics: [], exits: [], responses: [] };
	const hooks: RpcChildEvents = {
		onStreamEvent: (event) => events.stream.push(event),
		onExtensionUiRequest: (request) => events.ui.push(request),
		onStderr: (text) => events.stderr.push(text),
		onProtocolDiagnostic: (message) => events.diagnostics.push(message),
		onExit: (info) => events.exits.push(info),
		onResponse: (response) => events.responses.push(response),
	};
	return { events, hooks };
}

function fakeSpawn(mode: string, extraEnv: Record<string, string> | undefined, hooks: RpcChildEvents) {
	return {
		command: process.execPath,
		args: [FAKE_CHILD, mode],
		cwd: import.meta.dir,
		env: extraEnv,
		events: hooks,
	};
}

/** Launch the real pane bridge as a child process. */
function launchRealBridge(bootstrap: HerdrBridgeBootstrap, extraArgs: string[] = []): Promise<void> {
	const proc = spawn(
		process.execPath,
		[BRIDGE_MAIN, "--socket", bootstrap.socketPath, "--token-file", bootstrap.tokenFile, ...extraArgs],
		{ cwd: import.meta.dir, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
	);
	spawnedBridges.push(proc);
	proc.stdout?.on("data", (chunk) => bridgeStdout.push(chunk.toString()));
	proc.stderr?.on("data", (chunk) => bridgeStdout.push(chunk.toString()));
	return Promise.resolve();
}

/** Connect a raw socket peer that runs `afterWelcome` once the parent sends it. */
function launchRawBridge(
	afterWelcome: (socket: Socket, bootstrap: HerdrBridgeBootstrap) => void,
	options: { token?: string } = {},
): (bootstrap: HerdrBridgeBootstrap) => Promise<void> {
	return (bootstrap) => {
		const socket = connect(bootstrap.socketPath);
		openSockets.push(socket);
		let buffer = "";
		socket.on("connect", () => {
			socket.write(
				encodeFrame({
					type: "hello",
					protocol: HERDR_BRIDGE_PROTOCOL,
					token: options.token ?? bootstrap.token,
					pid: process.pid,
				}),
			);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					const frame = JSON.parse(line) as HerdrBridgeFrame;
					if (frame.type === "welcome") afterWelcome(socket, bootstrap);
				} catch {
					// Ignore our own parsing errors.
				}
				newline = buffer.indexOf("\n");
			}
		});
		return Promise.resolve();
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for condition");
}

describe("createHerdrBridgeChild authentication and timeouts", () => {
	test("rejects a bridge that presents the wrong token and cleans up", async () => {
		const directory = mkdtempSync(join(tmpdir(), "herdr-bridge-auth-"));
		const { hooks } = recordEvents();
		await expect(
			createHerdrBridgeChild({
				directory,
				spawn: fakeSpawn("normal", undefined, hooks),
				connectTimeoutMs: 2000,
				handshakeTimeoutMs: 2000,
				launch: launchRawBridge(
					() => {},
					{ token: "wrong-token" },
				),
			}),
		).rejects.toThrow(/authentication/i);
		expect(existsSync(directory)).toBe(false);
	});

	test("times out when no bridge connects and cleans up", async () => {
		const directory = mkdtempSync(join(tmpdir(), "herdr-bridge-connect-"));
		const { hooks } = recordEvents();
		await expect(
			createHerdrBridgeChild({
				directory,
				spawn: fakeSpawn("normal", undefined, hooks),
				connectTimeoutMs: 60,
				launch: async () => {},
			}),
		).rejects.toThrow(/did not connect/i);
		expect(existsSync(directory)).toBe(false);
	});

	test("times out when the bridge connects but never authenticates", async () => {
		const directory = mkdtempSync(join(tmpdir(), "herdr-bridge-handshake-"));
		const { hooks } = recordEvents();
		await expect(
			createHerdrBridgeChild({
				directory,
				spawn: fakeSpawn("normal", undefined, hooks),
				connectTimeoutMs: 2000,
				handshakeTimeoutMs: 60,
				launch: (bootstrap) => {
					openSockets.push(connect(bootstrap.socketPath));
					return Promise.resolve();
				},
			}),
		).rejects.toThrow(/handshake timed out/i);
		expect(existsSync(directory)).toBe(false);
	});
});

describe("createHerdrBridgeChild relaying", () => {
	test("relays authenticated RPC requests and responses", async () => {
		const { hooks } = recordEvents();
		const child = await createHerdrBridgeChild({
			spawn: fakeSpawn("normal", undefined, hooks),
			connectTimeoutMs: 5000,
			handshakeTimeoutMs: 5000,
			launch: (bootstrap) => launchRealBridge(bootstrap),
		});
		const response = await child.request({ id: "r1", type: "ping", value: "héllo 😀" }, 3000);
		expect(response.success).toBe(true);
		if (response.success) expect(response.data).toBe("héllo 😀");
		expect(child.pid).toBeGreaterThan(0);
		await child.terminate({ graceMs: 300 });
		expect(child.exited).toBe(true);
	});

	test("preserves Unicode across chunk boundaries", async () => {
		const { events, hooks } = recordEvents();
		const child = await createHerdrBridgeChild({
			spawn: fakeSpawn("unicode", undefined, hooks),
			connectTimeoutMs: 5000,
			handshakeTimeoutMs: 5000,
			launch: (bootstrap) => launchRealBridge(bootstrap),
		});
		const response = await child.request({ id: "u1", type: "prompt", message: "x" }, 3000);
		expect(response.success).toBe(true);
		if (response.success) expect(response.data).toBe("😀 café ✓");
		await waitFor(() => events.stream.some((event) => event.type === "message_end"));
		const messageEnd = events.stream.find((event) => event.type === "message_end");
		expect(JSON.stringify(messageEnd)).toContain("héllo 😀 wörld");
		await child.terminate({ graceMs: 300 });
	});

	test("propagates stderr and child exit", async () => {
		const { events, hooks } = recordEvents();
		const child = await createHerdrBridgeChild({
			spawn: fakeSpawn("stderr", undefined, hooks),
			connectTimeoutMs: 5000,
			handshakeTimeoutMs: 5000,
			launch: (bootstrap) => launchRealBridge(bootstrap),
		});
		await expect(child.request({ id: "s1", type: "prompt" }, 3000)).rejects.toThrow(/exited before responding/);
		const info = await child.exit;
		expect(info.code).toBe(3);
		expect(child.stderr).toContain("child stderr line");
		expect(events.stderr.join("")).toContain("child stderr line");
		expect(events.exits).toEqual([expect.objectContaining({ code: 3 })]);
	});

	test("drops oversize child messages and reports a diagnostic", async () => {
		const { events, hooks } = recordEvents();
		const child = await createHerdrBridgeChild({
			spawn: fakeSpawn("oversize", undefined, hooks),
			connectTimeoutMs: 5000,
			handshakeTimeoutMs: 5000,
			launch: (bootstrap) => launchRealBridge(bootstrap, ["--max-rpc-line-bytes", "512"]),
		});
		const response = await child.request({ id: "o1", type: "prompt" }, 3000);
		expect(response.success).toBe(true);
		await waitFor(() => events.diagnostics.some((message) => /exceeded/i.test(message)));
		expect(events.stream.some((event) => event.type === "message_end")).toBe(false);
		await child.terminate({ graceMs: 300 });
	});

	test("reports malformed frames from the bridge", async () => {
		const { events, hooks } = recordEvents();
		const child = await createHerdrBridgeChild({
			spawn: fakeSpawn("normal", undefined, hooks),
			connectTimeoutMs: 2000,
			handshakeTimeoutMs: 2000,
			launch: launchRawBridge((socket) => socket.write("not json\n")),
		});
		await waitFor(() => events.diagnostics.some((message) => /malformed/i.test(message)));
		await child.terminate({ graceMs: 200 });
	});

	test("bounds oversize frames from the bridge", async () => {
		const { events, hooks } = recordEvents();
		const child = await createHerdrBridgeChild({
			spawn: fakeSpawn("normal", undefined, hooks),
			connectTimeoutMs: 2000,
			handshakeTimeoutMs: 2000,
			maxFrameBytes: 256,
			launch: launchRawBridge((socket) => socket.write(`${"x".repeat(2000)}\n`)),
		});
		await waitFor(() => events.diagnostics.some((message) => /exceeded/i.test(message)));
		await child.terminate({ graceMs: 200 });
	});
});

describe("createHerdrBridgeChild termination and socket loss", () => {
	test("escalates termination for a child that ignores SIGTERM", async () => {
		const directory = mkdtempSync(join(tmpdir(), "herdr-bridge-kill-"));
		const pidFile = join(directory, "child.pid");
		const { hooks } = recordEvents();
		const child = await createHerdrBridgeChild({
			spawn: fakeSpawn("hang", { FAKE_CHILD_PID_FILE: pidFile }, hooks),
			connectTimeoutMs: 5000,
			handshakeTimeoutMs: 5000,
			launch: (bootstrap) => launchRealBridge(bootstrap),
		});
		await waitFor(() => existsSync(pidFile));
		const childPid = Number(readFileSync(pidFile, "utf8"));
		expect(childPid).toBeGreaterThan(0);
		expect(isAlive(childPid)).toBe(true);
		await child.terminate({ graceMs: 300 });
		expect(child.exited).toBe(true);
		await waitFor(() => !isAlive(childPid));
	});

	test("resolves exit and rejects pending requests when the bridge dies", async () => {
		const directory = mkdtempSync(join(tmpdir(), "herdr-bridge-loss-"));
		const pidFile = join(directory, "child.pid");
		const { hooks } = recordEvents();
		const child = await createHerdrBridgeChild({
			spawn: fakeSpawn("silent", { FAKE_CHILD_PID_FILE: pidFile }, hooks),
			connectTimeoutMs: 5000,
			handshakeTimeoutMs: 5000,
			launch: (bootstrap) => launchRealBridge(bootstrap),
		});
		await waitFor(() => existsSync(pidFile));
		const childPid = Number(readFileSync(pidFile, "utf8"));
		const pending = child.request({ id: "p1", type: "prompt" }, 5000);
		// Kill the bridge process (simulates an unexpectedly lost pane/transport).
		spawnedBridges[spawnedBridges.length - 1].kill("SIGKILL");
		await expect(pending).rejects.toThrow();
		const info = await child.exit;
		expect(info.code).toBeNull();
		expect(child.exited).toBe(true);
		try {
			process.kill(childPid, "SIGKILL");
		} catch {
			// Already gone.
		}
	});
});

describe("bridge transcript", () => {
	test("renders a readable transcript and never prints raw protocol JSON", async () => {
		const { hooks } = recordEvents();
		const child = await createHerdrBridgeChild({
			spawn: fakeSpawn("normal", undefined, hooks),
			connectTimeoutMs: 5000,
			handshakeTimeoutMs: 5000,
			launch: (bootstrap) => launchRealBridge(bootstrap),
		});
		await child.request({ id: "t1", type: "prompt", message: "x" }, 3000);
		await waitFor(() => {
			const output = bridgeStdout.join("");
			return output.includes("✓ prompt") && output.includes("assistant: done");
		});
		const output = bridgeStdout.join("");
		expect(output).toContain("assistant: done");
		expect(output).not.toContain("BRIDGE_RAW_SENTINEL_9f3a");
		expect(output).not.toContain('"type":"response"');
		await child.terminate({ graceMs: 300 });
	});
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("probeHerdrBridgeListener", () => {
	test("binds the private listener and removes its directory", async () => {
		const parent = mkdtempSync(join(tmpdir(), "herdr-probe-test-"));
		const directory = join(parent, "bridge");
		try {
			await probeHerdrBridgeListener({ directory });
			expect(existsSync(directory)).toBe(false);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("fails when the socket path is already in use", async () => {
		const directory = mkdtempSync(join(tmpdir(), "herdr-probe-test-"));
		const socketPath = join(directory, "bridge.sock");
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => resolve());
		});
		try {
			await expect(probeHerdrBridgeListener({ directory })).rejects.toThrow();
		} finally {
			server.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("signalPid", () => {
	test("never signals a non-positive or undefined pid", () => {
		const original = process.kill;
		const calls: number[] = [];
		// `process.kill(0, ...)` would signal the whole process group, so the
		// guard must run before the syscall. Record attempts instead of firing.
		process.kill = ((pid: number) => {
			calls.push(pid);
			return true;
		}) as typeof process.kill;
		try {
			expect(signalPid(0)).toBe(false);
			expect(signalPid(-1)).toBe(false);
			expect(signalPid(undefined)).toBe(false);
			expect(signalPid(1.5)).toBe(false);
			expect(calls).toEqual([]);
		} finally {
			process.kill = original;
		}
	});

	test("signals a real positive pid", () => {
		const original = process.kill;
		const calls: Array<{ pid: number; signal: string | number | undefined }> = [];
		process.kill = ((pid: number, signal?: string | number) => {
			calls.push({ pid, signal });
			return true;
		}) as typeof process.kill;
		try {
			expect(signalPid(4242, "SIGTERM")).toBe(true);
			expect(calls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
		} finally {
			process.kill = original;
		}
	});
});
