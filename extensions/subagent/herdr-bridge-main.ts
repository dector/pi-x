/**
 * Pane-side Herdr bridge entry point.
 *
 * Runs inside a Herdr pane (launched by the tab manager in Stage 3). It:
 *  1. connects to the parent-created Unix socket;
 *  2. reads and consumes the one-time `0600` token file;
 *  3. proves the token in the handshake;
 *  4. receives the serialized spawn request over the authenticated socket;
 *  5. spawns the same `pi --mode rpc` command the direct backend uses;
 *  6. relays framed RPC messages both ways, rendering a concise human-readable
 *     transcript to the pane instead of raw JSONL;
 *  7. terminates the child and exits when released or when the parent socket
 *     disappears.
 *
 * The transcript renderer only emits controlled summaries. It never echoes a
 * whole protocol frame, so secrets or oversized model output do not leak into
 * the terminal.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { createJsonlDecoder, type RpcExit } from "./rpc-client.ts";
import {
	HERDR_BRIDGE_PROTOCOL,
	createFrameDecoder,
	encodeFrame,
	type HerdrBridgeDisplay,
	type HerdrBridgeFrame,
	type HerdrBridgeSpawnRequest,
} from "./herdr-bridge.ts";
import type { RpcCommand, RpcExtensionUiResponse } from "./types.ts";

export const BRIDGE_CONNECT_TIMEOUT_MS = 10_000;
export const BRIDGE_WELCOME_TIMEOUT_MS = 10_000;
export const BRIDGE_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const BRIDGE_DEFAULT_GRACE_MS = 1_500;

export interface BridgeArguments {
	socketPath: string;
	tokenFile: string;
	/** Bound for child RPC lines rendered/forwarded by the bridge. */
	maxRpcLineBytes: number;
}

/** Parse the safe bootstrap arguments. Task text and Pi args never appear here. */
export function parseBridgeArgs(argv: string[]): BridgeArguments {
	let socketPath: string | undefined;
	let tokenFile: string | undefined;
	let maxRpcLineBytes = BRIDGE_MAX_FRAME_BYTES;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--socket") socketPath = argv[++i];
		else if (arg === "--token-file") tokenFile = argv[++i];
		else if (arg === "--max-rpc-line-bytes") {
			const value = Number(argv[++i]);
			if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --max-rpc-line-bytes: ${argv[i]}`);
			maxRpcLineBytes = value;
		} else throw new Error(`Unknown bridge argument: ${arg}`);
	}
	if (!socketPath) throw new Error("Missing --socket");
	if (!tokenFile) throw new Error("Missing --token-file");
	return { socketPath, tokenFile, maxRpcLineBytes };
}

function readToken(tokenFile: string): string {
	const token = readFileSync(tokenFile, "utf8").trim();
	try {
		unlinkSync(tokenFile);
	} catch {
		// Best effort; the parent removes the directory anyway.
	}
	if (!token) throw new Error("Empty bridge token");
	return token;
}

/** Run the bridge and return the process exit code. */
export async function runHerdrBridgeMain(argv: string[]): Promise<number> {
	const options = parseBridgeArgs(argv);
	let token: string;
	try {
		token = readToken(options.tokenFile);
	} catch (error) {
		process.stderr.write(`[bridge] cannot read token: ${messageOf(error)}\n`);
		return 1;
	}

	let socket: Socket;
	try {
		socket = await connectWithTimeout(options.socketPath, BRIDGE_CONNECT_TIMEOUT_MS);
	} catch (error) {
		process.stderr.write(`[bridge] cannot connect to parent: ${messageOf(error)}\n`);
		return 1;
	}

	let child: ChildProcessWithoutNullStreams | undefined;

	const writeTranscript = (text: string): void => {
		process.stdout.write(`${text}\n`);
	};
	const sendFrame = (frame: HerdrBridgeFrame): void => {
		if (socket.destroyed) return;
		try {
			socket.write(encodeFrame(frame));
		} catch {
			// Parent socket is gone; the close handler drives shutdown.
		}
	};
	// Commands can arrive immediately after `welcome`, before `spawn` returns on
	// the next microtask; buffer them so none are dropped.
	const pendingCommands: Array<RpcCommand | RpcExtensionUiResponse> = [];
	let childReady = false;
	const writeToChild = (command: RpcCommand | RpcExtensionUiResponse): void => {
		if (!childReady) {
			pendingCommands.push(command);
			return;
		}
		if (!child || child.stdin.destroyed || !child.stdin.writable) return;
		try {
			child.stdin.write(`${JSON.stringify(command)}\n`);
		} catch {
			// Child exited between the check and the write.
		}
	};

	let settleWelcome: (request?: HerdrBridgeSpawnRequest, error?: Error) => void = () => {};
	const welcome = new Promise<HerdrBridgeSpawnRequest>((resolve, reject) => {
		settleWelcome = (request, error) => {
			if (error) reject(error);
			else resolve(request as HerdrBridgeSpawnRequest);
		};
	});

	let settleTerminate: (graceMs: number) => void = () => {};
	const terminate = new Promise<number>((resolve) => {
		settleTerminate = resolve;
	});

	let phase: "welcome" | "running" = "welcome";
	const decoder = createFrameDecoder({
		maxBytes: BRIDGE_MAX_FRAME_BYTES,
		onFrame: (frame) => {
			if (phase === "welcome") {
				if (frame.type !== "welcome") return;
				if (frame.protocol !== HERDR_BRIDGE_PROTOCOL) {
					settleWelcome(undefined, new Error(`Unsupported bridge protocol: ${frame.protocol}`));
					return;
				}
				phase = "running";
				settleWelcome(frame.request);
				return;
			}
			if (frame.type === "command") {
				writeToChild(frame.command);
				return;
			}
			if (frame.type === "terminate") {
				settleTerminate(frame.graceMs ?? BRIDGE_DEFAULT_GRACE_MS);
			}
		},
		onError: (error) => writeTranscript(`[bridge] ${error.message}`),
	});

	const socketClosed = new Promise<void>((resolve) => {
		socket.once("close", () => resolve());
		socket.once("error", () => resolve());
	});
	socket.on("data", (chunk) => decoder.push(chunk));
	socket.on("end", () => decoder.flush());

	socket.write(encodeFrame({ type: "hello", protocol: HERDR_BRIDGE_PROTOCOL, token, pid: process.pid }));

	const request = await new Promise<HerdrBridgeSpawnRequest | undefined>((resolve) => {
		const timer = setTimeout(() => resolve(undefined), BRIDGE_WELCOME_TIMEOUT_MS);
		const settle = (value: HerdrBridgeSpawnRequest | undefined): void => {
			clearTimeout(timer);
			resolve(value);
		};
		welcome.then((value) => settle(value), () => settle(undefined));
		socketClosed.then(() => settle(undefined));
	});
	if (!request) {
		socket.destroy();
		return 1;
	}

	try {
		child = spawn(request.command, request.args, {
			cwd: request.cwd,
			env: request.env ?? process.env,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		writeTranscript(`[bridge] failed to start child: ${messageOf(error)}`);
		sendFrame({ type: "exit", code: 1, signal: null });
		socket.end();
		return 1;
	}
	const activeChild = child;

	const childExit = new Promise<RpcExit>((resolve) => {
		activeChild.once("exit", (code, signal) => resolve({ code, signal }));
		activeChild.once("error", () => resolve({ code: 1, signal: null }));
	});

	sendFrame({ type: "ready", pid: activeChild.pid ?? -1 });
	writeTranscript(`[bridge] pi rpc child started (pid ${activeChild.pid ?? "?"})`);
	const childStartedAt = Date.now();
	let lastStderrLine = "";

	const childDecoder = createJsonlDecoder(
		(line) => {
			const rendered = renderTranscriptLine(line);
			if (rendered) writeTranscript(rendered);
			sendFrame({ type: "line", line });
		},
		{
			maxBytes: options.maxRpcLineBytes,
			onOversize: (bytes) => {
				sendFrame({ type: "diagnostic", message: `child RPC line exceeded ${bytes} bytes` });
				writeTranscript("[bridge] dropped oversize child message");
			},
		},
	);
	activeChild.stdout.on("data", (chunk) => childDecoder.push(chunk));
	activeChild.stdout.on("end", () => childDecoder.flush());
	activeChild.stderr.on("data", (chunk) => {
		const text = chunk.toString();
		sendFrame({ type: "stderr", text });
		const line = text.trim();
		if (line) {
			lastStderrLine = line;
			writeTranscript(`[stderr] ${truncate(line, 200)}`);
		}
	});

	// Spin up is complete; release any commands that arrived during `spawn`.
	childReady = true;
	for (const command of pendingCommands.splice(0)) writeToChild(command);

	const terminateChild = async (graceMs: number): Promise<void> => {
		if (activeChild.exitCode !== null || activeChild.signalCode !== null) return;
		const wait = (ms: number): Promise<boolean> =>
			Promise.race([childExit.then(() => true), delay(ms).then(() => false)]);
		try {
			activeChild.stdin.end();
		} catch {
			// Already closed.
		}
		if (await wait(Math.max(1, Math.floor(graceMs / 2)))) return;
		try {
			activeChild.kill("SIGTERM");
		} catch {
			// Already gone.
		}
		if (await wait(Math.max(1, Math.floor(graceMs / 2)))) return;
		try {
			activeChild.kill("SIGKILL");
		} catch {
			// Already gone.
		}
		await wait(1_000);
	};

	const outcome = await Promise.race([
		childExit.then((info) => ({ kind: "exit" as const, info })),
		socketClosed.then(() => ({ kind: "socket" as const, graceMs: BRIDGE_DEFAULT_GRACE_MS })),
		terminate.then((graceMs) => ({ kind: "terminate" as const, graceMs })),
	]);

	if (outcome.kind === "exit") {
		sendFrame({ type: "exit", code: outcome.info.code, signal: outcome.info.signal });
		writeTranscript(summaryForExit(outcome.info, request.display, childStartedAt, lastStderrLine));
		socket.end();
		await delay(10);
		return 0;
	}

	await terminateChild(outcome.graceMs);
	if (!socket.destroyed) {
		sendFrame({ type: "exit", code: null, signal: null });
		socket.end();
	}
	await delay(10);
	return outcome.kind === "terminate" ? 0 : 1;
}

/**
 * Render one child RPC line as a concise human-readable transcript entry.
 * Returns `undefined` for chatty/noisy events. Never echoes raw JSON.
 */
export function renderTranscriptLine(line: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return "[bridge] ignored malformed child message";
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return "[bridge] ignored non-object child message";
	}
	const message = parsed as Record<string, unknown>;
	const type = typeof message.type === "string" ? message.type : undefined;
	if (!type) return "[bridge] ignored child message without a type";
	switch (type) {
		case "response": {
			const command = typeof message.command === "string" ? message.command : "?";
			if (message.success === false) return `✗ ${command}: ${truncate(String(message.error ?? "failed"), 200)}`;
			return `✓ ${command}`;
		}
		case "extension_ui_request": {
			const method = typeof message.method === "string" ? message.method : "request";
			const title = typeof message.title === "string" ? `: ${truncate(message.title, 120)}` : "";
			return `? approval ${method}${title}`;
		}
		case "agent_start":
			return "▸ agent started";
		case "agent_end":
			return "▪ agent finished";
		case "tool_execution_start":
			return `⚙ ${toolName(message)} started`;
		case "tool_execution_end":
			return `⚙ ${toolName(message)} ${message.isError === true ? "failed" : "done"}`;
		case "message_end": {
			const text = extractAssistantText(message.message);
			return text ? `assistant: ${truncate(text.replace(/\s+/g, " "), 200)}` : undefined;
		}
		case "error": {
			const error =
				typeof message.error === "string" ? message.error : typeof message.message === "string" ? message.message : "error";
			return `! ${truncate(error, 200)}`;
		}
		default:
			return `· ${truncate(type, 40)}`;
	}
}

function toolName(message: Record<string, unknown>): string {
	if (typeof message.toolName === "string") return truncate(message.toolName, 40);
	if (typeof message.name === "string") return truncate(message.name, 40);
	return "tool";
}

function extractAssistantText(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const text = (part as { type?: unknown; text?: unknown });
		if (text.type === "text" && typeof text.text === "string") parts.push(text.text);
	}
	const joined = parts.join("\n").trim();
	return joined.length > 0 ? joined : undefined;
}

/**
 * Final settled summary. With display metadata it names the run, its dispatch,
 * duration, and whether the pane is retained; it never dumps prompts or raw
 * protocol data. Without metadata it keeps the historical generic line.
 */
export function summaryForExit(
	info: RpcExit,
	display?: HerdrBridgeDisplay,
	startedAt = Date.now(),
	failureReason?: string,
): string {
	const success = info.code === 0;
	if (!display) {
		if (success) return "✓ pi rpc child completed";
		return `✗ pi rpc child exited (${info.code ?? info.signal ?? "unknown"})`;
	}
	const seconds = Math.max(0, (Date.now() - startedAt) / 1000);
	const lines = [
		`${success ? "✓" : "✗"} ${display.agent} [${shortRunId(display.runId)}] ${success ? "completed" : "failed"} in ${seconds.toFixed(1)}s`,
	];
	if (display.dispatchId) lines.push(`Dispatch: ${display.dispatchId}`);
	if (!success && failureReason && failureReason.trim()) lines.push(`Reason: ${truncate(failureReason.trim(), 200)}`);
	lines.push("Result remains available in /px:agent:log");
	const retained = display.retention === "always" || (display.retention === "failed" && !success);
	if (retained) {
		lines.push("");
		lines.push(
			display.retention === "always"
				? "This pane was retained by subagent policy."
				: "This pane was retained because the run failed.",
		);
	}
	return lines.join("\n");
}

function shortRunId(runId: string): string {
	const parts = runId.split("-");
	if (parts.length >= 2 && parts[0].length > 0 && parts[1].length > 0) return `${parts[0]}-${parts[1]}`;
	return runId.length > 12 ? runId.slice(0, 12) : runId;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function connectWithTimeout(socketPath: string, timeoutMs: number): Promise<Socket> {
	return new Promise<Socket>((resolve, reject) => {
		const socket = connect(socketPath);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Connection timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMainModule(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return import.meta.url === pathToFileURL(entry).href;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	try {
		process.exitCode = await runHerdrBridgeMain(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`[bridge] fatal: ${messageOf(error)}\n`);
		process.exitCode = 1;
	}
}

if (isMainModule()) void main();
