import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
	RpcCommand,
	RpcExtensionUiRequest,
	RpcExtensionUiResponse,
	RpcResponse,
	RpcStreamEvent,
} from "./types.ts";

export function createJsonlDecoder(
	onLine: (line: string) => void,
): { push(chunk: Buffer | Uint8Array | string): void; flush(): void } {
	const decoder = new StringDecoder("utf8");
	let buffered = "";
	const drain = (final: boolean): void => {
		let newline = buffered.indexOf("\n");
		while (newline >= 0) {
			let line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			onLine(line);
			newline = buffered.indexOf("\n");
		}
		if (final && buffered.length > 0) {
			let line = buffered;
			buffered = "";
			if (line.endsWith("\r")) line = line.slice(0, -1);
			onLine(line);
		}
	};
	return {
		push(chunk) {
			buffered += typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
			drain(false);
		},
		flush() {
			buffered += decoder.end();
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
	request(command: RpcCommand, timeoutMs: number): Promise<RpcResponse>;
	send(command: RpcCommand | RpcExtensionUiResponse): void;
	respondUi(response: RpcExtensionUiResponse): void;
	terminate(options?: { graceMs?: number }): Promise<void>;
}

type Pending = { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

function isRpcResponse(value: Record<string, unknown>): value is RpcResponse {
	return value.type === "response" && typeof value.success === "boolean" && typeof value.command === "string";
}

function isUiRequest(value: Record<string, unknown>): value is RpcExtensionUiRequest {
	return value.type === "extension_ui_request" && typeof value.id === "string" && typeof value.method === "string";
}

export function spawnRpcChild(options: SpawnRpcChildOptions): RpcChild {
	const proc: ChildProcessWithoutNullStreams = spawn(options.command, options.args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pending = new Map<string, Pending>();
	const maxStderrChars = options.maxStderrChars ?? 16_384;
	const maxDiagnostics = options.maxDiagnostics ?? 50;
	let stderr = "";
	let diagnosticCount = 0;
	let exited = false;
	let terminating: Promise<void> | undefined;
	let resolveExit!: (exit: RpcExit) => void;
	const exit = new Promise<RpcExit>((resolve) => {
		resolveExit = resolve;
	});

	const rejectPending = (error: Error): void => {
		for (const item of pending.values()) {
			clearTimeout(item.timer);
			item.reject(error);
		}
		pending.clear();
	};
	const diagnostic = (message: string): void => {
		if (diagnosticCount++ < maxDiagnostics) options.events.onProtocolDiagnostic?.(message);
	};
	const finishExit = (info: RpcExit): void => {
		if (exited) return;
		exited = true;
		rejectPending(new Error(`RPC child exited before responding (${info.code ?? info.signal ?? "unknown"})`));
		resolveExit(info);
		options.events.onExit?.(info);
	};

	const decoder = createJsonlDecoder((line) => {
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
	});

	proc.stdout.on("data", (chunk) => decoder.push(chunk));
	proc.stdout.on("end", () => decoder.flush());
	proc.stderr.on("data", (chunk) => {
		const text = chunk.toString();
		stderr = (stderr + text).slice(-maxStderrChars);
		options.events.onStderr?.(text);
	});
	proc.on("error", (error) => {
		diagnostic(`RPC child process error: ${error.message}`);
		finishExit({ code: 1, signal: null });
	});
	proc.on("close", (code, signal) => finishExit({ code, signal }));
	proc.stdin.on("error", (error) => rejectPending(error));

	const send = (command: RpcCommand | RpcExtensionUiResponse): void => {
		if (exited || proc.stdin.destroyed || !proc.stdin.writable) throw new Error("RPC child stdin is not writable");
		proc.stdin.write(`${JSON.stringify(command)}\n`);
	};

	const client: RpcChild = {
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
		send,
		respondUi: send,
		terminate({ graceMs = 1500 } = {}) {
			if (terminating) return terminating;
			terminating = (async () => {
				rejectPending(new Error("RPC child is terminating"));
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
	return client;
}
