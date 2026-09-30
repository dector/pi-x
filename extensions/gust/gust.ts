/**
 * Thin client over `gust ctl comments`.
 *
 * Gust discovers its control socket from the current directory, so the client
 * runs the CLI in the project cwd. The invocation is auto-detected (`gust` on
 * PATH, else `go tool gust`) and cached after the first successful call.
 *
 * Environment overrides:
 *   GUST_CMD     full invocation, e.g. "go tool gust" or "/usr/bin/gust"
 *   GUST_SOCKET  explicit socket path (adds `-S <socket>` after `ctl`)
 *   GUST_CWD     directory to run ctl from (defaults to the process cwd)
 */

import { spawn } from "node:child_process";
import type { Thread } from "./types.ts";

export interface GustInvocation {
	command: string;
	args: string[];
	label: string;
}

export interface WatchSnapshot {
	cursor: number;
	comments: Thread[];
}

export interface GustClient {
	listThreads(): Promise<Thread[]>;
	seen(id: string): Promise<Thread>;
	reply(id: string, text: string, human: boolean): Promise<Thread>;
	review(id: string, text: string): Promise<Thread>;
	done(id: string): Promise<Thread>;
	watch(since: number, signal?: AbortSignal): Promise<WatchSnapshot>;
	invocationLabel(): string;
	socketLabel(): string;
}

export class GustError extends Error {}

interface CtlOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	target?: ReloadTarget;
}

export interface ReloadTarget {
	cwd: string;
	socket?: string;
}

export interface ReloadClient {
	status(target: ReloadTarget): Promise<"active" | "paused">;
	pause(target: ReloadTarget): Promise<void>;
	resume(target: ReloadTarget): Promise<void>;
}

interface CtlResult {
	stdout: string;
	stderr: string;
	invocation: GustInvocation;
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	spawnError?: NodeJS.ErrnoException;
	aborted?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

let cachedInvocation: GustInvocation | null = null;

export function invocationCandidates(): GustInvocation[] {
	const candidates: GustInvocation[] = [];
	const fromEnv = process.env.GUST_CMD?.trim();
	if (fromEnv) {
		const parts = fromEnv.split(/\s+/);
		candidates.push({ command: parts[0], args: parts.slice(1), label: fromEnv });
	}
	candidates.push({ command: "gust", args: [], label: "gust" });
	candidates.push({ command: "go", args: ["tool", "gust"], label: "go tool gust" });
	return candidates;
}

function socketArgs(): string[] {
	const socket = process.env.GUST_SOCKET?.trim();
	return socket ? ["-S", socket] : [];
}

function cwd(): string {
	return process.env.GUST_CWD?.trim() || process.cwd();
}

function runOnce(invocation: GustInvocation, args: string[], options: CtlOptions): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(invocation.command, [...invocation.args, "ctl", ...(options.target
			? (options.target.socket ? ["-S", options.target.socket] : [])
			: socketArgs()), ...args], {
			cwd: options.target?.cwd ?? cwd(),
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (result: RunResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = () => {
			child.kill("SIGKILL");
			finish({ code: 124, stdout, stderr, aborted: true });
		};
		if (options.signal?.aborted) {
			onAbort();
		} else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
		}
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				child.kill("SIGKILL");
				finish({ code: 124, stdout, stderr: `${stderr}\nctl timed out after ${timeoutMs}ms` });
			}, timeoutMs);
		}

		child.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", (error) => {
			finish({ code: 127, stdout, stderr, spawnError: error as NodeJS.ErrnoException });
		});
		child.on("close", (code) => {
			finish({ code: code ?? 0, stdout, stderr });
		});
	});
}

async function ctl(args: string[], options: CtlOptions = {}): Promise<CtlResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const candidates = invocationCandidates();
	const ordered = cachedInvocation
		? [cachedInvocation, ...candidates.filter((c) => c.label !== cachedInvocation?.label)]
		: candidates;

	for (const invocation of ordered) {
		const result = await runOnce(invocation, args, { timeoutMs, signal: options.signal, target: options.target });
		if (result.aborted) {
			throw new GustError("aborted");
		}
		const missing =
			result.spawnError?.code === "ENOENT" ||
			(invocation.command === "go" && /no such tool/i.test(result.stderr));
		if (missing) {
			continue;
		}
		cachedInvocation = invocation;
		if (result.spawnError) {
			throw new GustError(`${invocation.label}: ${result.spawnError.message}`);
		}
		if (result.code !== 0) {
			const message = result.stderr.trim() || result.stdout.trim() || `ctl exited ${result.code}`;
			throw new GustError(message);
		}
		return { stdout: result.stdout, stderr: result.stderr, invocation };
	}
	throw new GustError(`gust not found (tried: ${candidates.map((c) => c.label).join(", ")})`);
}

function parseJSON<T>(stdout: string, what: string): T {
	const trimmed = stdout.trim();
	if (!trimmed) throw new GustError(`gust returned no ${what}`);
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		throw new GustError(`could not parse ${what} JSON from gust`);
	}
}

function parseThreads(stdout: string): Thread[] {
	const value = parseJSON<unknown>(stdout, "comments");
	if (!Array.isArray(value)) throw new GustError("gust comments response was not a list");
	return value as Thread[];
}

function parseThread(stdout: string): Thread {
	const value = parseJSON<unknown>(stdout, "comment");
	if (!value || typeof value !== "object") throw new GustError("gust comment response was not an object");
	return value as Thread;
}

function invocationLabel(): string {
	return cachedInvocation?.label ?? "gust";
}

function socketLabel(): string {
	return process.env.GUST_SOCKET?.trim() || "(socket from cwd)";
}

function parseAutoReload(stdout: string): "active" | "paused" {
	const state = /^auto_reload:\s*(active|paused)\s*$/m.exec(stdout)?.[1];
	if (state !== "active" && state !== "paused") {
		throw new GustError("gust returned no valid auto_reload state (update Gust to support pause/resume)");
	}
	return state;
}

/** Quiet, bounded probe for the status icon (including invocation discovery). */
export async function detectReloadState(target: ReloadTarget): Promise<"active" | "paused" | undefined> {
	try {
		return parseAutoReload((await ctl(["status"], {
			target, timeoutMs: 500, signal: AbortSignal.timeout(500),
		})).stdout);
	} catch {
		return undefined;
	}
}

export const reloadClient: ReloadClient = {
	async status(target) {
		return parseAutoReload((await ctl(["status"], { target, timeoutMs: 5_000 })).stdout);
	},
	async pause(target) {
		const state = parseAutoReload((await ctl(["pause"], { target, timeoutMs: 5_000 })).stdout);
		if (state !== "paused") throw new GustError("gust did not pause auto-reload");
	},
	async resume(target) {
		const state = parseAutoReload((await ctl(["resume"], { target, timeoutMs: 5_000 })).stdout);
		if (state !== "active") throw new GustError("gust did not resume auto-reload");
	},
};

export const gustClient: GustClient = {
	async listThreads(): Promise<Thread[]> {
		// `--filter all` includes resolved (done) threads; a bare `comments`
		// returns only the unfinished ones.
		return parseThreads((await ctl(["comments", "--filter", "all"])).stdout);
	},
	async seen(id: string): Promise<Thread> {
		return parseThread((await ctl(["comments", "seen", id])).stdout);
	},
	async reply(id: string, text: string, human: boolean): Promise<Thread> {
		const args = ["comments", "reply", id, text];
		if (human) args.push("--human");
		return parseThread((await ctl(args)).stdout);
	},
	async review(id: string, text: string): Promise<Thread> {
		return parseThread((await ctl(["comments", "review", id, text])).stdout);
	},
	async done(id: string): Promise<Thread> {
		return parseThread((await ctl(["comments", "done", id])).stdout);
	},
	async watch(since: number, signal?: AbortSignal): Promise<WatchSnapshot> {
		// `watch` blocks until a thread changes, so it runs without a timeout and
		// is cancelled through the signal.
		const { stdout } = await ctl(["comments", "watch", "--since", String(since)], { timeoutMs: 0, signal });
		const value = parseJSON<{ cursor?: number; comments?: unknown }>(stdout, "watch snapshot");
		if (!Array.isArray(value.comments)) throw new GustError("gust watch response was not a snapshot");
		return {
			cursor: typeof value.cursor === "number" ? value.cursor : 0,
			comments: value.comments as Thread[],
		};
	},
	invocationLabel,
	socketLabel,
};
