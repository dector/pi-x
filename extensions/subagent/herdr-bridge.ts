/**
 * Parent-side authenticated Unix-socket bridge.
 *
 * A Herdr pane cannot share the parent extension's stdin/stdout pipes, so the
 * bridge runs inside the pane, connects back to a listener this module owns,
 * proves a one-time run token, and then relays framed RPC messages between the
 * parent and the pane's `pi --mode rpc` child.
 *
 * This module owns only the transport. Pane creation, tab ownership, retention,
 * and cleanup policy live in `herdr-tab.ts` (Stage 3); the returned `RpcChild`
 * behaves exactly like the direct `spawnRpcChild()` result so dispatch
 * orchestration needs no backend-specific branches.
 *
 * Security properties:
 *  - the socket lives in a private `0700` temp directory;
 *  - the token is written `0600` and the parent removes the whole directory on
 *    exit or termination;
 *  - frames are newline-delimited JSON bounded by `maxFrameBytes`.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createJsonlDecoder,
	createRpcProtocol,
	type RpcChild,
	type RpcChildEvents,
	type RpcExit,
	type SpawnRpcChildOptions,
} from "./rpc-client.ts";
import type { HerdrRetention, RpcCommand, RpcExtensionUiResponse } from "./types.ts";

/** Wire protocol version exchanged in the hello/welcome handshake. */
export const HERDR_BRIDGE_PROTOCOL = 1;

export const DEFAULT_HERDR_BRIDGE_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_HERDR_BRIDGE_HANDSHAKE_TIMEOUT_MS = 5_000;
export const DEFAULT_HERDR_BRIDGE_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_HERDR_BRIDGE_MAX_STDERR_CHARS = 16_384;
export const DEFAULT_HERDR_BRIDGE_MAX_DIAGNOSTICS = 50;

/**
 * Create the private bridge directory with restrictive permissions. Best-effort
 * on filesystems without POSIX modes, matching the listener's security posture.
 */
function prepareBridgeDirectory(directory: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	try {
		chmodSync(directory, 0o700);
	} catch {
		// Best effort; the directory may be on a filesystem without POSIX modes.
	}
}

/**
 * Bind and immediately close the private bridge Unix listener.
 *
 * Dispatch preflight calls this before accepting an async dispatch to prove the
 * parent can create the `0700` directory and bind the socket a real bridge will
 * need. It never launches a bridge or a Pi child, and it always removes the
 * directory, whether the bind succeeds or fails.
 */
export async function probeHerdrBridgeListener(options: { directory?: string } = {}): Promise<void> {
	const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "px-herdr-bridge-")));
	try {
		prepareBridgeDirectory(directory);
		const socketPath = join(directory, "bridge.sock");
		await new Promise<void>((resolve, reject) => {
			const server = createServer();
			const onError = (error: Error): void => {
				try {
					server.close();
				} catch {
					// Already closed.
				}
				reject(error);
			};
			server.once("error", onError);
			server.listen(socketPath, () => {
				server.off("error", onError);
				server.close((error) => (error ? reject(error) : resolve()));
			});
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Malformed, oversize, or otherwise invalid bridge frame. */
export class HerdrBridgeProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HerdrBridgeProtocolError";
	}
}

/** Display metadata the pane bridge renders in its final settled summary. */
export interface HerdrBridgeDisplay {
	agent: string;
	runId: string;
	dispatchId?: string;
	/** Per-dispatch retention intent, so the summary can explain why a pane stays. */
	retention?: HerdrRetention;
}

/** Serializable spawn request transferred after the handshake. */
export interface HerdrBridgeSpawnRequest {
	command: string;
	args: string[];
	cwd: string;
	env?: Record<string, string>;
	/** Optional human-readable identity for the retained-pane summary. */
	display?: HerdrBridgeDisplay;
}

/** Bootstrap information safe to pass to the pane bridge (no task text or Pi args). */
export interface HerdrBridgeBootstrap {
	socketPath: string;
	tokenFile: string;
	/** Token value, exposed for tests and for callers that prefer argv over a file. */
	token: string;
}

/**
 * Launch the pane-side bridge. The launcher is the only place that knows how a
 * command is delivered to a Herdr pane, so callers stay testable with a fake
 * and no command text ever contains task/prompt/pi arguments.
 */
export interface HerdrBridgeLauncher {
	/** Throw when the bridge runtime or entry point is unavailable. */
	assertAvailable(): void;
	launch(paneId: string, bootstrap: HerdrBridgeBootstrap): Promise<void>;
}

export type HerdrBridgeFrame =
	| { type: "hello"; protocol: number; token: string; pid: number }
	| { type: "welcome"; protocol: number; request: HerdrBridgeSpawnRequest }
	| { type: "ready"; pid: number }
	| { type: "command"; command: RpcCommand | RpcExtensionUiResponse }
	| { type: "line"; line: string }
	| { type: "stderr"; text: string }
	| { type: "diagnostic"; message: string }
	| { type: "exit"; code: number | null; signal: string | null }
	| { type: "terminate"; graceMs?: number };

/** Serialize one frame for the newline-delimited socket protocol. */
export function encodeFrame(frame: HerdrBridgeFrame): string {
	return `${JSON.stringify(frame)}\n`;
}

export interface HerdrBridgeFrameDecoderOptions {
	maxBytes?: number;
	onFrame: (frame: HerdrBridgeFrame) => void;
	onError: (error: Error) => void;
}

/** Decode bounded newline-delimited JSON frames, reporting malformed/oversize input. */
export function createFrameDecoder(options: HerdrBridgeFrameDecoderOptions): {
	push(chunk: Buffer | Uint8Array | string): void;
	flush(): void;
} {
	return createJsonlDecoder(
		(line) => {
			if (!line.trim()) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				options.onError(new HerdrBridgeProtocolError("Malformed bridge frame"));
				return;
			}
			if (!isBridgeFrame(parsed)) {
				options.onError(new HerdrBridgeProtocolError("Invalid bridge frame"));
				return;
			}
			options.onFrame(parsed);
		},
		{
			maxBytes: options.maxBytes,
			onOversize: (bytes) => options.onError(new HerdrBridgeProtocolError(`Bridge frame exceeded ${bytes} bytes`)),
		},
	);
}

function isBridgeFrame(value: unknown): value is HerdrBridgeFrame {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return typeof (value as { type?: unknown }).type === "string";
}

export interface HerdrBridgeChildOptions {
	spawn: SpawnRpcChildOptions;
	/**
	 * Invoked after the bridge handshake and immediately before the welcome
	 * frame that launches the pane-side Pi child. Used for live parent state.
	 */
	beforeSpawn?: () => void;
	/** Launch the pane bridge with the socket/token bootstrap. */
	launch: (bootstrap: HerdrBridgeBootstrap) => Promise<void>;
	connectTimeoutMs?: number;
	handshakeTimeoutMs?: number;
	maxFrameBytes?: number;
	maxStderrChars?: number;
	maxDiagnostics?: number;
	/** Optional identity rendered in the pane transcript's final summary. */
	display?: HerdrBridgeDisplay;
	/** Override the auto-created private directory (used by tests). */
	directory?: string;
}

/**
 * Create the listener, launch the pane bridge, authenticate it, and resolve a
 * `RpcChild` that relays RPC traffic over the socket.
 */
export async function createHerdrBridgeChild(options: HerdrBridgeChildOptions): Promise<RpcChild> {
	const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "px-herdr-bridge-")));
	prepareBridgeDirectory(directory);
	const socketPath = join(directory, "bridge.sock");
	const tokenFile = join(directory, "token");
	const token = randomBytes(32).toString("hex");
	writeFileSync(tokenFile, token, { mode: 0o600 });

	const events = options.spawn.events;
	const maxStderrChars = options.maxStderrChars ?? DEFAULT_HERDR_BRIDGE_MAX_STDERR_CHARS;
	const maxDiagnostics = options.maxDiagnostics ?? DEFAULT_HERDR_BRIDGE_MAX_DIAGNOSTICS;
	const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_HERDR_BRIDGE_CONNECT_TIMEOUT_MS;
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HERDR_BRIDGE_HANDSHAKE_TIMEOUT_MS;

	const server = createServer();
	let socket: Socket | undefined;
	let bridgePid: number | undefined;
	let childPid: number | undefined;
	let stderr = "";
	let exited = false;
	let terminating: Promise<void> | undefined;

	const cleanup = (): void => {
		try {
			server.close();
		} catch {
			// Already closed.
		}
		rmSync(directory, { recursive: true, force: true });
	};

	let resolveExit!: (info: RpcExit) => void;
	const exit = new Promise<RpcExit>((resolve) => {
		resolveExit = resolve;
	});

	const protocol = createRpcProtocol({
		events,
		maxDiagnostics,
		send: (command) => {
			if (!socket || socket.destroyed) throw new Error("RPC bridge socket is not writable");
			socket.write(encodeFrame({ type: "command", command }));
		},
	});

	const finishExit = (info: RpcExit): void => {
		if (exited) return;
		exited = true;
		protocol.rejectPending(new Error(`RPC child exited before responding (${info.code ?? info.signal ?? "unknown"})`));
		resolveExit(info);
		events.onExit?.(info);
		cleanup();
	};

	let phase: "handshake" | "runtime" = "handshake";
	let handshakeSettled = false;
	let resolveHandshake: () => void = () => {};
	let rejectHandshake: (error: Error) => void = () => {};
	const handshake = new Promise<void>((resolve, reject) => {
		resolveHandshake = resolve;
		rejectHandshake = reject;
	});
	const settleHandshake = (error?: Error): void => {
		if (handshakeSettled) return;
		handshakeSettled = true;
		if (error) rejectHandshake(error);
		else resolveHandshake();
	};

	const decoder = createFrameDecoder({
		maxBytes: options.maxFrameBytes ?? DEFAULT_HERDR_BRIDGE_MAX_FRAME_BYTES,
		onFrame: (frame) => {
			if (phase === "handshake") {
				if (frame.type !== "hello") {
					settleHandshake(new HerdrBridgeProtocolError("Bridge did not start with a handshake"));
					return;
				}
				if (frame.protocol !== HERDR_BRIDGE_PROTOCOL) {
					settleHandshake(new HerdrBridgeProtocolError(`Unsupported bridge protocol: ${frame.protocol}`));
					return;
				}
				if (!tokensEqual(frame.token, token)) {
					settleHandshake(new HerdrBridgeProtocolError("Bridge authentication failed"));
					return;
				}
				bridgePid = frame.pid;
				phase = "runtime";
				settleHandshake();
				return;
			}
			switch (frame.type) {
				case "line":
					protocol.handleLine(frame.line);
					break;
				case "ready":
					childPid = frame.pid;
					break;
				case "stderr": {
					stderr = (stderr + frame.text).slice(-maxStderrChars);
					events.onStderr?.(frame.text);
					break;
				}
				case "diagnostic":
					events.onProtocolDiagnostic?.(frame.message);
					break;
				case "exit":
					finishExit({ code: frame.code, signal: frame.signal as NodeJS.Signals | null });
					break;
				default:
					events.onProtocolDiagnostic?.(`Ignored unexpected bridge frame: ${String((frame as { type: string }).type)}`);
			}
		},
		onError: (error) => {
			if (phase === "handshake") settleHandshake(error);
			else events.onProtocolDiagnostic?.(error.message);
		},
	});

	let connectionSettled = false;
	let resolveConnection: (socket: Socket) => void = () => {};
	const connection = new Promise<Socket>((resolve) => {
		resolveConnection = resolve;
	});

	server.on("connection", (accepted) => {
		if (connectionSettled) {
			accepted.destroy();
			return;
		}
		connectionSettled = true;
		socket = accepted;
		accepted.setNoDelay(true);
		accepted.on("data", (chunk) => decoder.push(chunk));
		accepted.on("end", () => decoder.flush());
		accepted.on("error", (error) => events.onProtocolDiagnostic?.(`Bridge socket error: ${error.message}`));
		accepted.on("close", () => finishExit({ code: null, signal: null }));
		resolveConnection(accepted);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			server.on("error", (error) => events.onProtocolDiagnostic?.(`Bridge listener error: ${error.message}`));
			resolve();
		});
	});

	try {
		await options.launch({ socketPath, tokenFile, token });
	} catch (error) {
		cleanup();
		throw new Error(`Failed to launch Herdr bridge: ${messageOf(error)}`);
	}

	let accepted: Socket;
	try {
		accepted = await withTimeout(connection, connectTimeoutMs, "Herdr bridge did not connect");
	} catch (error) {
		cleanup();
		socket?.destroy();
		throw error;
	}

	// Only one bridge connection is expected; stop accepting more.
	server.close();

	try {
		await withTimeout(handshake, handshakeTimeoutMs, "Herdr bridge handshake timed out");
	} catch (error) {
		cleanup();
		accepted.destroy();
		throw error;
	}

	try {
		options.beforeSpawn?.();
	} catch (error) {
		accepted.destroy();
		cleanup();
		throw error;
	}
	accepted.write(
		encodeFrame({
			type: "welcome",
			protocol: HERDR_BRIDGE_PROTOCOL,
			request: {
				command: options.spawn.command,
				args: [...options.spawn.args],
				cwd: options.spawn.cwd,
				env: serializeEnv({ ...process.env, ...(options.spawn.env ?? {}) }),
				...(options.display ? { display: options.display } : {}),
			},
		}),
	);

	const terminate = ({ graceMs = 1500 } = {}): Promise<void> => {
		if (terminating) return terminating;
		terminating = (async () => {
			protocol.rejectPending(new Error("RPC child is terminating"));
			if (exited) {
				cleanup();
				return;
			}
			try {
				accepted.write(encodeFrame({ type: "terminate", graceMs }));
			} catch {
				// Socket already gone; escalation below handles it.
			}
			const wait = (ms: number): Promise<boolean> =>
				Promise.race([exit.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
			if (await wait(graceMs)) {
				cleanup();
				return;
			}
			accepted.destroy();
			if (await wait(graceMs)) {
				cleanup();
				return;
			}
			for (const pid of [childPid, bridgePid]) {
				signalPid(pid);
			}
			await exit;
			cleanup();
		})();
		return terminating;
	};

	return {
		get pid() {
			return bridgePid;
		},
		get exited() {
			return exited;
		},
		get stderr() {
			return stderr;
		},
		exit,
		request(command, timeoutMs) {
			return protocol.request(command, timeoutMs);
		},
		send(command) {
			protocol.send(command);
		},
		respondUi(response) {
			protocol.send(response);
		},
		terminate,
	};
}

function tokensEqual(a: unknown, b: string): boolean {
	if (typeof a !== "string") return false;
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/**
 * Send a signal to a known positive PID. Guards against `process.kill(0, ...)`,
 * which would signal the caller's entire process group, and negative PIDs,
 * which would signal unrelated processes. Returns whether the signal was sent.
 */
export function signalPid(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): boolean {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		// Already gone or not permitted.
		return false;
	}
}

function serializeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
