/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildAgentLogPicker,
	formatAgentLog,
	formatAgentLogEntry,
	mergeAgentLogEntries,
	persistedAgentLogEntries,
	registryAgentLogEntries,
} from "./agent-log.ts";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.ts";
import { ApprovalQueue } from "./approval-queue.ts";
import { registerChildControls } from "./control.ts";
import {
	applyRpcStreamEvent,
	emptyUsage,
	interruptActiveTools,
	setLatestToolApprovalState,
	type RpcStreamState,
} from "./events.ts";
import {
	type DispatchRunner,
	type OnUpdateCallback,
	runDispatch,
} from "./dispatch.ts";
import { spawnRpcChild, type RpcChild } from "./rpc-client.ts";
import { sendControl, SubagentRegistry } from "./registry.ts";
import { getFinalOutput, getRunningOutput, isFailedResult } from "./result-output.ts";
import { createRunIdGenerator } from "./run-id.ts";
import { appendSafeModeArgs, querySafeModeSnapshot, type SafeModeSnapshot } from "./safe-mode.ts";
import {
	formatSubagentStatusRow,
	StatusBarPresence,
	SUBAGENT_STATUS_ROW_ID,
	SUBAGENT_STATUS_ROW_ORDER,
} from "./status-row.ts";
import { formatSubagentTiming, SubagentTimingTracker } from "./timing.ts";
import type { SingleResult, SubagentDetails, ToolRunStatus } from "./types.ts";

const COLLAPSED_ITEM_COUNT = 10;

// hub permission protocol (see extensions/hub/PROTOCOL.md)
const HUB_ID = "subagent";
const HUB_ASK_EVENT = "hub:ask";
const HUB_ANSWER_EVENT = "hub:answer";
const HUB_PERMISSION_TIMEOUT_MS = 10 * 60_000;
const PERM_AGENT = "perm:agent";

// Generic status-bar row contract (see extensions/status-bar/contract.ts).
const STATUS_BAR_EVENTS = {
	rowSet: "px:status-bar:row:set",
	rowClear: "px:status-bar:row:clear",
	ping: "px:status-bar:ping",
	pong: "px:status-bar:pong",
} as const;
const STATUS_BAR_WARNING_DELAY_MS = 500;

function newHubRequestId(): string {
	return `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatResultTiming(result: SingleResult): string | undefined {
	if (result.exitCode === -1 || !result.timing) return undefined;
	const cancelled = result.stopReason === "aborted" || /abort/i.test(result.errorMessage ?? "");
	const outcome = cancelled ? "cancelled" : isFailedResult(result) ? "failed" : "finished";
	return formatSubagentTiming(result.timing, outcome);
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
	thinkingLevel?: ThinkingLevel,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(thinkingLevel ? `${model} (${thinkingLevel})` : model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}


type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any>; status?: ToolRunStatus; summary?: string };

function getDisplayItems(result: SingleResult): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of result.messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") {
					const run = result.toolRuns?.find((item) => item.toolCallId === part.id);
					items.push({ type: "toolCall", name: part.name, args: part.arguments, status: run?.status, summary: run?.summary });
				}
			}
		}
	}
	return items;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	getSafeModeSnapshot: () => Promise<SafeModeSnapshot | undefined>,
	runId: string,
	activeChildren: Set<RpcChild>,
	approvalQueue: ApprovalQueue,
	parentContext: ExtensionContext,
	registry: SubagentRegistry,
): Promise<SingleResult> {
	const timing = new SubagentTimingTracker();
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			timing: timing.finish(),
		};
	}

	const args: string[] = ["--mode", "rpc", "--no-session"];
	let safeModeSnapshot: SafeModeSnapshot | undefined;
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	const thinkingLevel = agent.thinking ?? (inheritsDispatchConfig ? dispatchDefaults.thinkingLevel : undefined);
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model,
		thinkingLevel,
		step,
		runId,
		state: "starting",
	};

	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	const emitUpdate = () => {
		if (updateTimer) {
			clearTimeout(updateTimer);
			updateTimer = undefined;
		}
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getRunningOutput(currentResult) }],
				details: makeDetails([currentResult]),
			});
		}
	};
	const emitUpdateThrottled = () => {
		if (!onUpdate || updateTimer) return;
		updateTimer = setTimeout(emitUpdate, 50);
	};

	let child: RpcChild | undefined;
	let removeAbortListener: (() => void) | undefined;
	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		safeModeSnapshot = await getSafeModeSnapshot();
		appendSafeModeArgs(args, safeModeSnapshot);
		currentResult.inheritedMode = safeModeSnapshot?.mode;
		currentResult.effectiveMode = safeModeSnapshot?.mode;
		currentResult.outerAccess = safeModeSnapshot?.outerAccess;
		let wasAborted = false;
		let resolveCompletion!: () => void;
		const completion = new Promise<void>((resolve) => {
			resolveCompletion = resolve;
		});
		const streamState: RpcStreamState = { liveText: "", settled: false };
		let uiDialogCount = 0;
		const invocation = getPiInvocation(args);
		child = spawnRpcChild({
			command: invocation.command,
			args: invocation.args,
			cwd: cwd ?? defaultCwd,
			env: {
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_RUN_ID: runId,
				PI_SUBAGENT_NAME: agent.name,
			},
			events: {
				onStreamEvent(event) {
					timing.record(event);
					if (applyRpcStreamEvent(currentResult, streamState, event)) {
						if (event.type === "message_update") emitUpdateThrottled();
						else emitUpdate();
					}
					if (streamState.settled) resolveCompletion();
				},
				onExtensionUiRequest(request) {
					void (async () => {
						const fireAndForget = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
						if (fireAndForget.has(request.method)) {
							if (
								request.method === "setStatus" &&
								request.statusKey === "px:subagent-control" &&
								typeof request.statusText === "string"
							) {
								try {
									const status = JSON.parse(request.statusText) as {
										kind?: string;
										state?: { mode?: string; outerAccess?: boolean } | string;
										error?: string;
									};
									if (status.kind === "pause" && typeof status.state === "string") {
										currentResult.state = status.state === "pause-requested" ? "pause-requested" : status.state === "paused" ? "paused" : "running";
									} else if (status.kind === "state" && typeof status.state === "object" && status.state) {
										if (["paranoid", "reader", "smart", "yolo"].includes(status.state.mode ?? "")) currentResult.effectiveMode = status.state.mode as typeof currentResult.effectiveMode;
										if (typeof status.state.outerAccess === "boolean") currentResult.outerAccess = status.state.outerAccess;
									} else if (status.kind === "error" && status.error) {
										(currentResult.diagnostics ??= []).push(status.error);
									}
									emitUpdate();
								} catch {
									(currentResult.diagnostics ??= []).push("Malformed child control status");
								}
								return;
							}
							if (request.method === "notify" && typeof request.message === "string" && parentContext.hasUI) {
								const kind = request.notifyType === "warning" || request.notifyType === "error" ? request.notifyType : "info";
								parentContext.ui.notify(`[${agent.name} ${runId}] ${request.message.slice(0, 1000)}`, kind);
							}
							return;
						}
						if (!["select", "confirm", "input", "editor"].includes(request.method)) return;
						const denyWithoutUi = () => {
							if (request.method === "select" && Array.isArray(request.options) && request.options.includes("[N]o")) {
								return { type: "extension_ui_response" as const, id: request.id, value: "[N]o" };
							}
							if (request.method === "confirm") {
								return { type: "extension_ui_response" as const, id: request.id, confirmed: false };
							}
							return { type: "extension_ui_response" as const, id: request.id, cancelled: true as const };
						};
						uiDialogCount++;
						setLatestToolApprovalState(currentResult, "waiting");
						if (!parentContext.hasUI || uiDialogCount > 20) {
							setLatestToolApprovalState(currentResult, "denied");
							emitUpdate();
							try {
								child?.respondUi(denyWithoutUi());
							} catch {}
							return;
						}
						currentResult.state = "waiting-approval";
						currentResult.pendingApproval = {
							requestId: request.id,
							method: request.method,
							title: typeof request.title === "string" ? request.title.slice(0, 300) : undefined,
						};
						emitUpdate();
						const heading = `Subagent: ${agent.name} [${runId}]\nWorking directory: ${cwd ?? defaultCwd}\n\n${typeof request.title === "string" ? request.title.slice(0, 500) : "Approval requested"}`;
						const timeout = typeof request.timeout === "number" ? Math.min(Math.max(request.timeout, 0), 300_000) : undefined;
						const response = await approvalQueue.enqueue({
							runId,
							requestId: request.id,
							async run(dialogSignal) {
								if (request.method === "select") {
									const options = Array.isArray(request.options)
										? request.options.filter((item): item is string => typeof item === "string").slice(0, 50).map((item) => item.slice(0, 500))
										: [];
									const value = await parentContext.ui.select(heading, options, { signal: dialogSignal, timeout });
									return value === undefined ? denyWithoutUi() : { type: "extension_ui_response" as const, id: request.id, value };
								}
								if (request.method === "confirm") {
									const message = typeof request.message === "string" ? request.message.slice(0, 4000) : "Confirm?";
									const confirmed = await parentContext.ui.confirm(heading, message, { signal: dialogSignal, timeout });
									return { type: "extension_ui_response" as const, id: request.id, confirmed };
								}
								if (request.method === "input") {
									const placeholder = typeof request.placeholder === "string" ? request.placeholder.slice(0, 1000) : undefined;
									const value = await parentContext.ui.input(heading, placeholder, { signal: dialogSignal, timeout });
									return value === undefined ? denyWithoutUi() : { type: "extension_ui_response" as const, id: request.id, value };
								}
								const prefill = typeof request.prefill === "string" ? request.prefill.slice(0, 10_000) : undefined;
								const value = await parentContext.ui.editor(heading, prefill);
								return value === undefined ? denyWithoutUi() : { type: "extension_ui_response" as const, id: request.id, value };
							},
						}).catch(() => undefined);
						currentResult.pendingApproval = undefined;
						if (currentResult.state === "waiting-approval") currentResult.state = "running";
						const finalResponse = response ?? denyWithoutUi();
						const denied =
							("cancelled" in finalResponse && finalResponse.cancelled) ||
							("confirmed" in finalResponse && !finalResponse.confirmed) ||
							("value" in finalResponse && finalResponse.value === "[N]o");
						setLatestToolApprovalState(currentResult, denied ? "denied" : "approved");
						emitUpdate();
						try {
							child?.respondUi(finalResponse);
						} catch {
							// Child exit races with queued dialog completion.
						}
					})();
				},
				onProtocolDiagnostic(message) {
					const diagnostics = (currentResult.diagnostics ??= []);
					if (diagnostics.length < 20) diagnostics.push(message);
				},
				onExit() {
					resolveCompletion();
				},
			},
		});
		activeChildren.add(child);
		registry.start({
			runId,
			agentName: agent.name,
			task,
			cwd: cwd ?? defaultCwd,
			startedAt: Date.now(),
			result: currentResult,
			child,
		});

		const abort = () => {
			wasAborted = true;
			currentResult.state = "aborting";
			interruptActiveTools(currentResult, "Parent aborted the subagent");
			emitUpdate();
			try {
				child?.send({ id: `abort-${runId}`, type: "abort" });
			} catch {
				void child?.terminate();
			}
		};
		if (signal) {
			if (signal.aborted) abort();
			else {
				signal.addEventListener("abort", abort, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", abort);
			}
		}

		try {
			const acknowledgement = await child.request(
				{ id: `prompt-${runId}`, type: "prompt", message: `Task: ${task}` },
				30_000,
			);
			if (!acknowledgement.success) {
				currentResult.exitCode = 1;
				currentResult.state = "failed";
				currentResult.errorMessage = acknowledgement.error;
				return currentResult;
			}
			await completion;
			if (wasAborted) throw new Error("Subagent was aborted");
			if (streamState.settled) {
				currentResult.exitCode = 0;
			} else {
				const exited = await child.exit;
				interruptActiveTools(currentResult, "Child exited before the tool completed");
				currentResult.exitCode = exited.code ?? 1;
				currentResult.state = "failed";
				currentResult.errorMessage ||= child.stderr || "RPC child exited before settling";
			}
		} catch (error) {
			if (wasAborted) throw new Error("Subagent was aborted");
			interruptActiveTools(currentResult, "Subagent failed before the tool completed");
			currentResult.exitCode = 1;
			currentResult.state = "failed";
			currentResult.errorMessage = error instanceof Error ? error.message : String(error);
		}
		currentResult.stderr = child.stderr;
		return currentResult;
	} finally {
		if (updateTimer) clearTimeout(updateTimer);
		removeAbortListener?.();
		approvalQueue.cancelRun(runId);
		currentResult.timing = timing.finish();
		registry.complete(runId);
		if (child) {
			await child.terminate();
			activeChildren.delete(child);
		}
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task; {previous} is replaced with the previous step's final output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	const childControl = registerChildControls(pi);
	// Surface agent names + brief descriptions in the tool description so the
	// model can choose deliberately without trial and error. Important for
	// opt-in agents like `ultra-reviewer-explicit`. Uses user-scope only, which
	// matches the default agentScope. Computed once at registration; the agent
	// list is re-discovered per invocation for actual execution.
	const getSafeModeSnapshot = () => querySafeModeSnapshot(pi.events);
	const activeChildren = new Set<RpcChild>();
	const approvalQueue = new ApprovalQueue();

	let sessionContext: ExtensionContext | undefined;
	let shuttingDown = false;

	const statusBarPresence = new StatusBarPresence({
		delayMs: STATUS_BAR_WARNING_DELAY_MS,
		timers: {
			set: (fn, delayMs) => setTimeout(fn, delayMs),
			clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		},
		onPing: () => pi.events.emit(STATUS_BAR_EVENTS.ping, { id: SUBAGENT_STATUS_ROW_ID }),
		onWarn: () => {
			if (sessionContext?.hasUI) {
				sessionContext.ui.notify(
					"subagent: status-bar extension not detected; the running-count row will not show",
					"warning",
				);
			}
		},
	});

	const registry = new SubagentRegistry(30, () => publishSubagentRow());
	const newRunId = createRunIdGenerator();

	function runningSubagentCount(): number {
		return registry.list().filter((run) => !run.completedAt).length;
	}

	// Publish one generic status-bar row (order 50, above proc's 100) only while
	// at least one child is running. When the last child finishes, clear it and
	// cancel any pending "status-bar missing" warning.
	function publishSubagentRow(): void {
		const content = shuttingDown ? undefined : formatSubagentStatusRow(runningSubagentCount());
		if (!content) {
			statusBarPresence.cancel();
			pi.events.emit(STATUS_BAR_EVENTS.rowClear, { id: SUBAGENT_STATUS_ROW_ID });
			return;
		}
		statusBarPresence.watch();
		pi.events.emit(STATUS_BAR_EVENTS.rowSet, {
			id: SUBAGENT_STATUS_ROW_ID,
			content,
			order: SUBAGENT_STATUS_ROW_ORDER,
		});
	}

	if (!childControl) {
		pi.registerCommand("px:agents", {
			description: "Manage active and recent subagent runs",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) return;
				while (true) {
					const runs = registry.list();
					if (runs.length === 0) {
						ctx.ui.notify("No subagent runs yet.", "info");
						return;
					}
					const labels = runs.map((run) => {
						const elapsed = Math.max(0, Math.floor(((run.completedAt ?? Date.now()) - run.startedAt) / 1000));
						const mode = run.result.effectiveMode?.toUpperCase() ?? "UNKNOWN";
						const state = run.completedAt ? (isFailedResult(run.result) ? "FAILED" : "COMPLETED") : (run.result.state ?? "running").toUpperCase();
						return `${run.agentName} [${run.runId}]  ${state}  ${mode}  ${Math.floor(elapsed / 60).toString().padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`;
					});
					labels.push("Close");
					const selected = await ctx.ui.select("Subagent manager", labels);
					if (!selected || selected === "Close") return;
					const run = runs[labels.indexOf(selected)];
					if (!run) continue;
					const actions = run.completedAt
						? ["Details", "Back"]
						: [
							"Details",
							"Configure permissions",
							...(run.result.state === "paused" || run.result.state === "pause-requested" || run.result.state === "resuming" ? ["Resume"] : ["Pause"]),
							"Abort",
							"Back",
						];
					const action = await ctx.ui.select(`${run.agentName} [${run.runId}]`, actions);
					if (!action || action === "Back") continue;
					if (action === "Details") {
						const details = [
							`Agent: ${run.agentName} [${run.runId}]`,
							`State: ${run.result.state ?? "unknown"}`,
							`PID: ${run.child?.pid ?? "n/a"}`,
							`CWD: ${run.cwd}`,
							`Inherited: ${run.result.inheritedMode ?? "unknown"}`,
							`Effective: ${run.result.effectiveMode ?? "unknown"}${run.result.outerAccess ? "+" : ""}`,
							`Task: ${run.task}`,
							...(run.result.pendingApproval ? [`Pending approval: ${run.result.pendingApproval.method} — ${run.result.pendingApproval.title ?? "untitled"}`] : []),
							...(run.result.diagnostics ?? []).map((item) => `Diagnostic: ${item}`),
						].join("\n");
						await ctx.ui.editor(`Subagent details: ${run.runId}`, details);
						continue;
					}
					try {
						if (action === "Pause") {
							run.result.state = "pause-requested";
							await sendControl(run, "pause");
						} else if (action === "Resume") {
							run.result.state = "resuming";
							await sendControl(run, "resume");
						} else if (action === "Configure permissions") {
							const mode = await ctx.ui.select("Safe mode", ["paranoid", "reader", "smart", "yolo"]);
							if (!mode) continue;
							const outerChoice = await ctx.ui.select("Outer access", ["off", "on"]);
							if (!outerChoice) continue;
							if ((mode === "yolo" || outerChoice === "on") && !(await ctx.ui.confirm("Confirm child permissions", `Set ${run.runId} to ${mode}${outerChoice === "on" ? "+" : ""}?`))) continue;
							await sendControl(run, `mode ${mode} outer-${outerChoice}`);
						} else if (action === "Abort") {
							if (!(await ctx.ui.confirm("Abort subagent", `Abort ${run.agentName} [${run.runId}]?`))) continue;
							run.result.state = "aborting";
							try { run.child?.send({ id: `abort-${run.runId}`, type: "abort" }); } catch {}
							await run.child?.terminate();
						}
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
				}
			},
		});

		pi.registerCommand("px:agent:log", {
			description: "View the task prompt and final output for each subagent run",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) return;
				const persisted = persistedAgentLogEntries(ctx.sessionManager.getBranch());
				const entries = mergeAgentLogEntries(registryAgentLogEntries(registry.list()), persisted);
				if (entries.length === 0) {
					ctx.ui.notify("No subagent runs recorded in this session.", "info");
					return;
				}
				const { labels, byLabel } = buildAgentLogPicker(entries);
				const selectable = [...labels, "View all runs", "Close"];
				const selected = await ctx.ui.select("Subagent log", selectable);
				if (!selected || selected === "Close") return;
				if (selected === "View all runs") {
					await ctx.ui.editor("Subagent log (all runs)", formatAgentLog(entries));
					return;
				}
				const entry = byLabel.get(selected);
				if (!entry) return;
				const title = entry.runId
					? `Subagent log: ${entry.agentName} [${entry.runId}]`
					: `Subagent log: ${entry.agentName}`;
				await ctx.ui.editor(title, formatAgentLogEntry(entry));
			},
		});
	}

	pi.events.on(STATUS_BAR_EVENTS.pong, (payload) => {
		const id = (payload as { id?: unknown } | undefined)?.id;
		if (id !== SUBAGENT_STATUS_ROW_ID) return;
		statusBarPresence.markAvailable();
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionContext = ctx;
		shuttingDown = false;
		statusBarPresence.reset();
		statusBarPresence.ping();
		publishSubagentRow();
	});

	pi.on("session_tree", async (_event, ctx) => {
		sessionContext = ctx;
		publishSubagentRow();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		statusBarPresence.reset();
		sessionContext = undefined;
		pi.events.emit(STATUS_BAR_EVENTS.rowClear, { id: SUBAGENT_STATUS_ROW_ID });
		await Promise.all([...activeChildren].map((child) => child.terminate()));
		activeChildren.clear();
	});

	const registeredAgents = formatAgentList(discoverAgents(process.cwd(), "user").agents, 50);
	const agentListText =
		registeredAgents.remaining > 0
			? `${registeredAgents.text} (+${registeredAgents.remaining} more)`
			: registeredAgents.text;

	// Ask the hub for a permission decision. Resolves with the returned action,
	// or undefined when no provider answers within the timeout.
	const askHubPermission = (
		what: string,
		data: Record<string, unknown>,
		ctx: ExtensionContext,
	): Promise<string | undefined> => {
		const id = newHubRequestId();

		return new Promise((resolve) => {
			let settled = false;

			const finish = (action: string | undefined): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				off();
				resolve(action);
			};

			const off = pi.events.on(HUB_ANSWER_EVENT, (payload) => {
				if (typeof payload !== "object" || payload === null) return;
				const answer = payload as { id?: unknown; results?: unknown };
				if (answer.id !== id || !Array.isArray(answer.results)) return;

				const match = answer.results.find(
					(result) => typeof result === "object" && result !== null && (result as { what?: unknown }).what === what,
				);
				const action = (match as { action?: unknown } | undefined)?.action;
				finish(typeof action === "string" ? action : undefined);
			});

			const timer = setTimeout(() => finish(undefined), HUB_PERMISSION_TIMEOUT_MS);

			pi.events.emit(HUB_ASK_EVENT, { id, from: HUB_ID, cap: [{ what, data }], ctx });
		});
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential; {previous} in a step task is replaced with the previous step's final output).",
			`Available agents: ${agentListText}.`,
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const availableAgents = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${availableAgents}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const decision = await askHubPermission(
						PERM_AGENT,
						{
							agents: names,
							source: dir,
							cwd: ctx.cwd,
						},
						ctx,
					);
					if (decision !== "allow")
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			const dispatchRunner: DispatchRunner = {
				availableAgents,
				makeDetails,
				runSingle: ({ agent, task, cwd, step, signal: runSignal, onUpdate: runUpdate, makeDetails: runMakeDetails }) =>
					runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						agent,
						task,
						cwd,
						step,
						runSignal,
						runUpdate,
						runMakeDetails,
						getSafeModeSnapshot,
						newRunId(),
						activeChildren,
						approvalQueue,
						ctx,
						registry,
					),
			};

			return runDispatch(params, dispatchRunner, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderToolItem = (item: Extract<DisplayItem, { type: "toolCall" }>): string => {
				const call = theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme));
				const status = item.status ?? "running";
				const outcome =
					status === "completed"
						? theme.fg("success", "✓ completed")
						: status === "blocked"
							? theme.fg("warning", "⊘ blocked")
							: status === "failed"
								? theme.fg("error", "✗ failed")
								: status === "interrupted"
									? theme.fg("error", "⚠ interrupted")
									: status === "waiting-approval"
										? theme.fg("warning", "⏸ waiting approval")
										: status === "approved"
											? theme.fg("success", "✓ approved, running")
											: theme.fg("warning", "⏳ running");
				const reason = item.summary && status !== "completed" ? ` — ${theme.fg("dim", item.summary)}` : "";
				return `${call}  ${outcome}${reason}`;
			};

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${renderToolItem(item)}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isActive = r.exitCode === -1;
				const isError = !isActive && isFailedResult(r);
				const icon = isActive ? theme.fg("warning", "⏳") : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isActive) header += ` ${theme.fg("warning", `[${r.state ?? "running"}]`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall") container.addChild(new Text(renderToolItem(item), 0, 0));
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const timingStr = formatResultTiming(r);
					const usageStr = formatUsageStats(r.usage, r.model, r.thinkingLevel);
					if (timingStr || usageStr) container.addChild(new Spacer(1));
					if (timingStr) container.addChild(new Text(theme.fg("dim", timingStr), 0, 0));
					if (usageStr) container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isActive) text += ` ${theme.fg("warning", `[${r.state ?? "running"}]`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const timingStr = formatResultTiming(r);
				const usageStr = formatUsageStats(r.usage, r.model, r.thinkingLevel);
				if (timingStr) text += `\n${theme.fg("dim", timingStr)}`;
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const chainRunning = details.results.some((r) => r.exitCode === -1);
				const icon = chainRunning
					? theme.fg("warning", "⏳")
					: successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls and their outcomes.
						for (const item of displayItems) {
							if (item.type === "toolCall") container.addChild(new Text(renderToolItem(item), 0, 0));
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepTiming = formatResultTiming(r);
						const stepUsage = formatUsageStats(r.usage, r.model, r.thinkingLevel);
						if (stepTiming) container.addChild(new Text(theme.fg("dim", stepTiming), 0, 0));
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					const stepTiming = formatResultTiming(r);
					if (stepTiming) text += `\n${theme.fg("dim", stepTiming)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls and their outcomes.
						for (const item of displayItems) {
							if (item.type === "toolCall") container.addChild(new Text(renderToolItem(item), 0, 0));
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskTiming = formatResultTiming(r);
						const taskUsage = formatUsageStats(r.usage, r.model, r.thinkingLevel);
						if (taskTiming) container.addChild(new Text(theme.fg("dim", taskTiming), 0, 0));
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r);
					const stateLabel = r.exitCode === -1 ? ` ${theme.fg("warning", `[${r.state ?? "running"}]`)}` : "";
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}${stateLabel}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					const taskTiming = formatResultTiming(r);
					if (taskTiming) text += `\n${theme.fg("dim", taskTiming)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
