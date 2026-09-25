import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Component, Key, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	PROC_STOP_ALL_MAX_WAIT_MS,
	PROC_STOP_ALL_REPLY_EVENT,
	PROC_STOP_ALL_REQUEST_EVENT,
	stopAllRunningProcesses,
	validateProcStopAllRequest,
} from "./stop-all.ts";
import {
	hasVisibleProcessEntries,
	ProcessesWidget,
	renderProcessesWidgetContent,
	type ProcessesWidgetEntry,
} from "./processes-widget.ts";

const PANEL_ID = "processes";
const PANEL_LABEL = "Processes";
const PANEL_ORDER = 20;

const PANEL_EVENTS = {
	register: "px:panels:register",
	visibility: "px:panels:visibility",
	active: "px:panels:active",
	sync: "px:panels:sync",
	content: "px:panels:content",
} as const;

const ANSI_RESET = "\u001b[0m";
const ANSI_GREEN = "\u001b[38;5;34m";
const ANSI_YELLOW = "\u001b[38;5;220m";
const ANSI_RED = "\u001b[38;5;196m";
const ANSI_GRAY = "\u001b[38;5;245m";

const MAX_LINE_LENGTH = 4096;
const STOP_ESCALATE_MS = 3000;
const DEFAULT_LOG_LINES = 5000;
const DEFAULT_LOG_BYTES = 2_000_000;
const CONFIG_PATH = join(homedir(), ".pi", "agent", "proc.json");

const PROC_ACTIONS = ["run", "list", "status", "logs", "stop", "kill", "write", "forget"] as const;
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT", "SIGKILL"] as const;
const AGENT_READER = "agent";
const USER_READER = "user";
const DEFAULT_LOG_TAIL = 200;
const MAX_LOG_TAIL = 2000;
const MAX_WAIT_SECONDS = 30;

const MANAGER_REFRESH_MS = 300;
const MANAGER_MIN_ROWS = 5;
const MANAGER_MAX_ROWS = 18;
const LOG_MIN_ROWS = 6;
const LOG_MAX_ROWS = 24;
const LOG_SCROLL_STEP = 5;

interface ProcConfig {
	maxProcesses: number;
	logLines: number;
	logBytes: number;
	exitedRetentionMs: number;
	exitedCap: number;
	/** Legacy `statusRow: false` fallback: disables the Processes panel and widget. */
	panelEnabled: boolean;
}

const DEFAULT_CONFIG: ProcConfig = {
	maxProcesses: 8,
	logLines: DEFAULT_LOG_LINES,
	logBytes: DEFAULT_LOG_BYTES,
	exitedRetentionMs: 60_000,
	exitedCap: 20,
	panelEnabled: true,
};

type StreamKind = "out" | "err";
type ProcState = "running" | "stopping" | "exited";

interface LogLine {
	source: StreamKind;
	text: string;
}

interface ProcRecord {
	name: string;
	command: string;
	cwd: string;
	process?: ChildProcessWithoutNullStreams;
	pid?: number;
	state: ProcState;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
	lines: LogLine[];
	/** Absolute line number of `lines[0]`; grows as the ring buffer trims the front. */
	baseLine: number;
	bytes: number;
	pending: Record<StreamKind, string>;
	cursors: Map<string, number>;
	stopTimers: ReturnType<typeof setTimeout>[];
	retentionTimer?: ReturnType<typeof setTimeout>;
	waiters: Set<() => void>;
}

interface GlobalProcState {
	records: ProcRecord[];
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
	config: ProcConfig;
	widget?: ProcessesWidget;
	panelActiveUnsubscribe?: () => void;
	stopAllUnsubscribe?: () => void;
	lastPanelVisible?: boolean;
}

const globalKey = Symbol.for("pi-x.proc.state");
const globalState: GlobalProcState =
	((globalThis as unknown as Record<symbol, GlobalProcState | undefined>)[globalKey] ??= {
		records: [],
		config: DEFAULT_CONFIG,
	});

function loadConfig(): ProcConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_CONFIG };

	const raw = parsed as Record<string, unknown>;
	const positiveNumber = (value: unknown, fallback: number, min: number): number => {
		return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
	};

	return {
		maxProcesses: Math.floor(positiveNumber(raw.maxProcesses, DEFAULT_CONFIG.maxProcesses, 1)),
		logLines: Math.floor(positiveNumber(raw.logLines, DEFAULT_CONFIG.logLines, 1)),
		logBytes: Math.floor(positiveNumber(raw.logBytes, DEFAULT_CONFIG.logBytes, 1)),
		exitedRetentionMs: Math.floor(positiveNumber(raw.exitedRetentionMs, DEFAULT_CONFIG.exitedRetentionMs, 0)),
		exitedCap: Math.floor(positiveNumber(raw.exitedCap, DEFAULT_CONFIG.exitedCap, 0)),
		panelEnabled: typeof raw.statusRow === "boolean" ? raw.statusRow : DEFAULT_CONFIG.panelEnabled,
	};
}

function config(): ProcConfig {
	return globalState.config;
}

function stripAnsi(text: string): string {
	return text
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[@-Z\\-_]/g, "");
}

function normalizeLine(raw: string): string | undefined {
	const clean = stripAnsi(raw);
	if (clean.trim().length === 0) return undefined;
	if (clean.length <= MAX_LINE_LENGTH) return clean;
	return `${clean.slice(0, MAX_LINE_LENGTH)}…(+${clean.length - MAX_LINE_LENGTH})`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function renderDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${seconds}s`;
}

function endLine(record: ProcRecord): number {
	return record.baseLine + record.lines.length;
}

function isRunning(record: ProcRecord): boolean {
	if (record.state === "exited") return false;
	if (!record.process) return false;
	return record.process.exitCode === null && !record.process.killed;
}

function findRecord(name: string | undefined): ProcRecord | undefined {
	if (!name) return undefined;
	return globalState.records.find((record) => record.name === name);
}

function requireRecord(name: string | undefined): ProcRecord {
	if (!name) throw new Error("proc: this action requires `name`.");
	const record = findRecord(name);
	if (!record) throw new Error(`proc: no process named "${name}". Use proc list.`);
	return record;
}

function wakeWaiters(record: ProcRecord): void {
	if (record.waiters.size === 0) return;
	const waiters = [...record.waiters];
	record.waiters.clear();
	for (const waiter of waiters) waiter();
}

function waitForProcessExit(record: ProcRecord): Promise<void> {
	if (record.state === "exited") return Promise.resolve();
	return new Promise((resolvePromise) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			record.waiters.delete(finish);
			resolvePromise();
		};
		const timer = setTimeout(finish, PROC_STOP_ALL_MAX_WAIT_MS + 100);
		record.waiters.add(finish);
		if (record.state === "exited") finish();
	});
}

function clearStopTimers(record: ProcRecord): void {
	for (const timer of record.stopTimers) clearTimeout(timer);
	record.stopTimers = [];
}

function removeRecord(record: ProcRecord): void {
	clearStopTimers(record);
	if (record.retentionTimer) {
		clearTimeout(record.retentionTimer);
		record.retentionTimer = undefined;
	}
	wakeWaiters(record);
	globalState.records = globalState.records.filter((candidate) => candidate !== record);
}

function pushLine(record: ProcRecord, source: StreamKind, text: string): void {
	record.lines.push({ source, text });
	record.bytes += text.length + 4;
	while (record.lines.length > config().logLines || record.bytes > config().logBytes) {
		const removed = record.lines.shift();
		if (!removed) break;
		record.bytes -= removed.text.length + 4;
		record.baseLine += 1;
	}
	wakeWaiters(record);
}

function feed(record: ProcRecord, source: StreamKind, chunk: Buffer | string): void {
	const buffer = record.pending[source] + chunk.toString("utf8");
	const parts = buffer.split(/\r\n|\n|\r/);
	record.pending[source] = parts.pop() ?? "";
	for (const part of parts) {
		const line = normalizeLine(part);
		if (line !== undefined) pushLine(record, source, line);
	}
}

function flushPending(record: ProcRecord): void {
	for (const source of ["out", "err"] as const) {
		const pending = record.pending[source];
		record.pending[source] = "";
		if (!pending) continue;
		const line = normalizeLine(pending);
		if (line !== undefined) pushLine(record, source, line);
	}
}

function waitForOutput(record: ProcRecord, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolvePromise) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			record.waiters.delete(onData);
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		};
		const onData = (): void => finish();
		const onAbort = (): void => finish();
		const timer = setTimeout(finish, timeoutMs);
		record.waiters.add(onData);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) finish();
	});
}

function defaultName(command: string): string {
	const tokens = command.trim().split(/\s+/).filter(Boolean);
	const first = tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) ?? tokens[0] ?? "proc";
	const base = basename(first).replace(/^\.\//, "");
	const cleaned = base
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "proc";
}

function sanitizeName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function uniqueRunningName(desired: string): string {
	const taken = (name: string): boolean => globalState.records.some((record) => record.name === name && isRunning(record));
	if (!taken(desired)) return desired;
	let suffix = 2;
	while (taken(`${desired}-${suffix}`)) suffix += 1;
	return `${desired}-${suffix}`;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Process already gone.
		}
	}
}

function unreadCount(record: ProcRecord): number {
	const cursor = record.cursors.get(AGENT_READER) ?? 0;
	return Math.max(0, endLine(record) - Math.max(cursor, record.baseLine));
}

function statusDot(record: ProcRecord): string {
	if (record.state === "exited") {
		const ok = record.exitCode === 0 && !record.exitSignal;
		return ok ? ANSI_GRAY : ANSI_RED;
	}
	if (record.state === "stopping") return ANSI_YELLOW;
	return ANSI_GREEN;
}

function sortRecords(a: ProcRecord, b: ProcRecord): number {
	const rank = (record: ProcRecord): number => (record.state === "exited" ? 1 : 0);
	const byRank = rank(a) - rank(b);
	if (byRank !== 0) return byRank;
	if (a.state === "exited" && b.state === "exited") return (b.endedAt ?? 0) - (a.endedAt ?? 0);
	return a.startedAt - b.startedAt;
}

/** Map live process records to the minimal shape the widget formatter needs. */
function widgetEntries(): ProcessesWidgetEntry[] {
	return globalState.records.map((record) => ({
		name: record.name,
		state: record.state,
		pid: record.pid,
		startedAt: record.startedAt,
		endedAt: record.endedAt,
		exitCode: record.exitCode,
		exitSignal: record.exitSignal,
		unread: unreadCount(record),
	}));
}

function hasVisibleProcesses(): boolean {
	if (!config().panelEnabled) return false;
	return hasVisibleProcessEntries(widgetEntries(), Date.now(), config().exitedRetentionMs);
}

/** Tell the panels extension whether the processes panel should be listed. */
function publishPanelVisibility(): void {
	const pi = globalState.pi;
	if (!pi) return;
	const visible = hasVisibleProcesses();
	if (visible === globalState.lastPanelVisible) return;
	globalState.lastPanelVisible = visible;
	pi.events.emit(PANEL_EVENTS.visibility, { id: PANEL_ID, visible });
}

/** Re-render the above-editor widget and sync panel visibility. */
function publishWidget(): void {
	const widget = globalState.widget;
	if (!widget) return;
	if (!config().panelEnabled) {
		widget.clear();
		publishPanelVisibility();
		return;
	}
	widget.refresh(widgetEntries());
	publishPanelVisibility();
}

/** Announce the processes panel to the panels extension. */
function registerPanel(): void {
	const pi = globalState.pi;
	if (!pi) return;
	const visible = hasVisibleProcesses();
	globalState.lastPanelVisible = visible;
	pi.events.emit(PANEL_EVENTS.register, { id: PANEL_ID, label: PANEL_LABEL, order: PANEL_ORDER, visible });
}

function enforceExitedCap(): void {
	const cap = config().exitedCap;
	const exited = globalState.records
		.filter((record) => record.state === "exited")
		.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
	while (exited.length > cap) {
		const oldest = exited.shift();
		if (oldest) removeRecord(oldest);
	}
}

function scheduleRetention(record: ProcRecord): void {
	if (record.retentionTimer) clearTimeout(record.retentionTimer);
	record.retentionTimer = setTimeout(() => {
		record.retentionTimer = undefined;
		publishWidget();
	}, config().exitedRetentionMs + 100);
}

function exitLabel(record: ProcRecord): string {
	if (record.state !== "exited") return "-";
	if (record.exitSignal) return `signal ${record.exitSignal}`;
	return `code ${record.exitCode ?? "?"}`;
}

function finalizeExit(record: ProcRecord, code: number | null, signal: NodeJS.Signals | null): void {
	if (record.state === "exited") return;
	flushPending(record);
	record.state = "exited";
	record.endedAt = Date.now();
	record.exitCode = code;
	record.exitSignal = signal;
	clearStopTimers(record);
	wakeWaiters(record);
	scheduleRetention(record);
	enforceExitedCap();
	publishWidget();

	const ctx = globalState.ctx;
	if (ctx?.hasUI) {
		const ok = code === 0 && !signal;
		const level = ok ? "info" : "warning";
		ctx.ui.notify(`proc: ${record.name} exited (${exitLabel(record)}) after ${renderDuration(record.endedAt - record.startedAt)}.`, level);
	}
}

function bindProcess(record: ProcRecord, child: ChildProcessWithoutNullStreams): void {
	child.stdout.on("data", (chunk: Buffer) => feed(record, "out", chunk));
	child.stderr.on("data", (chunk: Buffer) => feed(record, "err", chunk));
	child.on("error", (error) => {
		pushLine(record, "err", `error: ${error.message}`);
		finalizeExit(record, null, null);
	});
	child.on("exit", (code, signal) => finalizeExit(record, code, signal));
	child.stdin.on("error", () => {
		// Ignore EPIPE when a process closes stdin early; `write` reports the real failure.
	});
}

interface RunParams {
	command?: string;
	name?: string;
	cwd?: string;
	env?: Record<string, string>;
}

function startProcess(ctx: ExtensionContext, params: RunParams): ProcRecord {
	const command = (params.command ?? "").trim();
	if (!command) throw new Error("proc: `run` requires `command`.");

	const running = globalState.records.filter(isRunning);
	if (running.length >= config().maxProcesses) {
		throw new Error(`proc: max ${config().maxProcesses} running processes reached. Stop or forget one first.`);
	}

	let name: string;
	if (params.name) {
		name = sanitizeName(params.name);
		if (!name) throw new Error("proc: invalid `name`.");
		const existing = findRecord(name);
		if (existing && isRunning(existing)) {
			throw new Error(`proc: "${name}" is already running (pid ${existing.pid ?? "?"}). Stop it or choose another name.`);
		}
		if (existing) removeRecord(existing);
	} else {
		name = uniqueRunningName(defaultName(command));
	}

	const cwd = params.cwd ? (isAbsolute(params.cwd) ? params.cwd : resolve(ctx.cwd, params.cwd)) : ctx.cwd;
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
		throw new Error(`proc: cwd does not exist or is not a directory: ${cwd}`);
	}

	const env: NodeJS.ProcessEnv = { ...process.env, ...(params.env ?? {}) };
	const child = spawn("bash", ["-lc", command], {
		cwd,
		env,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const record: ProcRecord = {
		name,
		command,
		cwd,
		process: child,
		pid: child.pid,
		state: "running",
		startedAt: Date.now(),
		lines: [],
		baseLine: 0,
		bytes: 0,
		pending: { out: "", err: "" },
		cursors: new Map(),
		stopTimers: [],
		waiters: new Set(),
	};
	globalState.records.push(record);
	bindProcess(record, child);
	publishWidget();
	return record;
}

function stopProcess(record: ProcRecord, signal: (typeof SIGNALS)[number] | undefined, force: boolean): void {
	if (!isRunning(record) || !record.process?.pid) {
		throw new Error(`proc: "${record.name}" is not running.`);
	}
	const pid = record.process.pid;
	if (force) {
		killGroup(pid, signal ?? "SIGKILL");
		return;
	}
	record.state = "stopping";
	publishWidget();
	killGroup(pid, signal ?? "SIGTERM");
	if (signal && signal !== "SIGTERM") return;
	record.stopTimers.push(
		setTimeout(() => {
			if (isRunning(record)) killGroup(pid, "SIGKILL");
		}, STOP_ESCALATE_MS),
	);
}

interface LogQuery {
	from?: string;
	lines?: number;
	filter?: StreamKind;
	reader: string;
	wait?: number;
}

function parseFrom(value: string | undefined): { kind: "last" | "start" | "line"; line?: number } {
	if (!value || value === "last") return { kind: "last" };
	if (value === "start") return { kind: "start" };
	const parsed = Number(value);
	if (Number.isFinite(parsed) && parsed >= 0) return { kind: "line", line: Math.floor(parsed) };
	throw new Error(`proc: invalid from="${value}" (expected "last", "start", or a line number).`);
}

function readLogs(record: ProcRecord, query: LogQuery): string {
	const from = parseFrom(query.from);
	const cursor = record.cursors.get(query.reader) ?? 0;

	let start: number;
	let dropped = 0;
	if (from.kind === "start") {
		start = record.baseLine;
	} else if (from.kind === "line") {
		start = Math.max(from.line ?? 0, record.baseLine);
		dropped = Math.max(0, record.baseLine - (from.line ?? 0));
	} else {
		start = Math.max(cursor, record.baseLine);
		dropped = Math.max(0, record.baseLine - cursor);
	}

	const limit = Math.max(1, Math.min(Math.floor(query.lines ?? DEFAULT_LOG_TAIL), MAX_LOG_TAIL));
	const candidates: { abs: number; line: LogLine }[] = [];
	for (let index = 0; index < record.lines.length; index += 1) {
		const abs = record.baseLine + index;
		if (abs < start) continue;
		const line = record.lines[index];
		if (!line) continue;
		if (query.filter && line.source !== query.filter) continue;
		candidates.push({ abs, line });
	}

	const selected = candidates.slice(0, limit);
	const more = candidates.length > selected.length;
	if (from.kind !== "line") {
		const next = selected.length > 0 ? (selected[selected.length - 1]?.abs ?? start) + 1 : start;
		record.cursors.set(query.reader, next);
	}
	const currentCursor = record.cursors.get(query.reader) ?? 0;

	const header = [
		`proc=${record.name}`,
		`state=${record.state}`,
		`pid=${record.pid ?? "-"}`,
		`cursor=${currentCursor}`,
		`dropped=${dropped}`,
		`more=${more}`,
	].join(" ");
	if (selected.length === 0) return `${header}\n(no new output)`;
	return [header, ...selected.map(({ line }) => `${line.source}: ${line.text}`)].join("\n");
}

function formatList(): string {
	const records = [...globalState.records].sort(sortRecords);
	if (records.length === 0) return "No processes. Use proc run to start one.";

	const rows = records.map((record) => {
		const durationMs = (record.state === "exited" && record.endedAt ? record.endedAt : Date.now()) - record.startedAt;
		return [
			record.name,
			record.state,
			record.pid ? String(record.pid) : "-",
			renderDuration(durationMs),
			exitLabel(record),
			String(unreadCount(record)),
		];
	});
	const headers = ["NAME", "STATE", "PID", "DURATION", "EXIT", "UNREAD"];
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
	);
	const formatRow = (cells: string[]): string => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");
	return [formatRow(headers), ...rows.map(formatRow)].join("\n");
}

function formatStatus(record: ProcRecord): string {
	const durationMs = (record.state === "exited" && record.endedAt ? record.endedAt : Date.now()) - record.startedAt;
	const lines = record.lines.slice(-20).map(({ source, text }) => `${source}: ${text}`);
	const details = [
		`proc=${record.name}`,
		`state=${record.state}`,
		`pid=${record.pid ?? "-"}`,
		`command=${record.command}`,
		`cwd=${record.cwd}`,
		`started=${new Date(record.startedAt).toISOString()}`,
		`duration=${renderDuration(durationMs)}`,
		`exit=${exitLabel(record)}`,
		`unread=${unreadCount(record)}`,
		`dropped=${record.baseLine}`,
		`buffered=${record.lines.length}`,
	];
	if (lines.length > 0) details.push("---", ...lines);
	return details.join("\n");
}

function notifyText(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else console.log(text);
}

async function pickName(ctx: ExtensionContext, onlyRunning: boolean): Promise<string | undefined> {
	const candidates = [...globalState.records].sort(sortRecords).filter((record) => !onlyRunning || isRunning(record));
	if (candidates.length === 0) return undefined;
	if (candidates.length === 1) return candidates[0]?.name;
	if (!ctx.hasUI) return candidates[0]?.name;
	const choice = await ctx.ui.select(
		"Select process",
		candidates.map((record) => `${record.name} (${record.state}${record.pid ? `, pid ${record.pid}` : ""})`),
	);
	if (typeof choice !== "string") return undefined;
	return choice.split(" ")[0];
}

/**
 * Interactive process manager for `/px:proc`.
 *
 * List mode: j/k and arrows move the cursor, enter opens the log viewer,
 * d stops a running process (or forgets an exited one), esc/q closes.
 * Log mode: j/k and arrows scroll, g/G jump to top/bottom, esc/q returns.
 */
class ProcManager implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (result: null) => void;
	private readonly pendingForget = new Set<string>();
	private mode: "list" | "logs" = "list";
	private selectedName?: string;
	private listOffset = 0;
	private logName?: string;
	private logOffset = 0;
	private follow = true;
	private status = "";
	private pendingDelete?: string;
	private timer?: ReturnType<typeof setInterval>;

	constructor(tui: TUI, theme: Theme, done: (result: null) => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.timer = setInterval(() => this.tick(), MANAGER_REFRESH_MS);
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	invalidate(): void {
		// Rendering is derived from live process state, so nothing is cached here.
	}

	private currentList(): ProcRecord[] {
		return [...globalState.records].sort(sortRecords);
	}

	private selectedIndex(list: ProcRecord[]): number {
		if (this.selectedName) {
			const index = list.findIndex((record) => record.name === this.selectedName);
			if (index >= 0) return index;
		}
		return 0;
	}

	private listRows(): number {
		return clamp(Math.floor(this.tui.terminal.rows * 0.5), MANAGER_MIN_ROWS, MANAGER_MAX_ROWS);
	}

	private logRows(): number {
		return clamp(Math.floor(this.tui.terminal.rows * 0.6), LOG_MIN_ROWS, LOG_MAX_ROWS);
	}

	/** Remove processes that were killed from the manager once they exited. */
	private tick(): void {
		for (const name of [...this.pendingForget]) {
			const record = findRecord(name);
			if (!record) {
				this.pendingForget.delete(name);
				continue;
			}
			if (!isRunning(record)) {
				removeRecord(record);
				publishWidget();
				this.pendingForget.delete(name);
				this.status = `Removed ${name}.`;
			}
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const border = this.theme.fg("accent", "─".repeat(renderWidth));
		if (this.mode === "logs") return this.renderLogs(renderWidth, border);
		return this.renderList(renderWidth, border);
	}

	private renderList(width: number, border: string): string[] {
		const theme = this.theme;
		const list = this.currentList();
		const rows = this.listRows();
		const selectedIndex = this.selectedIndex(list);
		const lines: string[] = [
			border,
			truncateToWidth(theme.fg("accent", theme.bold(`Processes (${list.length})`)), width),
			theme.fg("dim", "─".repeat(width)),
		];

		if (list.length === 0) {
			lines.push(truncateToWidth(theme.fg("muted", "No processes. Start one with proc run."), width));
			for (let row = 1; row < rows; row += 1) lines.push("");
		} else {
			const maxOffset = Math.max(0, list.length - rows);
			if (selectedIndex < this.listOffset) this.listOffset = selectedIndex;
			if (selectedIndex >= this.listOffset + rows) this.listOffset = selectedIndex - rows + 1;
			this.listOffset = clamp(this.listOffset, 0, maxOffset);
			for (let row = 0; row < rows; row += 1) {
				const record = list[this.listOffset + row];
				if (!record) {
					lines.push("");
					continue;
				}
				lines.push(this.renderListRow(record, this.listOffset + row === selectedIndex, width));
			}
		}

		lines.push(theme.fg("dim", "─".repeat(width)));
		lines.push(truncateToWidth(theme.fg("dim", "↑↓/j k navigate • enter logs • d stop/kill • esc close"), width));
		if (this.status) lines.push(truncateToWidth(theme.fg(this.pendingDelete ? "warning" : "muted", this.status), width));
		return lines;
	}

	private renderListRow(record: ProcRecord, selected: boolean, width: number): string {
		const theme = this.theme;
		const marker = selected ? theme.fg("accent", "▸") : " ";
		const dot = `${statusDot(record)}●${ANSI_RESET}`;
		const durationMs = (record.state === "exited" && record.endedAt ? record.endedAt : Date.now()) - record.startedAt;
		const unread = unreadCount(record);
		const info = [
			record.state,
			record.pid ? `pid ${record.pid}` : "",
			renderDuration(durationMs),
			record.state === "exited" ? exitLabel(record) : "",
			unread > 0 ? `+${unread}` : "",
		]
			.filter(Boolean)
			.join("  ");
		const name = record.name.length > 20 ? `${record.name.slice(0, 19)}…` : record.name.padEnd(20);
		const body = `${name}  ${info}`;
		return truncateToWidth(`${marker} ${dot} ${selected ? theme.fg("accent", body) : body}`, width);
	}

	private renderLogs(width: number, border: string): string[] {
		const theme = this.theme;
		const rows = this.logRows();
		const record = this.logName ? findRecord(this.logName) : undefined;
		const lines: string[] = [border];

		if (!record) {
			lines.push(truncateToWidth(theme.fg("warning", `${this.logName ?? "process"} is gone`), width));
			for (let row = 0; row < rows; row += 1) lines.push("");
			lines.push(theme.fg("dim", "─".repeat(width)));
			lines.push(truncateToWidth(theme.fg("dim", "esc/q back"), width));
			return lines;
		}

		const durationMs = (record.state === "exited" && record.endedAt ? record.endedAt : Date.now()) - record.startedAt;
		const header = `${record.name}  ${record.state}${record.pid ? `  pid ${record.pid}` : ""}  ${renderDuration(durationMs)}  ${exitLabel(record)}`;
		lines.push(truncateToWidth(theme.fg("accent", theme.bold(header)), width));
		lines.push(truncateToWidth(theme.fg("dim", record.command.replace(/\s+/g, " ")), width));
		lines.push(theme.fg("dim", "─".repeat(width)));

		const total = record.lines.length;
		const maxStart = Math.max(0, total - rows);
		const start = this.follow ? maxStart : clamp(this.logOffset, 0, maxStart);
		this.logOffset = start;
		for (let row = 0; row < rows; row += 1) {
			const line = record.lines[start + row];
			if (!line) {
				lines.push("");
				continue;
			}
			const abs = record.baseLine + start + row;
			const source = line.source === "err" ? theme.fg("error", "err:") : theme.fg("dim", "out:");
			const text = line.source === "err" ? theme.fg("error", line.text) : line.text;
			lines.push(truncateToWidth(`${theme.fg("dim", `${String(abs).padStart(4)} `)}${source} ${text}`, width));
		}

		lines.push(theme.fg("dim", "─".repeat(width)));
		const position = total > rows ? `${start + 1}-${Math.min(total, start + rows)}/${total}${this.follow ? " follow" : ""}` : `${total} lines`;
		lines.push(truncateToWidth(theme.fg("dim", `↑↓/j k scroll • g/G top/bottom • esc back    ${position}`), width));
		if (this.status) lines.push(truncateToWidth(theme.fg("muted", this.status), width));
		return lines;
	}

	handleInput(data: string): void {
		if (this.mode === "logs") {
			this.handleLogsInput(data);
			return;
		}
		this.handleListInput(data);
	}

	private handleListInput(data: string): void {
		if (this.pendingDelete) {
			if (data === "y" || data === "Y") {
				const name = this.pendingDelete;
				this.pendingDelete = undefined;
				this.deleteByName(name);
			} else if (data === "n" || data === "N" || data === "q" || matchesKey(data, Key.escape)) {
				this.pendingDelete = undefined;
				this.status = "Cancelled.";
				this.tui.requestRender();
			}
			return;
		}

		const list = this.currentList();
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(null);
			return;
		}
		if (list.length === 0) return;

		const index = this.selectedIndex(list);
		if (matchesKey(data, Key.up) || data === "k") {
			this.selectedName = list[Math.max(0, index - 1)]?.name;
			this.status = "";
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.selectedName = list[Math.min(list.length - 1, index + 1)]?.name;
			this.status = "";
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const record = list[index];
			if (!record) return;
			this.mode = "logs";
			this.logName = record.name;
			this.follow = true;
			this.logOffset = Number.MAX_SAFE_INTEGER;
			this.status = "";
			this.tui.requestRender();
			return;
		}
		if (data === "d") {
			const record = list[index];
			if (!record) return;
			if (isRunning(record)) {
				this.pendingDelete = record.name;
				this.status = `Stop "${record.name}"? (y/N)`;
				this.tui.requestRender();
			} else {
				this.deleteByName(record.name);
			}
		}
	}

	private deleteByName(name: string): void {
		const record = findRecord(name);
		if (!record) {
			this.status = "";
			this.tui.requestRender();
			return;
		}
		try {
			if (isRunning(record)) {
				if (record.state !== "stopping") stopProcess(record, undefined, false);
				this.pendingForget.add(record.name);
				this.status = `Stopping ${record.name}…`;
			} else {
				removeRecord(record);
				publishWidget();
				this.status = `Removed ${record.name}.`;
			}
		} catch (error) {
			this.status = `Failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.tui.requestRender();
	}

	private handleLogsInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.mode = "list";
			this.logName = undefined;
			this.status = "";
			this.tui.requestRender();
			return;
		}

		const record = this.logName ? findRecord(this.logName) : undefined;
		if (!record) return;
		const rows = this.logRows();
		const maxStart = Math.max(0, record.lines.length - rows);
		const currentStart = this.follow ? maxStart : clamp(this.logOffset, 0, maxStart);
		const toBottom = (): void => {
			this.follow = true;
			this.logOffset = maxStart;
		};

		if (matchesKey(data, Key.up) || data === "k") {
			this.follow = false;
			this.logOffset = clamp(currentStart - 1, 0, maxStart);
		} else if (matchesKey(data, Key.down) || data === "j") {
			if (currentStart >= maxStart) toBottom();
			else {
				this.follow = false;
				this.logOffset = currentStart + 1;
			}
		} else if (matchesKey(data, Key.pageUp)) {
			this.follow = false;
			this.logOffset = clamp(currentStart - LOG_SCROLL_STEP, 0, maxStart);
		} else if (matchesKey(data, Key.pageDown)) {
			if (currentStart + LOG_SCROLL_STEP >= maxStart) toBottom();
			else {
				this.follow = false;
				this.logOffset = currentStart + LOG_SCROLL_STEP;
			}
		} else if (data === "g" || matchesKey(data, Key.home)) {
			this.follow = false;
			this.logOffset = 0;
		} else if (data === "G" || matchesKey(data, Key.end)) {
			toBottom();
		} else {
			return;
		}
		this.tui.requestRender();
	}
}

async function openProcManager(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		notifyText(ctx, formatList());
		return;
	}
	await ctx.ui.custom<null>((tui, theme, _keybindings, done) => new ProcManager(tui, theme, done));
}

const ProcToolParams = Type.Object({
	action: StringEnum(PROC_ACTIONS, {
		description: "run=start a background process; list/status=inspect; logs=read output; stop/kill=terminate; write=send stdin; forget=drop an exited process",
	}),
	name: Type.Optional(Type.String({ description: "Process name (id). Required for status/logs/stop/kill/write/forget. Optional for run." })),
	command: Type.Optional(Type.String({ description: "Shell command for run, executed via bash -lc." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for run. Defaults to the current pi cwd." })),
	env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra environment variables for run." })),
	from: Type.Optional(Type.String({ description: "logs: 'last' (default, only new lines), 'start' (earliest retained), or a line number." })),
	lines: Type.Optional(Type.Number({ description: `logs: max lines to return (default ${DEFAULT_LOG_TAIL}, max ${MAX_LOG_TAIL}).` })),
	filter: Type.Optional(StringEnum(["out", "err"] as const, { description: "logs: only stdout or only stderr." })),
	wait: Type.Optional(Type.Number({ description: `logs: wait up to this many seconds (0-${MAX_WAIT_SECONDS}) for new output. Default 0.` })),
	signal: Type.Optional(StringEnum(SIGNALS, { description: "stop/kill: override the signal (default stop=SIGTERM, kill=SIGKILL)." })),
	input: Type.Optional(Type.String({ description: "write: text to send to the process stdin." })),
	newline: Type.Optional(Type.Boolean({ description: "write: append a newline (default true)." })),
	close: Type.Optional(Type.Boolean({ description: "write: close stdin after writing (default false)." })),
});

export default function procExtension(pi: ExtensionAPI): void {
	globalState.config = loadConfig();

	// Re-registering the widget on a reload would otherwise leave the previous
	// instance's subscription alive on a shared event bus.
	globalState.panelActiveUnsubscribe?.();
	globalState.stopAllUnsubscribe?.();

	const widget = new ProcessesWidget({
		setWidget: (content) => {
			// The panel coordinator owns the single above-editor widget. Publish
			// formatted lines there so process refreshes never reorder panels.
			pi.events.emit(PANEL_EVENTS.content, {
				id: PANEL_ID,
				content,
				render: renderProcessesWidgetContent,
			});
		},
		listEntries: () => widgetEntries(),
		styles: () => {
			const theme = globalState.ctx?.ui.theme;
			return {
				bold: (text) => theme?.bold(text) ?? text,
				dim: (text) => theme?.fg("dim", text) ?? text,
				muted: (text) => theme?.fg("muted", text) ?? text,
				accent: (text) => theme?.fg("thinkingHigh", text) ?? text,
				success: (text) => theme?.fg("success", text) ?? text,
				warning: (text) => theme?.fg("warning", text) ?? text,
				error: (text) => theme?.fg("error", text) ?? text,
			};
		},
		exitedRetentionMs: () => config().exitedRetentionMs,
	});
	globalState.widget = widget;

	globalState.panelActiveUnsubscribe = pi.events.on(PANEL_EVENTS.active, (payload) => {
		const activeId = (payload as { activeId?: unknown } | undefined)?.activeId;
		widget.setActive(activeId === PANEL_ID);
	});
	globalState.stopAllUnsubscribe = pi.events.on(PROC_STOP_ALL_REQUEST_EVENT, async (payload) => {
		const request = validateProcStopAllRequest(payload);
		if (!request) return;
		const result = await stopAllRunningProcesses(
			globalState.records,
			(record) => stopProcess(record, undefined, false),
			waitForProcessExit,
		);
		pi.events.emit(PROC_STOP_ALL_REPLY_EVENT, { id: request.id, ...result });
	});

	const startSession = (ctx: ExtensionContext): void => {
		globalState.pi = pi;
		globalState.ctx = ctx;
		// Clear a footer row left by the pre-widget proc extension during /reload.
		// The new Processes widget does not depend on status-bar being installed.
		pi.events.emit("px:status-bar:row:clear", { id: "proc" });
		widget.reset();
		registerPanel();
		publishWidget();
		// Ask panels to replay its current active state; the response arrives as a
		// `px:panels:active` event and expands the widget when proc is active.
		pi.events.emit(PANEL_EVENTS.sync, { id: PANEL_ID });
	};

	pi.on("session_start", async (_event, ctx) => startSession(ctx));
	pi.on("session_tree", async (_event, ctx) => startSession(ctx));

	pi.on("session_shutdown", async (event) => {
		// The extension may be disabled on reload, so do not leave a listener
		// holding the old widget and context on the shared event bus.
		globalState.panelActiveUnsubscribe?.();
		globalState.panelActiveUnsubscribe = undefined;
		globalState.stopAllUnsubscribe?.();
		globalState.stopAllUnsubscribe = undefined;
		// Clear the coordinator's cached content before dropping the session.
		widget.clear();
		if (globalState.ctx) globalState.ctx = undefined;
		if (event.reason === "quit") {
			for (const record of globalState.records) {
				if (isRunning(record) && record.process?.pid) {
					killGroup(record.process.pid, "SIGTERM");
				}
				clearStopTimers(record);
				if (record.retentionTimer) clearTimeout(record.retentionTimer);
				wakeWaiters(record);
			}
			globalState.records = [];
		}
	});

	pi.registerTool({
		name: "proc",
		label: "Process Manager",
		description:
			"Run and manage long-lived background processes. Starts a shell command detached from the agent loop, keeps its stdout/stderr in a ring buffer, and tracks exit status. Use for dev servers, watchers, builds, and anything you do not want to block on.",
		promptSnippet: "Run and manage background processes: run, list, status, logs, stop, kill, write, forget",
		promptGuidelines: [
			"Use proc run to start long-running processes (dev servers, watchers) instead of bash, so they keep running and their output stays readable.",
			"Use proc logs with from:\"last\" to read only output produced since your previous read, and from:\"start\" to read from the beginning of retained output.",
			"Prefer proc stop over proc kill to let processes shut down cleanly.",
		],
		parameters: ProcToolParams,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = { ...(args as Record<string, unknown>) };
			if (typeof input.from === "number") input.from = String(input.from);
			if (typeof input.lines === "string" && /^\d+$/.test(input.lines)) input.lines = Number(input.lines);
			if (typeof input.wait === "string" && /^\d+(?:\.\d+)?$/.test(input.wait)) input.wait = Number(input.wait);
			return input;
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			switch (params.action) {
				case "run": {
					const record = startProcess(ctx, {
						command: params.command,
						name: params.name,
						cwd: params.cwd,
						env: params.env,
					});
					const text = [
						`Started ${record.name} (pid ${record.pid ?? "?"}).`,
						`command: ${record.command}`,
						`cwd: ${record.cwd}`,
						`Read output with proc logs { name: "${record.name}" }.`,
					].join("\n");
					return { content: [{ type: "text", text }], details: { name: record.name, pid: record.pid } };
				}
				case "list": {
					return { content: [{ type: "text", text: formatList() }], details: { count: globalState.records.length } };
				}
				case "status": {
					const record = requireRecord(params.name);
					return { content: [{ type: "text", text: formatStatus(record) }], details: { name: record.name, state: record.state } };
				}
				case "logs": {
					const record = requireRecord(params.name);
					const waitSeconds = Math.max(0, Math.min(Number(params.wait ?? 0) || 0, MAX_WAIT_SECONDS));
					if (waitSeconds > 0) {
						const from = parseFrom(params.from);
						const hasNew = from.kind === "start"
							? record.lines.length > 0
							: endLine(record) > Math.max(record.cursors.get(AGENT_READER) ?? 0, record.baseLine);
						if (!hasNew && isRunning(record)) {
							await waitForOutput(record, waitSeconds * 1000, signal);
						}
					}
					const text = readLogs(record, {
						from: params.from,
						lines: params.lines,
						filter: params.filter,
						reader: AGENT_READER,
					});
					return { content: [{ type: "text", text }], details: { name: record.name, state: record.state } };
				}
				case "stop": {
					const record = requireRecord(params.name);
					stopProcess(record, params.signal, false);
					return { content: [{ type: "text", text: `Stopping ${record.name} (pid ${record.pid ?? "?"}).` }], details: { name: record.name } };
				}
				case "kill": {
					const record = requireRecord(params.name);
					stopProcess(record, params.signal, true);
					return { content: [{ type: "text", text: `Killed ${record.name} (pid ${record.pid ?? "?"}).` }], details: { name: record.name } };
				}
				case "write": {
					const record = requireRecord(params.name);
					if (!isRunning(record) || !record.process) {
						throw new Error(`proc: "${record.name}" is not running; cannot write to stdin.`);
					}
					if (typeof params.input === "string" && params.input.length > 0) {
						record.process.stdin.write(params.newline === false ? params.input : `${params.input}\n`);
					}
					if (params.close) record.process.stdin.end();
					return { content: [{ type: "text", text: `Wrote to ${record.name} stdin.` }], details: { name: record.name } };
				}
				case "forget": {
					const record = requireRecord(params.name);
					if (isRunning(record)) {
						throw new Error(`proc: "${record.name}" is still running; stop it before forgetting.`);
					}
					removeRecord(record);
					publishWidget();
					return { content: [{ type: "text", text: `Forgot ${record.name}.` }], details: { name: record.name } };
				}
				default: {
					throw new Error(`proc: unknown action "${String(params.action)}".`);
				}
			}
		},
	});

	pi.registerCommand("px:proc", {
		description: "Manage background processes interactively, or via list/logs/stop/kill/forget",
		handler: async (rawArgs, ctx) => {
			globalState.pi = pi;
			globalState.ctx = ctx;
			const tokens = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = tokens.shift();

			if (!sub) {
				await openProcManager(ctx);
				return;
			}

			if (sub === "list") {
				notifyText(ctx, formatList());
				return;
			}

			if (sub === "logs") {
				let name = tokens.shift();
				const start = tokens.includes("--start");
				const lineArg = tokens.find((token) => /^\d+$/.test(token));
				if (!name) name = await pickName(ctx, false);
				if (!name) {
					notifyText(ctx, "proc: no processes.", "warning");
					return;
				}
				const record = findRecord(name);
				if (!record) {
					notifyText(ctx, `proc: no process named "${name}".`, "warning");
					return;
				}
				const count = lineArg ? Number(lineArg) : 50;
				const text = readLogs(record, {
					from: start ? "start" : "last",
					lines: Number.isFinite(count) ? count : 50,
					reader: USER_READER,
				});
				notifyText(ctx, text);
				return;
			}

			if (sub === "stop" || sub === "kill" || sub === "forget") {
				let name = tokens.shift();
				const onlyRunning = sub !== "forget";
				if (!name) name = await pickName(ctx, onlyRunning);
				if (!name) {
					notifyText(ctx, "proc: no processes.", "warning");
					return;
				}
				const record = findRecord(name);
				if (!record) {
					notifyText(ctx, `proc: no process named "${name}".`, "warning");
					return;
				}
				try {
					if (sub === "forget") {
						if (isRunning(record)) throw new Error(`"${record.name}" is still running; stop it first.`);
						removeRecord(record);
						publishWidget();
						notifyText(ctx, `Forgot ${record.name}.`);
					} else if (sub === "kill") {
						stopProcess(record, undefined, true);
						notifyText(ctx, `Killed ${record.name} (pid ${record.pid ?? "?"}).`);
					} else {
						stopProcess(record, undefined, false);
						notifyText(ctx, `Stopping ${record.name} (pid ${record.pid ?? "?"}).`);
					}
				} catch (error) {
					notifyText(ctx, `proc: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
				return;
			}

			notifyText(ctx, "Usage: /px:proc | /px:proc list | /px:proc logs <name> [lines] [--start] | /px:proc stop|kill|forget [name]", "warning");
		},
	});
}
