import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "flutter";
const STATUS_BAR_FIRST_LINE_SET_EVENT = "status-bar:first-line:set";
const STATUS_BAR_FIRST_LINE_CLEAR_EVENT = "status-bar:first-line:clear";
const STATUS_BAR_PING_EVENT = "status-bar:ping";
const STATUS_BAR_PONG_EVENT = "status-bar:pong";
const STATUS_BAR_WARNING_DELAY_MS = 500;
const FIRST_LINE_PRIORITY = 200; // repo-stats uses 100 and skill-stats uses -100; render before both.
const MAX_LOG_LINES = 1000;
const STOP_TERM_DELAY_MS = 2000;
const STOP_KILL_DELAY_MS = 5000;

const ANSI_RESET = "\u001b[0m";
const ANSI_GREEN = "\u001b[38;5;34m";
const ANSI_YELLOW = "\u001b[38;5;220m";
const ANSI_RED = "\u001b[38;5;196m";

type FlutterState = "running" | "stopping" | "exited";

interface FlutterProcessRecord {
	process: ChildProcessWithoutNullStreams;
	cwd: string;
	flutterPath?: string;
	device?: string;
	startedAt: number;
	state: FlutterState;
	lastAction?: "reload" | "restart";
	lastActionAt?: number;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
	logs: string[];
	stopTimers: ReturnType<typeof setTimeout>[];
}

interface GlobalFlutterState {
	record?: FlutterProcessRecord;
	lastRecord?: FlutterProcessRecord;
}

interface StatusBarPongPayload {
	id?: unknown;
}

const globalKey = Symbol.for("pi-x.flutter.state");
const globalState = ((globalThis as unknown as Record<symbol, GlobalFlutterState>)[globalKey] ??= {});

function sanitizeLine(value: string): string {
	return value.replace(/[\r\n\t]/g, " ").trim();
}

function pushLog(record: FlutterProcessRecord, source: "stdout" | "stderr", chunk: Buffer): void {
	const text = chunk.toString("utf8");
	for (const line of text.split(/\r?\n/)) {
		const trimmed = sanitizeLine(line);
		if (!trimmed) continue;
		record.logs.push(`${source}: ${trimmed}`);
	}
	if (record.logs.length > MAX_LOG_LINES) {
		record.logs.splice(0, record.logs.length - MAX_LOG_LINES);
	}
}

function renderDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${seconds}s`;
}

function color(enabled: boolean | undefined, code: string, text: string): string {
	return enabled ? `${code}${text}${ANSI_RESET}` : text;
}

function renderStatus(record: FlutterProcessRecord, ctx?: ExtensionContext): string {
	const pid = record.process.pid ? `pid ${record.process.pid}` : "pid unknown";
	const ui = ctx?.hasUI;

	if (record.state === "stopping") {
		return color(ui, ANSI_YELLOW, `● Flutter (${pid})`);
	}

	if (record.state === "exited") {
		return color(ui, ANSI_RED, `● Flutter (${pid})`);
	}

	return color(ui, ANSI_GREEN, `● Flutter (${pid})`);
}

function buildRunArgs(device?: string): string[] {
	const args = ["run", "--debug"];
	if (device) args.push("-d", device);
	return args;
}

function parseRunDevice(args: string[]): string | undefined {
	const device = args[0]?.trim();
	return device || undefined;
}

function isAlive(record: FlutterProcessRecord | undefined): record is FlutterProcessRecord {
	return !!record && record.state !== "exited" && record.process.exitCode === null && !record.process.killed;
}

function clearStopTimers(record: FlutterProcessRecord): void {
	for (const timer of record.stopTimers) clearTimeout(timer);
	record.stopTimers = [];
}

function runCapture(command: string, args: string[], cwd: string, timeoutMs = 15000): { code: number | null; stdout: string; stderr: string; error?: string } {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: timeoutMs,
	});
	return {
		code: result.status,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
		error: result.error?.message,
	};
}

function resolveFlutterPath(cwd: string): string | undefined {
	const result = runCapture("bash", ["-lc", "command -v flutter"], cwd, 5000);
	return result.stdout.split("\n")[0]?.trim() || undefined;
}

function describeRecord(record: FlutterProcessRecord): string {
	const device = record.device ?? "default device";
	const pid = record.process.pid ?? "unknown";
	const state = record.state;
	const runtime = renderDuration(Date.now() - record.startedAt);
	const exit = record.state === "exited"
		? record.exitSignal
			? `, signal ${record.exitSignal}`
			: `, code ${record.exitCode ?? "?"}`
		: "";
	const flutter = record.flutterPath ? `, flutter=${record.flutterPath}` : "";
	return `Flutter ${state} (${device}, pid ${pid}, ${runtime}${exit}, cwd=${record.cwd}${flutter})`;
}

function formatRecentLogs(record: FlutterProcessRecord, count?: number): string {
	const recentLogs = count === undefined ? record.logs : record.logs.slice(-count);
	return recentLogs.length > 0 ? [`Logs (${recentLogs.length}/${record.logs.length} captured):`, ...recentLogs].join("\n") : "No logs captured yet.";
}

function formatExitMessage(record: FlutterProcessRecord): string {
	const exit = record.exitSignal ? `signal ${record.exitSignal}` : `code ${record.exitCode ?? "?"}`;
	return [`Flutter exited with ${exit}.`, describeRecord(record), formatRecentLogs(record)].join("\n");
}

export default function flutterExtension(pi: ExtensionAPI): void {
	let activeSessionContext: ExtensionContext | undefined;
	let statusBarAvailable = false;
	let warnedMissingStatusBar = false;
	let warningTimer: ReturnType<typeof setTimeout> | undefined;
	let actionStatusTimer: ReturnType<typeof setTimeout> | undefined;
	let observedRecord: FlutterProcessRecord | undefined;
	let observedExitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

	const clearWarningTimer = (): void => {
		if (!warningTimer) return;
		clearTimeout(warningTimer);
		warningTimer = undefined;
	};

	const clearActionStatusTimer = (): void => {
		if (!actionStatusTimer) return;
		clearTimeout(actionStatusTimer);
		actionStatusTimer = undefined;
	};

	const publish = (): void => {
		const record = globalState.record;
		if (!record || record.state === "exited") {
			pi.events.emit(STATUS_BAR_FIRST_LINE_CLEAR_EVENT, { id: EXTENSION_ID });
			return;
		}
		pi.events.emit(STATUS_BAR_FIRST_LINE_SET_EVENT, {
			id: EXTENSION_ID,
			content: renderStatus(record, activeSessionContext),
			section: "right",
			priority: FIRST_LINE_PRIORITY,
		});
	};

	const warnMissingStatusBar = (): void => {
		warningTimer = undefined;
		if (statusBarAvailable || warnedMissingStatusBar) return;
		warnedMissingStatusBar = true;
		if (activeSessionContext?.hasUI) {
			activeSessionContext.ui.notify("flutter extension requires status-bar extension for first-line status", "warning");
		}
	};

	const pingStatusBar = (): void => {
		statusBarAvailable = false;
		warnedMissingStatusBar = false;
		clearWarningTimer();
		warningTimer = setTimeout(warnMissingStatusBar, STATUS_BAR_WARNING_DELAY_MS);
		pi.events.emit(STATUS_BAR_PING_EVENT, { id: EXTENSION_ID });
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else console.log(message);
	};

	const unbindObservedExit = (): void => {
		if (!observedRecord || !observedExitHandler) return;
		observedRecord.process.off("exit", observedExitHandler);
		observedRecord = undefined;
		observedExitHandler = undefined;
	};

	const bindObservedExit = (record: FlutterProcessRecord | undefined): void => {
		if (!record || observedRecord === record) return;
		unbindObservedExit();
		observedRecord = record;
		observedExitHandler = (code, signal) => {
			record.state = "exited";
			record.exitCode = code;
			record.exitSignal = signal;
			clearStopTimers(record);
			globalState.lastRecord = record;
			if (globalState.record === record) {
				globalState.record = undefined;
			}
			pi.events.emit(STATUS_BAR_FIRST_LINE_CLEAR_EVENT, { id: EXTENSION_ID });
			if (activeSessionContext?.hasUI) {
				activeSessionContext.ui.notify(formatExitMessage(record), code === 0 ? "info" : "warning");
			}
		};
		record.process.once("exit", observedExitHandler);
	};

	const stopProcess = (ctx: ExtensionContext, reason: string): void => {
		const record = globalState.record;
		if (!isAlive(record)) {
			globalState.record = undefined;
			publish();
			notify(ctx, "Flutter is not running.", "warning");
			return;
		}

		record.state = "stopping";
		publish();
		notify(ctx, `Stopping Flutter (${reason})...`, "info");

		try {
			record.process.stdin.write("q");
		} catch {
			// Fall through to signal timers.
		}

		record.stopTimers.push(setTimeout(() => {
			if (!isAlive(record)) return;
			record.process.kill("SIGTERM");
		}, STOP_TERM_DELAY_MS));
		record.stopTimers.push(setTimeout(() => {
			if (!isAlive(record)) return;
			record.process.kill("SIGKILL");
		}, STOP_KILL_DELAY_MS));
	};

	const sendFlutterKey = (ctx: ExtensionContext, key: "r" | "R", action: "reload" | "restart"): void => {
		const record = globalState.record;
		if (!isAlive(record)) {
			globalState.record = undefined;
			publish();
			notify(ctx, "Flutter is not running.", "warning");
			return;
		}
		if (!record.process.stdin.writable) {
			notify(ctx, "Flutter stdin is not writable.", "error");
			return;
		}

		record.process.stdin.write(key);
		record.lastAction = action;
		record.lastActionAt = Date.now();
		publish();
		clearActionStatusTimer();
		actionStatusTimer = setTimeout(() => {
			publish();
			actionStatusTimer = undefined;
		}, 1600);
		notify(ctx, `Flutter hot ${action} sent.`, "info");
	};

	const startRun = (ctx: ExtensionContext, device?: string): void => {
		const existing = globalState.record;
		if (isAlive(existing)) {
			notify(ctx, `${describeRecord(existing)} is already owned by this extension. Use /flutter stop first.`, "warning");
			publish();
			return;
		}

		const args = buildRunArgs(device);
		const flutterPath = resolveFlutterPath(ctx.cwd);
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(flutterPath ?? "flutter", args, {
				cwd: ctx.cwd,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Failed to start flutter: ${message}`, "error");
			return;
		}

		const record: FlutterProcessRecord = {
			process: child,
			cwd: ctx.cwd,
			flutterPath,
			device,
			startedAt: Date.now(),
			state: "running",
			logs: [],
			stopTimers: [],
		};
		globalState.record = record;
		globalState.lastRecord = record;
		bindObservedExit(record);

		child.stdout.on("data", (chunk: Buffer) => pushLog(record, "stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => pushLog(record, "stderr", chunk));
		child.on("error", (error) => {
			record.logs.push(`error: ${error.message}`);
			if (record.logs.length > MAX_LOG_LINES) record.logs.shift();
			if (observedRecord === record) unbindObservedExit();
			record.state = "exited";
			clearStopTimers(record);
			globalState.lastRecord = record;
			if (globalState.record === record) {
				globalState.record = undefined;
			}
			pi.events.emit(STATUS_BAR_FIRST_LINE_CLEAR_EVENT, { id: EXTENSION_ID });
			if (activeSessionContext?.hasUI) {
				activeSessionContext.ui.notify(`Flutter process error: ${error.message}\n${describeRecord(record)}\n${formatRecentLogs(record, 8)}`, "error");
			}
		});
		child.on("exit", (code, signal) => {
			record.state = "exited";
			record.exitCode = code;
			record.exitSignal = signal;
			clearStopTimers(record);
			globalState.lastRecord = record;
			if (globalState.record === record) {
				globalState.record = undefined;
			}
		});

		publish();
		notify(ctx, `Started ${flutterPath ?? "flutter"} ${args.join(" ")} (pid ${child.pid ?? "unknown"}) in ${ctx.cwd}.`, "info");
	};

	const showStatus = (ctx: ExtensionContext): void => {
		const record = globalState.record;
		if (!isAlive(record)) {
			globalState.record = undefined;
			publish();
			const lastRecord = globalState.lastRecord;
			if (lastRecord?.state === "exited") {
				notify(ctx, `${describeRecord(lastRecord)}\n${formatRecentLogs(lastRecord)}`, "info");
				return;
			}
			notify(ctx, "Flutter is not running.", "info");
			return;
		}

		const message = [describeRecord(record), formatRecentLogs(record)].join("\n");
		notify(ctx, message, "info");
		publish();
	};

	const showEnv = (ctx: ExtensionContext): void => {
		const flutterPath = resolveFlutterPath(ctx.cwd);
		const version = runCapture(flutterPath ?? "flutter", ["--version"], ctx.cwd, 15000);
		const lines = [
			`cwd: ${ctx.cwd}`,
			`resolved flutter: ${flutterPath ?? "(not found)"}`,
			`PATH: ${process.env.PATH ?? ""}`,
			"flutter --version:",
			version.error ? `error: ${version.error}` : undefined,
			version.stdout || undefined,
			version.stderr ? `stderr:\n${version.stderr}` : undefined,
		].filter((line): line is string => typeof line === "string" && line.length > 0);
		notify(ctx, lines.join("\n"), version.code === 0 ? "info" : "warning");
	};

	const runDoctor = (ctx: ExtensionContext): void => {
		const flutterPath = resolveFlutterPath(ctx.cwd);
		const doctor = runCapture(flutterPath ?? "flutter", ["doctor", "-v"], ctx.cwd, 60000);
		const lines = [
			`cwd: ${ctx.cwd}`,
			`resolved flutter: ${flutterPath ?? "(not found)"}`,
			`exit code: ${doctor.code ?? "?"}`,
			doctor.error ? `error: ${doctor.error}` : undefined,
			doctor.stdout || undefined,
			doctor.stderr ? `stderr:\n${doctor.stderr}` : undefined,
		].filter((line): line is string => typeof line === "string" && line.length > 0);
		notify(ctx, lines.join("\n"), doctor.code === 0 ? "info" : "warning");
	};

	pi.events.on(STATUS_BAR_PONG_EVENT, (payload) => {
		const maybe = payload as StatusBarPongPayload | undefined;
		if (maybe?.id !== EXTENSION_ID) return;
		statusBarAvailable = true;
		clearWarningTimer();
	});

	pi.on("session_start", async (_event, ctx) => {
		activeSessionContext = ctx;
		bindObservedExit(globalState.record);
		pingStatusBar();
		publish();
	});

	pi.on("session_tree", async (_event, ctx) => {
		activeSessionContext = ctx;
		bindObservedExit(globalState.record);
		publish();
	});

	pi.on("session_shutdown", async (event) => {
		clearWarningTimer();
		clearActionStatusTimer();
		unbindObservedExit();
		activeSessionContext = undefined;
		// Keep the owned Flutter process across /reload, /new, /resume, and /fork.
		// On actual pi quit, stop the process because the extension owns it.
		if (event.reason === "quit") {
			const record = globalState.record;
			if (isAlive(record)) {
				try {
					record.process.stdin.write("q");
				} catch {}
				record.process.kill("SIGTERM");
			}
			globalState.record = undefined;
		}
		pi.events.emit(STATUS_BAR_FIRST_LINE_CLEAR_EVENT, { id: EXTENSION_ID });
	});

	pi.registerCommand("flutter", {
		description: "Manage an owned Flutter debug run: /flutter run [android|linux|device], reload, restart, stop, status, env, doctor",
		handler: async (rawArgs, ctx) => {
			activeSessionContext = ctx;
			pingStatusBar();
			const args = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
			const command = args.shift();

			if (!command || command === "status") {
				showStatus(ctx);
				return;
			}

			if (command === "env") {
				showEnv(ctx);
				return;
			}

			if (command === "doctor") {
				runDoctor(ctx);
				return;
			}

			if (command === "run") {
				startRun(ctx, parseRunDevice(args));
				return;
			}

			if (command === "reload") {
				sendFlutterKey(ctx, "r", "reload");
				return;
			}

			if (command === "restart") {
				sendFlutterKey(ctx, "R", "restart");
				return;
			}

			if (command === "stop") {
				stopProcess(ctx, "requested by /flutter stop");
				return;
			}

			notify(ctx, "Usage: /flutter run [android|linux|device] | /flutter reload | /flutter restart | /flutter stop | /flutter status | /flutter env | /flutter doctor", "warning");
		},
	});

	pi.registerShortcut("alt+r", {
		description: "Flutter hot reload",
		handler: async (ctx) => {
			activeSessionContext = ctx;
			sendFlutterKey(ctx, "r", "reload");
		},
	});

	pi.registerShortcut("alt+shift+r", {
		description: "Flutter hot restart",
		handler: async (ctx) => {
			activeSessionContext = ctx;
			sendFlutterKey(ctx, "R", "restart");
		},
	});
}
