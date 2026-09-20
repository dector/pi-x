/**
 * Stage 2 pane-bridge tests.
 *
 * `renderTranscriptLine` and `parseBridgeArgs` are pure, so they are unit
 * tested directly. Socket loss is exercised end-to-end: a raw parent server
 * connects the bridge, then disappears, and the bridge must terminate its child
 * and exit.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERDR_BRIDGE_PROTOCOL, encodeFrame, type HerdrBridgeFrame } from "./herdr-bridge.ts";
import { parseBridgeArgs, renderTranscriptLine, summaryForExit } from "./herdr-bridge-main.ts";

const BRIDGE_MAIN = join(import.meta.dir, "herdr-bridge-main.ts");
const FAKE_CHILD = join(import.meta.dir, "fixtures/bridge-fake-child.mjs");

const spawned: ChildProcess[] = [];

afterEach(() => {
	for (const proc of spawned.splice(0)) {
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for condition");
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("parseBridgeArgs", () => {
	test("accepts socket, token file, and an RPC line bound", () => {
		expect(parseBridgeArgs(["--socket", "/tmp/s.sock", "--token-file", "/tmp/t", "--max-rpc-line-bytes", "512"])).toEqual({
			socketPath: "/tmp/s.sock",
			tokenFile: "/tmp/t",
			maxRpcLineBytes: 512,
		});
	});

	test("rejects missing or unknown arguments", () => {
		expect(() => parseBridgeArgs(["--token-file", "/tmp/t"])).toThrow(/Missing --socket/);
		expect(() => parseBridgeArgs(["--socket", "/tmp/s"])).toThrow(/Missing --token-file/);
		expect(() => parseBridgeArgs(["--socket", "/tmp/s", "--token-file", "/tmp/t", "--nope"])).toThrow(/Unknown/);
		expect(() => parseBridgeArgs(["--socket", "/tmp/s", "--token-file", "/tmp/t", "--max-rpc-line-bytes", "0"])).toThrow(
			/Invalid/,
		);
	});
});

describe("renderTranscriptLine", () => {
	test("summarizes responses without echoing response data", () => {
		const line = JSON.stringify({ id: "x", type: "response", command: "prompt", success: true, data: { secret: "SENTINEL" } });
		expect(renderTranscriptLine(line)).toBe("✓ prompt");
	});

	test("summarizes failures with the error text", () => {
		const line = JSON.stringify({ type: "response", command: "prompt", success: false, error: "boom" });
		expect(renderTranscriptLine(line)).toBe("✗ prompt: boom");
	});

	test("shows assistant text from message_end but not arbitrary fields", () => {
		const line = JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
			_raw: "BRIDGE_RAW_SENTINEL_9f3a",
		});
		const rendered = renderTranscriptLine(line);
		expect(rendered).toBe("assistant: done");
		expect(rendered).not.toContain("BRIDGE_RAW_SENTINEL_9f3a");
	});

	test("never echoes raw JSON for malformed, untyped, or unknown messages", () => {
		expect(renderTranscriptLine("not json")).toContain("malformed");
		expect(renderTranscriptLine(JSON.stringify({ hello: "world" }))).toContain("without a type");
		expect(renderTranscriptLine(JSON.stringify({ type: "mystery_message", secret: "SENTINEL" }))).toBe("· mystery_message");
	});

	test("summarizes approvals and lifecycle events", () => {
		expect(renderTranscriptLine(JSON.stringify({ type: "extension_ui_request", method: "confirm", title: "Run it?" }))).toBe(
			"? approval confirm: Run it?",
		);
		expect(renderTranscriptLine(JSON.stringify({ type: "agent_start" }))).toBe("▸ agent started");
		expect(renderTranscriptLine(JSON.stringify({ type: "agent_end" }))).toBe("▪ agent finished");
	});
});

describe("summaryForExit", () => {
	test("names the agent, run, dispatch, and retention policy", () => {
		const text = summaryForExit(
			{ code: 0, signal: null },
			{ agent: "worker", runId: "sa-abc123-1-deadbeef", dispatchId: "dispatch-42", retention: "always" },
			Date.now() - 1_000,
		);
		expect(text).toContain("✓ worker [sa-abc123] completed in");
		expect(text).toContain("Dispatch: dispatch-42");
		expect(text).toContain("Result remains available in /px:agent:log");
		expect(text).toContain("This pane was retained by subagent policy.");
	});

	test("reports a short failure reason and failed-retention note", () => {
		const text = summaryForExit(
			{ code: 1, signal: null },
			{ agent: "reviewer", runId: "sa-def456", retention: "failed" },
			Date.now(),
			"provider returned 500",
		);
		expect(text).toContain("✗ reviewer [sa-def456] failed in");
		expect(text).toContain("Reason: provider returned 500");
		expect(text).toContain("This pane was retained because the run failed.");
	});

	test("does not claim retention for a recycled successful pane", () => {
		const text = summaryForExit(
			{ code: 0, signal: null },
			{ agent: "scout", runId: "sa-1", retention: "failed" },
			Date.now(),
		);
		expect(text).not.toContain("retained");
	});

	test("keeps the historical generic line without display metadata", () => {
		expect(summaryForExit({ code: 0, signal: null })).toBe("✓ pi rpc child completed");
		expect(summaryForExit({ code: 2, signal: null })).toBe("✗ pi rpc child exited (2)");
	});
});

describe("bridge socket loss", () => {
	test("terminates the child and exits when the parent socket disappears", async () => {
		const directory = mkdtempSync(join(tmpdir(), "bridge-main-loss-"));
		const socketPath = join(directory, "bridge.sock");
		const tokenFile = join(directory, "token");
		const pidFile = join(directory, "child.pid");
		writeFileSync(tokenFile, "test-token", { mode: 0o600 });

		const frames: string[] = [];
		const sockets: Socket[] = [];
		const server = createServer((socket) => {
			sockets.push(socket);
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					try {
						const frame = JSON.parse(line) as HerdrBridgeFrame;
						frames.push(frame.type);
						if (frame.type === "hello") {
							socket.write(
								encodeFrame({
									type: "welcome",
									protocol: HERDR_BRIDGE_PROTOCOL,
									request: {
										command: process.execPath,
										args: [FAKE_CHILD, "hang"],
										cwd: import.meta.dir,
										env: { ...process.env, FAKE_CHILD_PID_FILE: pidFile },
									},
								}),
							);
						}
					} catch {
						// Ignore.
					}
					newline = buffer.indexOf("\n");
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		const proc = spawn(process.execPath, [BRIDGE_MAIN, "--socket", socketPath, "--token-file", tokenFile], {
			cwd: import.meta.dir,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		spawned.push(proc);

		try {
			await waitFor(() => existsSync(pidFile));
			const childPid = Number(readFileSync(pidFile, "utf8"));
			await waitFor(() => frames.includes("ready"));
			expect(isAlive(childPid)).toBe(true);

			// Simulate the parent extension disappearing.
			for (const socket of sockets) socket.destroy();
			const code = await new Promise<number | null>((resolve) => proc.once("exit", (exitCode) => resolve(exitCode)));
			expect(code).toBe(1);
			await waitFor(() => !isAlive(childPid));
		} finally {
			for (const socket of sockets) socket.destroy();
			server.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
