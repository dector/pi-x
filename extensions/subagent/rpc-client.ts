import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
	HerdrRunLocation,
	RpcCommand,
	RpcExtensionUiRequest,
	RpcExtensionUiResponse,
	RpcResponse,
	RpcStreamEvent,
	SubagentRunOutcome,
} from "./types.ts";

/**
 * Options for the shared JSONL framing helper.
 *
 * `maxBytes` and `onOversize` are opt-in. Omitting them keeps the original
 * unbounded pipe behavior; the socket bridge passes a bound so a broken peer
 * cannot grow the parent's memory without limit.
 */
export interface JsonlDecoderOptions {
	/** Maximum buffered bytes allowed for a single line before it is dropped. */
	maxBytes?: number;
	/** Called once when an oversize line is discarded, with its buffered byte count. */
	onOversize?: (bytes: number) => void;
}

export function createJsonlDecoder(
	onLine: (line: string) => void,
	options: JsonlDecoderOptions = {},
): { push(chunk: Buffer | Uint8Array | string): void; flush(): void } {
	const decoder = new StringDecoder("utf8");
	const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
	let buffered = "";
	let bufferedBytes = 0;
	let discarding = false;

	const emit = (raw: string): void => {
		onLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
	};

	const drain = (final: boolean): void => {
		let newline = buffered.indexOf("\n");
		while (newline >= 0) {
			const raw = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			bufferedBytes = Math.max(0, bufferedBytes - Buffer.byteLength(raw) - 1);
			const bytes = Buffer.byteLength(raw);
			if (bytes > maxBytes) options.onOversize?.(bytes);
			else emit(raw);
			newline = buffered.indexOf("\n");
		}
		if (bufferedBytes > maxBytes) {
			options.onOversize?.(bufferedBytes);
			discarding = true;
			buffered = "";
			bufferedBytes = 0;
		}
		if (final) {
			if (buffered.length > 0 && !discarding) {
				const bytes = Buffer.byteLength(buffered);
				if (bytes > maxBytes) options.onOversize?.(bytes);
				else emit(buffered);
			}
			buffered = "";
			bufferedBytes = 0;
			discarding = false;
		}
	};

	const append = (text: string, bytes: number): void => {
		if (discarding) {
			// Drop the remainder of the oversize line, then resume normally.
			const newline = text.indexOf("\n");
			if (newline < 0) return;
			discarding = false;
			buffered = text.slice(newline + 1);
			bufferedBytes = Buffer.byteLength(buffered);
		} else {
			buffered += text;
			bufferedBytes += bytes;
		}
		drain(false);
	};

	return {
		push(chunk) {
			if (typeof chunk === "string") {
				append(chunk, Buffer.byteLength(chunk));
				return;
			}
			const text = decoder.write(Buffer.from(chunk));
			if (text.length > 0) append(text, Buffer.byteLength(text));
		},
		flush() {
			const tail = decoder.end();
			if (tail.length > 0) append(tail, Buffer.byteLength(tail));
			drain(true);
		},
	};
}

export interface RpcChildEvents {
	onStreamEvent(event: RpcStreamEvent): void;
	onExtensionUiRequest(request: RpcExtensionUiRequest): void;
	onStderr?(text: string): void;
	onProtocolDiagnostic?(message: string): void;
	onResponse?(response: RpcResponse): void;
	onExit?(info: RpcExit): void;
}

export interface RpcExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

export interface SpawnRpcChildOptions {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	events: RpcChildEvents;
	maxStderrChars?: number;
	maxDiagnostics?: number;
}

export interface RpcChild {
	readonly pid: number | undefined;
	readonly exited: boolean;
	readonly stderr: string;
	readonly exit: Promise<RpcExit>;
	/** Herdr pane identity, when this child runs behind the authenticated bridge. */
	readonly herdr?: HerdrRunLocation;
	request(command: RpcCommand, timeoutMs: number): Promise<RpcResponse>;
	send(command: RpcCommand | RpcExtensionUiResponse): void;
	respondUi(response: RpcExtensionUiResponse): void;
	terminate(options?: { graceMs?: number }): Promise<void>;
	/**
	 * Release backend-owned resources (for example a Herdr pane lease) with the
	 * run's terminal outcome. Optional so pipe children stay unchanged; the
	 * direct-process backend never sets it.
	 */
	release?(outcome: SubagentRunOutcome): Promise<void>;
}

type Pending = { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

function isRpcResponse(value: Record<string, unknown>): value is RpcResponse {
	return value.type === "response" && typeof value.success === "boolean" && typeof value.command === "string";
}

function isUiRequest(value: Record<string, unknown>): value is RpcExtensionUiRequest {
	return (
		value.type === "extension_ui_request" &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		value.id.length <= 256 &&
		typeof value.method === "string" &&
		value.method.length <= 64
	);
}

export interface RpcProtocolOptions {
	events: RpcChildEvents;
	maxDiagnostics?: number;
	/** Transport write for one command or UI response. May throw when the peer is gone. */
	send: (command: RpcCommand | RpcExtensionUiResponse) => void;
}

/**
 * Transport-agnostic RPC bookkeeping: JSONL parsing, response correlation,
 * pending-request timeouts, and diagnostic capping.
 *
 * The pipe child (`spawnRpcChild`) and the Herdr socket bridge both feed decoded
 * lines into `handleLine` and write outgoing commands through `send`, so the
 * protocol is implemented once instead of being duplicated per transport.
 */
export interface RpcProtocol {
	handleLine(line: string): void;
	request(command: RpcCommand, timeoutMs: number): Promise<RpcResponse>;
	send(command: RpcCommand | RpcExtensionUiResponse): void;
	rejectPending(error: Error): void;
	diagnostic(message: string): void;
}

export function createRpcProtocol(options: RpcProtocolOptions): RpcProtocol {
	const pending = new Map<string, Pending>();
	const maxDiagnostics = options.maxDiagnostics ?? 50;
	let diagnosticCount = 0;

	const diagnostic = (message: string): void => {
		if (diagnosticCount++ < maxDiagnostics) options.events.onProtocolDiagnostic?.(message);
	};

	const rejectPending = (error: Error): void => {
		for (const item of pending.values()) {
			clearTimeout(item.timer);
			item.reject(error);
		}
		pending.clear();
	};

	const handleLine = (line: string): void => {
		if (!line.trim()) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			diagnostic(`Malformed RPC JSON: ${line.slice(0, 500)}`);
			return;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			diagnostic("Ignored non-object RPC message");
			return;
		}
		const message = parsed as Record<string, unknown>;
		if (isRpcResponse(message)) {
			const id = typeof message.id === "string" ? message.id : undefined;
			const waiter = id ? pending.get(id) : undefined;
			if (id && waiter) {
				pending.delete(id);
				clearTimeout(waiter.timer);
				waiter.resolve(message);
			} else options.events.onResponse?.(message);
			return;
		}
		if (isUiRequest(message)) {
			options.events.onExtensionUiRequest(message);
			return;
		}
		if (typeof message.type !== "string") {
			diagnostic("Ignored RPC message without a type");
			return;
		}
		options.events.onStreamEvent(message as RpcStreamEvent);
	};

	const send = (command: RpcCommand | RpcExtensionUiResponse): void => options.send(command);

	return {
		handleLine,
		send,
		rejectPending,
		diagnostic,
		request(command, timeoutMs) {
			if (!command.id) return Promise.reject(new Error("RPC request requires an id"));
			if (pending.has(command.id)) return Promise.reject(new Error(`Duplicate RPC request id: ${command.id}`));
			return new Promise<RpcResponse>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(command.id!);
					reject(new Error(`RPC request timed out: ${command.type}`));
				}, timeoutMs);
				pending.set(command.id!, { resolve, reject, timer });
				try {
					send(command);
				} catch (error) {
					pending.delete(command.id!);
					clearTimeout(timer);
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
		},
	};
}

export function spawnRpcChild(options: SpawnRpcChildOptions): RpcChild {
	const proc: ChildProcessWithoutNullStreams = spawn(options.command, options.args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const maxStderrChars = options.maxStderrChars ?? 16_384;
	let stderr = "";
	let exited = false;
	let terminating: Promise<void> | undefined;
	let resolveExit!: (exit: RpcExit) => void;
	const exit = new Promise<RpcExit>((resolve) => {
		resolveExit = resolve;
	});

	const protocol = createRpcProtocol({
		events: options.events,
		maxDiagnostics: options.maxDiagnostics,
		send: (command) => {
			if (exited || proc.stdin.destroyed || !proc.stdin.writable) throw new Error("RPC child stdin is not writable");
			proc.stdin.write(`${JSON.stringify(command)}\n`);
		},
	});

	const finishExit = (info: RpcExit): void => {
		if (exited) return;
		exited = true;
		protocol.rejectPending(new Error(`RPC child exited before responding (${info.code ?? info.signal ?? "unknown"})`));
		resolveExit(info);
		options.events.onExit?.(info);
	};

	const decoder = createJsonlDecoder((line) => protocol.handleLine(line));
	proc.stdout.on("data", (chunk) => decoder.push(chunk));
	proc.stdout.on("end", () => decoder.flush());
	proc.stderr.on("data", (chunk) => {
		const text = chunk.toString();
		stderr = (stderr + text).slice(-maxStderrChars);
		options.events.onStderr?.(text);
	});
	proc.on("error", (error) => {
		protocol.diagnostic(`RPC child process error: ${error.message}`);
		finishExit({ code: 1, signal: null });
	});
	proc.on("close", (code, signal) => finishExit({ code, signal }));
	proc.stdin.on("error", (error) => protocol.rejectPending(error));

	return {
		get pid() {
			return proc.pid;
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
		terminate({ graceMs = 1500 } = {}) {
			if (terminating) return terminating;
			terminating = (async () => {
				protocol.rejectPending(new Error("RPC child is terminating"));
				if (exited) return;
				if (!proc.stdin.destroyed) proc.stdin.end();
				const wait = async (ms: number): Promise<boolean> =>
					Promise.race([exit.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
				if (await wait(graceMs)) return;
				proc.kill("SIGTERM");
				if (await wait(graceMs)) return;
				proc.kill("SIGKILL");
				await exit;
			})();
			return terminating;
		},
	};
}
