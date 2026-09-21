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
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	getSelectListTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Editor, Markdown, Spacer, Text, type EditorTheme } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildAgentLogPicker,
	findPersistedAgentLogEntry,
	formatAgentLog,
	formatAgentLogEntry,
	mergeAgentLogEntries,
	persistedAgentLogEntries,
	registryAgentLogEntries,
	type AgentLogEntry,
} from "./agent-log.ts";
import { type AgentScope, discoverAgents, formatAgentList } from "./agents.ts";
import { ApprovalQueue } from "./approval-queue.ts";
import { AttachView } from "./attach-view.ts";
import { registerChildControls } from "./control.ts";
import {
	executeSubagentControl,
	formatControlCall,
	isSubagentControlRequest,
	parseSubagentControl,
	type SubagentControlInput,
} from "./control-ops.ts";
import {
	applyRpcStreamEvent,
	emptyUsage,
	interruptActiveTools,
	setLatestToolApprovalState,
	type RpcStreamState,
} from "./events.ts";
import {
	buildAsyncStartResult,
	buildCompletionRenderBlocks,
	buildCompletionRenderData,
	buildNotStartedResult,
	formatCompletionRenderText,
	SUBAGENT_COMPLETION_CUSTOM_TYPE,
} from "./completion.ts";
import {
	type DispatchRuntimeDependencies,
	type SingleRunRequest,
	buildDispatchExceptionResult,
	runPreparedDispatch,
	SubagentAbortError,
} from "./dispatch.ts";
import { AsyncDispatchManager } from "./lifecycle.ts";
import {
	ManagerHerdrActions,
	buildManagerPicker,
	clearHerdrLocation,
	descriptorFromEntry,
	descriptorFromRun,
	hasHerdrPane,
	managerActions,
	managerDetails,
	mergeManagerDescriptors,
	type ManagerRunDescriptor,
} from "./manager.ts";
import { formatResultTiming, formatToolCall, formatToolStatus, formatUsageStats } from "./format.ts";
import { combineAbortSignals } from "./execution.ts";
import { prepareSubagentDispatch, type SubagentRequest } from "./prepare.ts";
import {
	HerdrSubagentBackend,
	ProcessSubagentBackend,
	retainedHerdrLocation,
	type SubagentBackend,
} from "./backend.ts";
import { createHerdrBridgeLauncher, createSingleFlight, preflightHerdr } from "./herdr-preflight.ts";
import { HERDR_BACKGROUND_EVENT, herdrBackgroundPayload } from "./herdr-background.ts";
import {
	cleanupStaleHerdrTabRecords,
	createParentHerdrTab,
	resolveHerdrTabStateDirectory,
	type HerdrDisposeReason,
	type ParentHerdrTab,
} from "./herdr-tab.ts";
import { readHerdrEnvironment, type HerdrClient, type HerdrEnvironment } from "./herdr-client.ts";
import { type RpcChild } from "./rpc-client.ts";
import { sendControl, sendSteer, SubagentRegistry, type SubagentRunRuntime } from "./registry.ts";
import { DEFAULT_STOP_ESCALATION_MS, RunStopController } from "./run-stop.ts";
import { getFinalOutput, getRunningOutput, isFailedResult } from "./result-output.ts";
import { createRunIdGenerator } from "./run-id.ts";
import { appendSafeModeArgs, querySafeModeSnapshot, type SafeModeSnapshot } from "./safe-mode.ts";
import { ACTIVE_SUBAGENT_WIDGET_ID, ActiveSubagentWidget } from "./status-row.ts";
import { SubagentTimingTracker } from "./timing.ts";
import type {
	PreparedSubagentDispatch,
	SingleResult,
	SubagentBackendKind,
	SubagentDetails,
	SubagentRunOutcome,
	ToolRunStatus,
} from "./types.ts";

const COLLAPSED_ITEM_COUNT = 10;

// Nerd Font hourglass shown while a subagent run is still active (replaces the
// `⏳` emoji, which renders inconsistently across terminals).
const RUNNING_ICON = "\u{f051f}";

// hub permission protocol (see extensions/hub/PROTOCOL.md)
const HUB_ID = "subagent";
const HUB_ASK_EVENT = "hub:ask";
const HUB_ANSWER_EVENT = "hub:answer";
const HUB_PERMISSION_TIMEOUT_MS = 10 * 60_000;

function newHubRequestId(): string {
	return `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

interface SingleAgentRuntimeDependencies {
	activeChildren: Set<RpcChild>;
	approvalQueue: ApprovalQueue;
	parentContext: ExtensionContext;
	registry: SubagentRegistry;
	/** Select the RPC transport for a prepared dispatch (process or Herdr). */
	backendFor: (kind: SubagentBackendKind | undefined) => SubagentBackend;
	/** Session-level abort signal; aborted once during shutdown. */
	shutdownSignal: AbortSignal;
	/** Refresh the active-subagents widget after a visible progress change. */
	onProgress?: () => void;
}

async function runSingleAgent(
	request: SingleRunRequest,
	dispatch: PreparedSubagentDispatch,
	runtime: SingleAgentRuntimeDependencies,
): Promise<SingleResult> {
	const { agent: agentName, task, cwd, step, signal: parentSignal, onUpdate, makeDetails, runId, chainKey } = request;
	// A blocking run must also abort when the session shuts down. Combine the
	// tool signal with the session-level shutdown signal so a Herdr pane is
	// never spawned (or left running) after teardown began.
	const signal = combineAbortSignals(parentSignal, runtime.shutdownSignal);
	const defaultCwd = dispatch.cwd;
	const dispatchDefaults = dispatch.dispatchDefaults;
	const agents = dispatch.agents;
	const getSafeModeSnapshot = async () => dispatch.safeModeSnapshot;
	const { activeChildren, approvalQueue, parentContext, registry } = runtime;
	const timing = new SubagentTimingTracker();
	const agent = agents.find((a) => a.name === agentName);

	// A queued child can start after its dispatch (or parent turn) was already
	// aborted. Never spawn or prompt it; report an aborted result immediately so
	// the aggregate still accounts for the planned item.
	if (signal?.aborted) {
		return {
			agent: agentName,
			agentSource: agent?.source ?? "unknown",
			task,
			cwd: cwd ?? defaultCwd,
			exitCode: 1,
			messages: [],
			stderr: "Subagent was aborted before it started",
			errorMessage: "Subagent was aborted before it started",
			stopReason: "aborted",
			usage: emptyUsage(),
			step,
			runId,
			state: "failed",
			timing: timing.finish(),
		};
	}

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
		cwd: cwd ?? defaultCwd,
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
				details: makeDetails([currentResult], "started"),
			});
		}
		runtime.onProgress?.();
	};
	const emitUpdateThrottled = () => {
		// Throttle only. `emitUpdate` already handles a missing `onUpdate` (async
		// dispatches pass none) but must still run so the widget refreshes from
		// `message_update` deltas independently of the parent tool update stream.
		if (updateTimer) return;
		updateTimer = setTimeout(emitUpdate, 50);
	};

	let child: RpcChild | undefined;
	let removeAbortListener: (() => void) | undefined;
	let stop: RunStopController | undefined;
	// Hoisted so the finally block can classify the run's terminal outcome for
	// the backend (for example to recycle or retain a Herdr pane).
	let wasAborted = false;
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
		let resolveCompletion!: () => void;
		const completion = new Promise<void>((resolve) => {
			resolveCompletion = resolve;
		});
		const streamState: RpcStreamState = { liveText: "", settled: false };
		let uiDialogCount = 0;
		const invocation = getPiInvocation(args);
		const backend = runtime.backendFor(dispatch.backend);
		const spawnOptions = {
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
						const approvalTitle = typeof request.title === "string" ? request.title.slice(0, 300) : undefined;
						currentResult.pendingApproval = {
							requestId: request.id,
							method: request.method,
							title: approvalTitle,
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
						// Keep the answer in the run so the attach transcript can show a
						// resolved approval after the dialog closes. Bounded like the UI cap.
						const resolvedApprovals = (currentResult.resolvedApprovals ??= []);
						if (resolvedApprovals.length < 20) {
							resolvedApprovals.push({
								requestId: request.id,
								method: request.method,
								title: approvalTitle,
								state: denied ? "denied" : "approved",
							});
						}
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
		};
		child = await backend.spawn(spawnOptions, {
			runId,
			dispatchId: dispatch.dispatchId,
			agent: agent.name,
			task,
			...(dispatch.herdrRetention ? { herdrRetention: dispatch.herdrRetention } : {}),
			...(chainKey ? { chainKey } : {}),
		});
		if (dispatch.backend) currentResult.backend = dispatch.backend;
		if (child.herdr) currentResult.herdr = child.herdr;
		activeChildren.add(child);

		// Stop escalation for this run: the first stop aborts the child
		// cooperatively, a later stop or the grace timer forces termination so a
		// wedged child cannot keep its registry entry stale.
		const runStop = new RunStopController(
			{
				requestAbort: () => {
					child?.send({ id: `abort-${runId}`, type: "abort" });
				},
				terminate: () => child?.terminate(),
			},
			{
				graceMs: DEFAULT_STOP_ESCALATION_MS,
				onAbort: () => {
					wasAborted = true;
					currentResult.state = "aborting";
					interruptActiveTools(currentResult, "Parent aborted the subagent");
					emitUpdate();
				},
			},
		);
		stop = runStop;
		// A dispatch-level abort (Ctrl+C, session shutdown, `/px:agents`, or a
		// dispatch `action: "stop"`) is cooperative: if a control stop already
		// started this run, do not escalate it twice for the same event.
		const onSignalAbort = () => {
			if (!runStop.stopped) runStop.request();
		};
		if (signal) {
			if (signal.aborted) onSignalAbort();
			else {
				signal.addEventListener("abort", onSignalAbort, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", onSignalAbort);
			}
		}

		registry.start({
			runId,
			agentName: agent.name,
			task,
			cwd: cwd ?? defaultCwd,
			startedAt: Date.now(),
			result: currentResult,
			child,
			dispatchId: dispatch.dispatchId,
			execution: dispatch.execution,
			...(dispatch.backend ? { backend: dispatch.backend } : {}),
			...(dispatch.herdrRetention ? { herdrRetention: dispatch.herdrRetention } : {}),
			...(child.herdr ? { herdr: child.herdr } : {}),
			abort: () => runStop.request(),
		});

		try {
			if (runStop.stopped) throw new SubagentAbortError(currentResult);
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
			if (wasAborted) throw new SubagentAbortError(currentResult);
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
			if (wasAborted) throw new SubagentAbortError(currentResult);
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
		stop?.dispose();
		approvalQueue.cancelRun(runId);
		currentResult.timing = timing.finish();
		registry.complete(runId);
		if (child) {
			// Classify the terminal outcome so a Herdr lease can be recycled or
			// retained. `release` is a no-op for the process backend.
			const outcome: SubagentRunOutcome =
				wasAborted || currentResult.stopReason === "aborted"
					? "aborted"
					: isFailedResult(currentResult)
						? "failed"
						: "success";
			try {
				await child.release?.(outcome);
			} catch {
				// A release failure must not skip pane termination/cleanup.
			}
			// Retention is applied during release, so refresh the recorded location.
			// A recycled (non-retained) pane is now free for another run, so its
			// location must be dropped: keeping it would make Jump focus a pane that
			// belongs to a different run.
			const location = retainedHerdrLocation(child.herdr);
			currentResult.herdr = location;
			const run = registry.get(runId);
			if (run) run.herdr = location;
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

const HerdrRetentionSchema = StringEnum(["failed", "always"] as const, {
	description:
		'How long to keep the Herdr pane: "failed" (default) keeps failed/aborted panes and recycles successful ones; "always" keeps every pane.',
	default: "failed",
});

const HerdrSchema = Type.Object({
	retain: Type.Optional(HerdrRetentionSchema),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	action: Type.Optional(
		StringEnum(["stop", "steer"] as const, {
			description:
				'Control a running subagent instead of starting one: "stop" aborts (repeating it escalates to forced termination), "steer" sends guidance. Requires dispatchId or runId (exactly one), and message for "steer". Do not combine with dispatch fields (agent/task/tasks/chain/execution/cwd/agentScope/confirmProjectAgents).',
		}),
	),
	dispatchId: Type.Optional(
		Type.String({ description: 'Target every active run of one dispatch (async or blocking id); dispatch ids come from an async acknowledgement or a blocking aggregate result. For action "stop"/"steer".' }),
	),
	runId: Type.Optional(
		Type.String({ description: 'Target one child run in either execution mode. For action "stop"/"steer".' }),
	),
	message: Type.Optional(
		Type.String({ description: 'Guidance to deliver to the child (required for action "steer", ignored for "stop").' }),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	execution: Type.Optional(
		StringEnum(["async", "blocking"] as const, {
			description:
				'Run detached in the background ("async", default) or await the full result ("blocking").',
			default: "async",
		}),
	),
	herdr: Type.Optional(HerdrSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	const childControl = registerChildControls(pi);
	// Surface agent names + brief descriptions in the tool description so the
	// model can choose deliberately without trial and error. Important for
	// opt-in agents like `reviewer-ultra-explicit` and
	// `reviewer-xultra-explicit`. Uses user-scope only, which
	// matches the default agentScope. Computed once at registration; the agent
	// list is re-discovered per invocation for actual execution.
	const getSafeModeSnapshot = () => querySafeModeSnapshot(pi.events);
	const activeChildren = new Set<RpcChild>();
	const approvalQueue = new ApprovalQueue();

	let sessionContext: ExtensionContext | undefined;
	let shuttingDown = false;
	// Session-scoped abort signal and in-flight dispatch tracking. Together they
	// let shutdown abort and await blocking runs before disposing the owned tab,
	// closing the window where a late spawn could adopt a torn-down tab.
	let sessionShutdown = new AbortController();
	const inFlightDispatches = new Set<Promise<unknown>>();
	// Bumped on every session_start so a preflight that straddles a session
	// replacement can never install the previous session's tab.
	let sessionEpoch = 0;

	const registry = new SubagentRegistry(30, () => publishActiveSubagentWidget());

	// Active-subagents widget docked above the input editor. The widget is
	// non-interactive; `/px:agents` owns inspection and control. Content is
	// cleared on shutdown before the session context is dropped.
	const activeWidget = new ActiveSubagentWidget({
		setWidget: (content) => {
			if (!sessionContext?.hasUI) return;
			try {
				sessionContext.ui.setWidget(ACTIVE_SUBAGENT_WIDGET_ID, content, { placement: "aboveEditor" });
			} catch {
				// Ignore a stale or closing UI; run cleanup must still complete.
			}
		},
		// Ticks re-read the registry so elapsed time (and any state change that
		// did not emit a progress update) keeps moving during silent periods.
		listRuns: () => registry.list(),
	});

	const newRunId = createRunIdGenerator();
	const newDispatchId = createRunIdGenerator("dispatch");

	// Extension-owned detached dispatches. Independent of any parent tool
	// invocation: `deliver` is fire-and-forget and failures are swallowed so a
	// stale extension instance or a replacement session can never throw here.
	const asyncDispatches = new AsyncDispatchManager({
		deliver: (message, options) => {
			try {
				pi.sendMessage(message, options);
			} catch {
				// Stale extension instance or replacement session.
			}
		},
	});

	// Advertise detached work to the Herdr integration so the parent pane stays
	// `working` after the accepting turn settles. Per-dispatch ids compose with
	// parallel and chained dispatches; the integration clears each on `false`.
	// Child processes run in RPC mode and never own a Herdr pane, so they stay out.
	const emitHerdrBackground = (dispatchId: string, active: boolean): void => {
		if (process.env.PI_SUBAGENT_CHILD === "1") return;
		try {
			pi.events.emit(HERDR_BACKGROUND_EVENT, herdrBackgroundPayload(dispatchId, active));
		} catch {
			// The event bus must never break dispatch lifecycle.
		}
	};

	// Parent-owned Herdr tab, created lazily by the first Herdr dispatch and
	// reused for the session. Preflight validates the environment and prepares
	// the tab before a dispatch is accepted; nothing is created unless the
	// request explicitly carries `herdr`.
	type HerdrSession = { environment: HerdrEnvironment; client: HerdrClient; tab: ParentHerdrTab };
	let herdrSession: HerdrSession | undefined;
	let herdrBackend: HerdrSubagentBackend | undefined;
	const processBackend = new ProcessSubagentBackend();

	function disposeHerdrSession(reason: HerdrDisposeReason): Promise<void> {
		const session = herdrSession;
		// Clear first so a concurrent dispatch cannot attach to a disposed tab.
		herdrSession = undefined;
		herdrBackend = undefined;
		if (!session) return Promise.resolve();
		return session.tab.dispose({ reason }).catch(() => undefined);
	}

	/**
	 * Fire-and-forget startup cleanup of persisted Herdr ownership records that
	 * no longer point at a verified-owned tab. Only runs inside Herdr, only for
	 * the current socket, and never closes a tab or pane (see `herdr-tab.ts`).
	 * Failures are swallowed so they can never block session start.
	 */
	function cleanupStaleHerdrTabState(): void {
		const environment = readHerdrEnvironment(process.env);
		if (!environment) return;
		const directory = resolveHerdrTabStateDirectory(getAgentDir());
		void cleanupStaleHerdrTabRecords({ directory, socketPath: environment.socketPath }).catch(() => undefined);
	}

	function backendFor(kind: SubagentBackendKind | undefined): SubagentBackend {
		if (kind !== "herdr") return processBackend;
		if (!herdrSession) {
			throw new Error("Herdr was requested, but no parent Herdr tab has been prepared.");
		}
		if (!herdrBackend) {
			herdrBackend = new HerdrSubagentBackend({
				tab: herdrSession.tab,
				launcher: createHerdrBridgeLauncher({ client: herdrSession.client }),
			});
		}
		return herdrBackend;
	}

	/**
	 * Validate Herdr and prepare the owned tab; called before acceptance.
	 *
	 * Concurrent callers share one in-flight preflight so two dispatches cannot
	 * build separate tab managers and create two tabs. `ensureTab: false` is the
	 * read-only manager path: it prepares a client/tab manager but never creates
	 * or splits a tab as a side effect of viewing Details or Jump.
	 */
	let herdrPreflightInFlight = createSingleFlight<{ ok: true } | { ok: false; error: string }>();
	async function runHerdrPreflight(
		piSessionId: string,
		options: { ensureTab?: boolean } = {},
	): Promise<{ ok: true } | { ok: false; error: string }> {
		const ensureTab = options.ensureTab !== false;
		// Never share a read-only probe with a mutating preflight.
		if (!ensureTab) return runHerdrPreflightOnce(piSessionId, false);
		return herdrPreflightInFlight.run(() => runHerdrPreflightOnce(piSessionId, true));
	}

	async function runHerdrPreflightOnce(
		piSessionId: string,
		ensureTab: boolean,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		const epoch = sessionEpoch;
		const result = await preflightHerdr({
			existing: herdrSession,
			ensureTab,
			createTab: (client) => createParentHerdrTab({ client, agentDir: getAgentDir(), piSessionId }),
		});
		if (!result.ok) return { ok: false, error: result.error };
		// Shutdown or a session replacement may have begun while preflight was
		// awaiting. Never install a fresh tab after teardown; dispose it and report
		// a refusal instead.
		if (shuttingDown || epoch !== sessionEpoch) {
			await result.tab.dispose({ reason: "quit" }).catch(() => undefined);
			return { ok: false, error: "Subagent dispatch not started: the session is shutting down." };
		}
		// A different environment means a different tab manager; drop any cached
		// backend so it cannot address the previous session's tab.
		if (herdrSession && herdrSession.tab !== result.tab) herdrBackend = undefined;
		herdrSession = { environment: result.environment, client: result.client, tab: result.tab };
		return { ok: true };
	}

	// Publish the active-subagents widget from the registry. Registry completions
	// during shutdown cannot re-show the widget because the teardown flag forces
	// a clear. Content changes are de-duplicated by `ActiveSubagentWidget`.
	function publishActiveSubagentWidget(): void {
		if (shuttingDown) {
			activeWidget.clear();
			return;
		}
		activeWidget.refresh(registry.list());
	}

	// Live attach overlay. Only one can be open at a time because a focused
	// overlay owns keyboard input. `closeActiveAttach` is captured so session
	// teardown can close it even though the command handler is suspended inside
	// `ctx.ui.custom()`. The view reads the run's live `SingleResult`, so it keeps
	// working while the registry completes or prunes unrelated runs.
	//
	// Approval dialogs still run through `parentContext.ui.*`, which are temporary
	// non-overlay custom UIs. A focused visible overlay reclaims input after such
	// a dialog closes (docs/tui.md "Overlay Focus"), so the view never touches the
	// overlay handle or answers a child approval itself. Safe mode and the shared
	// approval queue stay authoritative.
	let closeActiveAttach: (() => void) | undefined;

	// Lifecycle controls for the attach overlay. Pause/resume use the child's
	// native control RPC; stop uses the run's lifecycle controller (cooperative
	// native abort, then bounded forced termination). None of them sends a shell
	// signal. Stop waits for the registry to mark the run complete so the caller
	// reports the settled outcome instead of a stale "running" state.
	const ATTACH_STOP_SETTLE_TIMEOUT_MS = DEFAULT_STOP_ESCALATION_MS + 2000;

	function pauseAttachedRun(run: SubagentRunRuntime): Promise<void> {
		if (run.completedAt) return Promise.reject(new Error(`Run ${run.runId} has already finished.`));
		run.result.state = "pause-requested";
		return sendControl(run, "pause");
	}

	function resumeAttachedRun(run: SubagentRunRuntime): Promise<void> {
		if (run.completedAt) return Promise.reject(new Error(`Run ${run.runId} has already finished.`));
		run.result.state = "resuming";
		return sendControl(run, "resume");
	}

	async function stopAttachedRun(run: SubagentRunRuntime): Promise<void> {
		if (run.completedAt) throw new Error(`Run ${run.runId} has already finished.`);
		if (!run.abort) throw new Error(`Run ${run.runId} has no stop handle.`);
		run.abort();
		const deadline = Date.now() + ATTACH_STOP_SETTLE_TIMEOUT_MS;
		while (!run.completedAt && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (!run.completedAt) throw new Error(`Run ${run.runId} did not settle after stop; it may still be terminating.`);
	}

	interface AttachOverlayTarget {
		runId: string;
		agentName: string;
		startedAt: number;
		getResult: () => SingleResult;
		getCompletedAt: () => number | undefined;
		/** Live registry run; omitted for a read-only persisted transcript. */
		live?: SubagentRunRuntime;
	}

	async function openAttachOverlay(target: AttachOverlayTarget, ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		try {
			await ctx.ui.custom<null>(
				(tui, theme, _keybindings, done) => {
					const editorTheme: EditorTheme = {
						borderColor: (text) => theme.fg("accent", text),
						selectList: getSelectListTheme(),
					};
					const live = target.live;
					const view = new AttachView({
						getResult: target.getResult,
						getRun: () => ({
							runId: target.runId,
							agentName: target.agentName,
							startedAt: target.startedAt,
							completedAt: target.getCompletedAt(),
						}),
						theme: {
							fg: (color, text) => theme.fg(color as Parameters<typeof theme.fg>[0], text),
							bold: (text) => theme.bold(text),
						},
						requestRender: () => tui.requestRender(),
						done: (result) => done(result),
						terminalRows: () => tui.terminal.rows,
						// A recovered persisted transcript has no child to control, so it is
						// always read-only even if its stored result lacks a final state.
						forceReadOnly: !live,
						editor: live ? new Editor(tui, editorTheme) : undefined,
						// Address every control through the captured run object, not the
						// registry, so the overlay keeps working after the registry prunes
						// the entry once the run completes.
						steer: live ? (_runId, message) => sendSteer(live, message) : undefined,
						pause: live ? () => pauseAttachedRun(live) : undefined,
						resume: live ? () => resumeAttachedRun(live) : undefined,
						stop: live ? () => stopAttachedRun(live) : undefined,
						confirmStop: live
							? (run) => ctx.ui.confirm("Stop subagent", `Stop ${run.agentName} [${run.runId}]?`)
							: undefined,
					});
					closeActiveAttach = () => view.close();
					return view;
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "100%", minWidth: 40, maxHeight: "100%", margin: 1 },
				},
			);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			closeActiveAttach = undefined;
		}
	}

	/** Live attach for a registry run (read-only automatically once settled). */
	function openAttach(run: SubagentRunRuntime, ctx: ExtensionContext): Promise<void> {
		return openAttachOverlay(
			{
				runId: run.runId,
				agentName: run.agentName,
				startedAt: run.startedAt,
				getResult: () => run.result,
				getCompletedAt: () => run.completedAt,
				live: run,
			},
			ctx,
		);
	}

	/**
	 * Read-only attach for a persisted completed run. Used after registry pruning
	 * or `/resume`, when only the completion details (not a live runtime) remain.
	 */
	function openRecoveredAttach(entry: AgentLogEntry, ctx: ExtensionContext): Promise<void> {
		const result = entry.result;
		if (!result) return Promise.resolve();
		const completedAt = entry.completedAt ?? Date.now();
		return openAttachOverlay(
			{
				runId: entry.runId || result.runId || "unknown",
				agentName: entry.agentName || result.agent,
				startedAt: entry.startedAt ?? completedAt,
				getResult: () => result,
				getCompletedAt: () => completedAt,
			},
			ctx,
		);
	}

	interface ManagerItem {
		descriptor: ManagerRunDescriptor;
		run?: SubagentRunRuntime;
		entry?: AgentLogEntry;
	}

	/** Persisted Herdr locations the user closed or found stale this session. */
	const dismissedPersistedHerdrRuns = new Set<string>();

	/**
	 * Registry runs plus persisted Herdr-retained runs the registry has already
	 * pruned. Ordinary process runs are never added from history, so the default
	 * manager list stays unchanged.
	 */
	function managerItems(ctx: ExtensionContext): ManagerItem[] {
		const runs = registry.list();
		const persisted = persistedAgentLogEntries(ctx.sessionManager.getBranch());
		const descriptors = mergeManagerDescriptors(runs, persisted, dismissedPersistedHerdrRuns);
		const byRunId = new Map(runs.map((run) => [run.runId, run]));
		const entries = new Map<string, AgentLogEntry>();
		for (const entry of persisted) {
			if (entry.runId && !entries.has(entry.runId)) entries.set(entry.runId, entry);
		}
		return descriptors.map((descriptor) => {
			const run = byRunId.get(descriptor.runId);
			const entry = entries.get(descriptor.runId);
			return {
				descriptor,
				...(run ? { run } : {}),
				...(entry ? { entry } : {}),
			};
		});
	}

	/** Resolve the Herdr tab for manager actions without ever creating one. */
	async function managerHerdrActions(ctx: ExtensionContext): Promise<ManagerHerdrActions | undefined> {
		if (!herdrSession) {
			// Read-only path: validate the environment and adopt any stored owned
			// tab, but never create one just because the user opened Details/Jump.
			const result = await runHerdrPreflight(ctx.sessionManager.getSessionId(), { ensureTab: false });
			if (!result.ok) {
				ctx.ui.notify(result.error, "error");
				return undefined;
			}
		}
		const tab = herdrSession?.tab;
		if (!tab) return undefined;
		return new ManagerHerdrActions({
			focusLocation: (location) => tab.focusLocation(location),
			closeRetainedLocation: (location) => tab.closeRetainedLocation(location),
			paneStatus: (location) => tab.paneStatus(location),
		});
	}

	/** Drop a stale/closed pane record; the subagent result and log stay intact. */
	function dismissHerdrLocation(item: ManagerItem): void {
		if (item.run) clearHerdrLocation(item.run);
		else if (item.descriptor.runId) dismissedPersistedHerdrRuns.add(item.descriptor.runId);
		item.descriptor.herdr = undefined;
		item.descriptor.paneStatus = "missing";
	}

	if (!childControl) {
		pi.registerCommand("px:agents", {
			description: "Manage active and recent subagent runs",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) return;
				while (true) {
					const items = managerItems(ctx);
					if (items.length === 0) {
						ctx.ui.notify("No subagent runs yet.", "info");
						return;
					}
					const { labels, byLabel } = buildManagerPicker(items.map((item) => item.descriptor));
					const selected = await ctx.ui.select("Subagent manager", [...labels, "Close"]);
					if (!selected || selected === "Close") return;
					const index = byLabel.get(selected);
					if (index === undefined) continue;
					const item = items[index];
					const descriptor = item.descriptor;
					const run = item.run;
					const action = await ctx.ui.select(
						`${descriptor.agentName} [${descriptor.runId}]`,
						managerActions(descriptor),
					);
					if (!action || action === "Back") continue;

					if (action === "Attach" || action === "View transcript") {
						if (run) await openAttach(run, ctx);
						else if (item.entry) await openRecoveredAttach(item.entry, ctx);
						continue;
					}

					if (action === "Details") {
						// Live-validate a Herdr location so a manually closed pane shows as
						// missing instead of a stale active/retained status.
						if (descriptor.herdr && hasHerdrPane(descriptor)) {
							const herdr = await managerHerdrActions(ctx);
							if (herdr) descriptor.paneStatus = await herdr.status(descriptor.herdr);
						}
						await ctx.ui.editor(`Subagent details: ${descriptor.runId}`, managerDetails(descriptor));
						continue;
					}

					if (action === "Jump to Herdr pane") {
						if (!descriptor.herdr) continue;
						const herdr = await managerHerdrActions(ctx);
						if (!herdr) continue;
						const result = await herdr.jump(descriptor.herdr);
						ctx.ui.notify(result.message, result.ok ? "info" : result.stale ? "warning" : "error");
						if (result.stale) dismissHerdrLocation(item);
						// Return from the manager after a successful focus so the user lands
						// in the exact pane; stale/error results keep the menu open.
						if (result.ok) return;
						continue;
					}

					if (action === "Close retained pane") {
						if (!descriptor.herdr) continue;
						const confirmed = await ctx.ui.confirm(
							"Close retained pane",
							`Close Herdr pane ${descriptor.herdr.paneId} for ${descriptor.runId}? The subagent result and log are preserved.`,
						);
						if (!confirmed) continue;
						const herdr = await managerHerdrActions(ctx);
						if (!herdr) continue;
						const result = await herdr.closeRetained(descriptor.herdr);
						ctx.ui.notify(result.message, result.ok ? "info" : result.stale ? "warning" : "error");
						if (result.stale) dismissHerdrLocation(item);
						continue;
					}

					// The remaining actions are live-run controls only.
					if (!run) continue;
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
							// Detached dispatches own an independent controller. Aborting it
							// classifies the final completion as aborted and stops any remaining
							// chain/parallel work. `run.abort` covers blocking runs (no manager
							// entry) through the run's own controller so classification is fixed
							// for them too.
							if (run.dispatchId) asyncDispatches.abort(run.dispatchId);
							run.abort?.();
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
				const run = entry.runId ? registry.get(entry.runId) : undefined;
				const canViewTranscript = Boolean(run || (entry.result && entry.status !== "running"));
				if (canViewTranscript) {
					const action = await ctx.ui.select(title, ["View transcript", "View text", "Back"]);
					if (!action || action === "Back") return;
					if (action === "View transcript") {
						if (run) await openAttach(run, ctx);
						else await openRecoveredAttach(entry, ctx);
						return;
					}
				}
				await ctx.ui.editor(title, formatAgentLogEntry(entry));
			},
		});

		pi.registerCommand("px:agent:attach", {
			description: "Attach to a subagent run by id (read-only when completed)",
			handler: async (args, ctx) => {
				if (!ctx.hasUI) return;
				const runId = (args ?? "").trim();
				if (!runId) {
					ctx.ui.notify("Usage: /px:agent:attach <runId>", "warning");
					return;
				}
				const run = registry.get(runId);
				if (run) {
					await openAttach(run, ctx);
					return;
				}
				const entry = findPersistedAgentLogEntry(ctx.sessionManager.getBranch(), runId);
				if (entry?.result) {
					await openRecoveredAttach(entry, ctx);
					return;
				}
				ctx.ui.notify(`No subagent run found for ${runId}.`, "error");
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionContext = ctx;
		shuttingDown = false;
		sessionEpoch += 1;
		sessionShutdown = new AbortController();
		herdrPreflightInFlight.reset();
		// A replacement session must not adopt the previous session's Herdr tab.
		herdrSession = undefined;
		herdrBackend = undefined;
		dismissedPersistedHerdrRuns.clear();
		asyncDispatches.reset();
		// Remove stale persisted tab records left by a crash/manual cleanup.
		cleanupStaleHerdrTabState();
		// Forget the previous widget content so the first refresh always
		// republishes (and clears a stale widget from an earlier session).
		activeWidget.reset();
		publishActiveSubagentWidget();
		// Re-announce detached work: a reload replaces the Herdr integration, so
		// its background lease starts empty.
		for (const handle of asyncDispatches.handles) emitHerdrBackground(handle.dispatchId, true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		sessionContext = ctx;
		// The tree can re-render with the same active set, so reset the dedup
		// state and force a republish instead of skipping an identical snapshot.
		activeWidget.reset();
		publishActiveSubagentWidget();
		for (const handle of asyncDispatches.handles) emitHerdrBackground(handle.dispatchId, true);
	});

	pi.on("session_shutdown", async (event) => {
		// Order matters: flip the shutdown flag, abort detached controllers,
		// terminate active RPC children, await settled dispatch promises, then
		// clear runtime state. Completion delivery is suppressed by the manager
		// as soon as `shutdown()` sets its flag.
		shuttingDown = true;
		sessionShutdown.abort();
		// Close the live attach overlay first: it clears the view's poll timer and
		// resolves the suspended `ctx.ui.custom()` promise before the session
		// context is dropped. A close failure must not block run cleanup.
		try {
			closeActiveAttach?.();
		} catch {
			/* ignore */
		}
		closeActiveAttach = undefined;
		// Clear before dropping the context: `setWidget` needs `sessionContext`.
		activeWidget.clear();
		sessionContext = undefined;
		const dispatchesSettled = asyncDispatches.shutdown();
		approvalQueue.clear();
		// Capture only this session's children. A replacement session can start
		// (and spawn) while the await below drains, so never blanket-clear the set.
		const childrenToTerminate = [...activeChildren];
		// A single failing terminate must not skip dispatch settling or cleanup, so
		// settle every termination attempt before awaiting the dispatches.
		await Promise.allSettled(childrenToTerminate.map((child) => child.terminate()));
		await dispatchesSettled;
		// Blocking runs are not tracked by the async manager. Wait for them (and
		// the pre-spawn window) to settle before disposing the owned tab, so a late
		// acquire/spawn can never race tab teardown.
		await Promise.allSettled([...inFlightDispatches]);
		for (const child of childrenToTerminate) activeChildren.delete(child);
		// Children are settled first; `dispose` then closes the owned tab only
		// when no explicitly retained panes remain (`reload` keeps the tab).
		await disposeHerdrSession(event.reason);
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

	// Compact/expanded renderer for the one async aggregate completion message.
	// Pure data/text/blocks live in `completion.ts`; this adapter only maps them
	// onto TUI components, so collapsed and expanded output cannot drift from the
	// tested model. Legacy/malformed details fall back to the model-visible
	// content so a completion is never hidden.
	pi.registerMessageRenderer<SubagentDetails>(
		SUBAGENT_COMPLETION_CUSTOM_TYPE,
		(message, { expanded, outputPad }, theme) => {
			const data = buildCompletionRenderData(message.details);
			if (!data) {
				const content =
					typeof message.content === "string"
						? message.content
						: message.content
								.map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
								.join("\n");
				return new Text(content, outputPad, 0);
			}

			const icon =
				data.dispatchStatus === "completed"
					? theme.fg("success", "✓")
					: data.dispatchStatus === "aborted"
						? theme.fg("warning", "⊘")
						: theme.fg("error", "✗");

			if (!expanded) {
				return new Text(
					`${icon} ${formatCompletionRenderText(message.details, { expanded: false }) ?? data.title}`,
					outputPad,
					0,
				);
			}

			const container = new Container();
			const mdTheme = getMarkdownTheme();
			for (const block of buildCompletionRenderBlocks(data)) {
				switch (block.kind) {
					case "title":
						container.addChild(new Text(`${icon} ${block.text}`, outputPad, 0));
						break;
					case "summary":
						container.addChild(new Text(theme.fg("dim", block.text), outputPad, 0));
						break;
					case "header": {
						const sectionIcon = block.section.notRun
							? theme.fg("warning", "⊘")
							: block.section.failed
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
						container.addChild(new Spacer(1));
						container.addChild(new Text(`${sectionIcon} ${theme.fg("accent", block.text)}`, outputPad, 0));
						break;
					}
					case "task":
						container.addChild(new Text(theme.fg("dim", `Task: ${block.text}`), outputPad, 0));
						break;
					case "directory":
						container.addChild(new Text(theme.fg("dim", `Directory: ${block.text}`), outputPad, 0));
						break;
					case "output":
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(block.text.trim(), outputPad, 0, mdTheme));
						break;
				}
			}
			return container;
		},
	);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential; {previous} in a step task is replaced with the previous step's final output).",
			'Execution: omitted or "async" (default) runs detached in the background and returns a dispatch id immediately; the aggregate result is injected automatically when it settles, so do not poll for it. Use execution: "blocking" to stream progress and wait for the final result in this turn. Detached children may modify the shared working tree, so re-read affected files before editing them.',
			'Control a running subagent without starting new work: set action to "stop" (abort; repeat to force termination) or "steer" (deliver guidance) and address it with dispatchId (all active runs of one dispatch) or runId (one child). "steer" requires message, and a control call rejects dispatch fields. A stopped dispatch still emits its normal aggregate completion, marked aborted.',
		'Optional herdr object runs the dispatch in a pane of a parent-owned Herdr tab behind an authenticated bridge: herdr: {} uses retain "failed"; herdr: { retain: "always" } keeps successful panes too. Omit to use the default direct process. Herdr is never used as an automatic fallback, and it is rejected on control calls.',
			`Available agents: ${agentListText}.`,
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Control calls never prepare a dispatch: they act on runs that already
			// exist, so they stay available even while the session is shutting down
			// (which is exactly when a parent may want to stop a runaway child).
			if (isSubagentControlRequest(params)) {
				const parsed = parseSubagentControl(params as SubagentControlInput);
				if (!parsed.ok) throw new Error(parsed.error);
				return executeSubagentControl(
					parsed.request,
					{
						runs: () => registry.list(),
						getRun: (runId) => registry.get(runId),
						abortDispatch: (dispatchId) => asyncDispatches.abort(dispatchId),
						steer: (run, message, options) => sendSteer(run, message, options),
					},
					{ signal },
				);
			}
			// Refuse before preparation once teardown starts: an accepted dispatch
			// must never outlive the session that owns it. Re-checked again below
			// because preparation is async and can straddle a shutdown event.
			if (shuttingDown) {
				return buildNotStartedResult("Subagent dispatch not started: the session is shutting down.");
			}
			const preparation = await prepareSubagentDispatch(params as SubagentRequest, {
				discoverAgents,
				requestPermission: (what, data) => askHubPermission(what, data, ctx),
				snapshotSafeMode: getSafeModeSnapshot,
				preflightHerdr: async (herdr) => {
					const result = await runHerdrPreflight(ctx.sessionManager.getSessionId());
					if (!result.ok) return result;
					return { ok: true, retention: herdr.retain ?? "failed" };
				},
				nextDispatchId: newDispatchId,
				nextRunId: newRunId,
				context: {
					cwd: ctx.cwd,
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					thinkingLevel: ctx.thinkingLevel,
				},
			});
			if (!preparation.ok) return preparation.result;

			const dispatch = preparation.dispatch;
			const runtime: SingleAgentRuntimeDependencies = {
				activeChildren,
				approvalQueue,
				parentContext: ctx,
				registry,
				backendFor,
				shutdownSignal: sessionShutdown.signal,
				onProgress: publishActiveSubagentWidget,
			};
			const makeRunner = (target: PreparedSubagentDispatch): DispatchRuntimeDependencies => ({
				runSingle: (request) => runSingleAgent(request, target, runtime),
			});

			// Track the whole post-preparation execution so shutdown can abort and
			// await blocking runs (and the pre-spawn window) before disposing the tab.
			const execution = (async () => {
				if (dispatch.execution === "blocking") {
					// Explicit blocking keeps the tool signal and streaming callback.
					return runPreparedDispatch(dispatch, makeRunner(dispatch), signal, onUpdate);
				}

				// Async acceptance is guarded against shutdown (which may have begun
				// during the awaited preparation) and against an already-aborted parent
				// turn. A refused dispatch is terminal, never a started acknowledgement.
				if (shuttingDown || !asyncDispatches.canStart(signal)) {
					const reason = shuttingDown ? "the session is shutting down" : "the parent turn was aborted";
					return buildDispatchExceptionResult(dispatch, new Error(`Subagent dispatch not started: ${reason}.`), {
						aborted: true,
					});
				}

				// Async: detach with an independent controller. Never pass the parent
				// tool signal or the completed invocation's onUpdate callback; live UI
				// comes from the registry and active-subagents widget instead.
				const handle = asyncDispatches.start(dispatch, (dispatchSignal) =>
					runPreparedDispatch(dispatch, makeRunner(dispatch), dispatchSignal, undefined),
				);
				if (!handle) {
					return buildDispatchExceptionResult(
						dispatch,
						new Error("Subagent dispatch not started: the session is shutting down."),
						{ aborted: true },
					);
				}
				// Hold the Herdr pane `working` until this dispatch settles, so a
				// detached child is not mistaken for a finished parent turn.
				emitHerdrBackground(handle.dispatchId, true);
				void handle.promise.then(
					() => emitHerdrBackground(handle.dispatchId, false),
					() => emitHerdrBackground(handle.dispatchId, false),
				);
				return buildAsyncStartResult(dispatch);
			})();
			inFlightDispatches.add(execution);
			try {
				return await execution;
			} finally {
				inFlightDispatches.delete(execution);
			}
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.action) return new Text(formatControlCall(args, theme), 0, 0);
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
				const outcome = formatToolStatus(status, theme.fg.bind(theme));
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
				const icon = isActive ? theme.fg("warning", RUNNING_ICON) : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
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
					? theme.fg("warning", RUNNING_ICON)
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
						const rIcon = r.exitCode === -1 ? theme.fg("warning", RUNNING_ICON) : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
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
					const rIcon = r.exitCode === -1 ? theme.fg("warning", RUNNING_ICON) : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
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
					? theme.fg("warning", RUNNING_ICON)
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
							? theme.fg("warning", RUNNING_ICON)
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
