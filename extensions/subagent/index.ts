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
	type Theme,
	getAgentDir,
	getMarkdownTheme,
	getSelectListTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Editor, Markdown, Spacer, Text, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
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
	applyProgressRelay,
	PROGRESS_RELAY_DIAGNOSTIC,
	PROGRESS_RELAY_STATUS_KEY,
	withProgressGuidance,
	withProgressTool,
} from "./progress-relay.ts";
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
	SUBAGENT_COMPLETION_CUSTOM_TYPE,
} from "./completion.ts";
import { ClickToggleComponent } from "./completion-view.ts";
import {
	buildRunFinishedEntry,
	formatRunLine,
	normalizeRunFinishedEntry,
	runLinePartsFromEntry,
	RUN_LINE_OUTPUT_PAD,
	SUBAGENT_RUN_FINISHED_CUSTOM_TYPE,
	type RunLineStyles,
	type SubagentRunFinishedEntry,
} from "./run-line.ts";
import {
	type DispatchRuntimeDependencies,
	type SingleRunRequest,
	buildDispatchExceptionResult,
	runPreparedDispatch,
	SubagentAbortError,
} from "./dispatch.ts";
import { DispatchLifecycleManager } from "./lifecycle.ts";
import {
	ManagerHerdrActions,
	applyDispatchOwnership,
	clearHerdrLocation,
	descriptorFromEntry,
	descriptorFromRun,
	hasHerdrPane,
	managerActions,
	managerDetails,
	mergeManagerDescriptors,
	shouldAbortDispatch,
	type ManagerRunDescriptor,
} from "./manager.ts";
import { ManagerListView, type ManagerListResult } from "./manager-list.ts";
import {
	PANELS_ACTIVE_EVENT,
	PANELS_CONTENT_EVENT,
	PANELS_REGISTER_EVENT,
	PANELS_VISIBILITY_EVENT,
	SUBAGENT_PANEL_ID,
	SUBAGENT_PANEL_LABEL,
	SUBAGENT_PANEL_ORDER,
	SubagentPanelBridge,
	parsePanelActive,
} from "./panels.ts";
import { formatResultTiming, formatToolCall, formatToolStatus, formatUsageStats } from "./format.ts";
import { combineAbortSignals } from "./execution.ts";
import { prepareSubagentDispatch, type SubagentRequest } from "./prepare.ts";
import { loadRestrictedAgentConfig } from "./restricted-agent-config.ts";
import { requestRestrictedAgentApproval as promptRestrictedAgentApproval } from "./restricted-agent-approval.ts";
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
import { RewirePresetListView, type RewirePresetListResult } from "./rewire-preset-list.ts";
import {
	addRewirePreset,
	deleteRewirePreset,
	formatRewirePreset,
	latestUsedRewirePreset,
	loadRewirePresets,
	markRewirePresetUsed,
	rewirePresetsPath,
	saveRewirePresets,
	type RewirePreset,
} from "./rewire-presets.ts";
import { availableThinkingLevels, resolveSubagentModel, THINKING_LEVELS } from "./rewire.ts";
import {
	canDelegate,
	childSubagentDepth,
	formatSubagentDepth,
	initialSubagentDepth,
	MAX_SUBAGENT_DEPTH,
	SUBAGENT_REMAINING_DEPTH_ENV,
} from "./delegation-depth.ts";
import { appendSafeModeArgs, querySafeModeSnapshot, type SafeModeSnapshot } from "./safe-mode.ts";
import {
	ActiveSubagentWidget,
	renderActiveSubagentWidgetContent,
} from "./status-row.ts";
import { SubagentTimingTracker } from "./timing.ts";
import { withUserWait, type UserWaitEventBus } from "./user-wait.ts";
import type {
	PreparedSubagentDispatch,
	SingleResult,
	SubagentBackendKind,
	SubagentDetails,
	SubagentRunOutcome,
	SubagentRewireConfig,
	ToolRunStatus,
} from "./types.ts";

const COLLAPSED_TOOL_COUNT = 7;
const COLLAPSED_PREVIEW_LINE_COUNT = 8;
const COLLAPSED_FINAL_OUTPUT_LINE_COUNT = 7;

// Process-local storage survives /reload but disappears when Pi restarts. Keyed
// by session id so /new and /resume do not leak one session's override into another.
const rewireSessionStates: Map<string, SubagentRewireConfig> =
	((globalThis as { __piXSubagentRewireStates?: Map<string, SubagentRewireConfig> }).__piXSubagentRewireStates ??=
		new Map());
const delegationDepthSessionStates: Map<string, number> =
	((globalThis as { __piXSubagentDepthStates?: Map<string, number> }).__piXSubagentDepthStates ??= new Map());
type SessionNameState = { agentIds: Set<string>; dispatchIds: Set<string> };
const nameSessionStates: Map<string, SessionNameState> =
	((globalThis as { __piXSubagentNameStates?: Map<string, SessionNameState> }).__piXSubagentNameStates ??= new Map());

// Nerd Font hourglass shown while a subagent run is still active (replaces the
// `⏳` emoji, which renders inconsistently across terminals).
const RUNNING_ICON = "\u{f051f}";

// hub permission protocol (see extensions/hub/PROTOCOL.md)
const HUB_ID = "subagent";
const HUB_ASK_EVENT = "hub:ask";
const HUB_ANSWER_EVENT = "hub:answer";
const HUB_PERMISSION_TIMEOUT_MS = 10 * 60_000;

const STATUS_BAR_REWIRE_SET_EVENT = "px:status-bar:rewire:set";
const STATUS_BAR_REWIRE_CLEAR_EVENT = "px:status-bar:rewire:clear";
const STATUS_BAR_SUBAGENT_DEPTH_SET_EVENT = "px:status-bar:subagent-depth:set";
const STATUS_BAR_SUBAGENT_DEPTH_CLEAR_EVENT = "px:status-bar:subagent-depth:clear";
const SUBAGENT_REWIRE_TOGGLE_EVENT = "px:subagent:rewire:toggle";
const SUBAGENT_REWIRE_MENU_EVENT = "px:subagent:rewire:menu";
const SUBAGENT_MANAGER_MENU_EVENT = "px:subagent:manager:menu";

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
	/** Pi event bus, used to declare parent-facing user waits (Herdr `blocked`). */
	events: UserWaitEventBus;
	/** Select the RPC transport for a prepared dispatch (process or Herdr). */
	backendFor: (kind: SubagentBackendKind | undefined) => SubagentBackend;
	/** Session-level abort signal; aborted once during shutdown. */
	shutdownSignal: AbortSignal;
	/** Refresh the active-subagents widget after a visible progress change. */
	onProgress?: () => void;
	/** Report one settled run to the parent UI (detached dispatches only). */
	onRunSettled?: (runId: string, result: SingleResult) => void;
	/** True when the parent process has registered the hub `progress` tool. */
	hasProgressTool: boolean;
	/** Re-emit one validated child relay on the parent `pi.events` bus. */
	emitProgressRelay?: (channel: string, payload: Record<string, unknown>) => void;
	/** Remaining recursive delegation budget inherited by each spawned child. */
	delegationDepth: number;
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
	const resolvedModel = resolveSubagentModel(agent, dispatchDefaults, dispatch.rewire);
	const model = resolvedModel.model;
	if (model) args.push("--model", model);
	const thinkingLevel = resolvedModel.thinkingLevel;
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	const childTools = withProgressTool(agent.tools, runtime.hasProgressTool);
	if (childTools && childTools.length > 0) args.push("--tools", childTools.join(","));

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
		const childSystemPrompt = withProgressGuidance(agent.systemPrompt, runtime.hasProgressTool);
		if (childSystemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, childSystemPrompt);
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
				[SUBAGENT_REMAINING_DEPTH_ENV]: String(childSubagentDepth(runtime.delegationDepth)),
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
						// Child-to-parent progress relay. Handled before the generic
						// fire-and-forget setStatus path so a valid envelope is re-emitted on
						// the parent bus and the raw status is never mistaken for a control.
						if (request.method === "setStatus" && request.statusKey === PROGRESS_RELAY_STATUS_KEY) {
							applyProgressRelay(
								request.statusText,
								(channel, payload) => runtime.emitProgressRelay?.(channel, payload),
								() => {
									// Bound to one relay diagnostic per run so a bad child cannot grow
									// result memory without limit. Never store the raw payload text.
									const diagnostics = (currentResult.diagnostics ??= []);
									if (diagnostics.length < 20 && !diagnostics.includes(PROGRESS_RELAY_DIAGNOSTIC)) {
										diagnostics.push(PROGRESS_RELAY_DIAGNOSTIC);
									}
								},
							);
							return;
						}
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
						const response = await withUserWait(
							runtime.events,
							{ owner: "subagent", label: approvalTitle ?? `${agent.name} approval`, kind: "approval" },
							() =>
								approvalQueue.enqueue({
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
						})).catch(() => undefined);
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
		// Detached runs are the ones the parent cannot watch settle, so each gets a
		// muted TUI-only line. Blocking dispatches already stream into the tool call
		// and report through the aggregate, so they are left alone.
		if (dispatch.execution === "async") runtime.onRunSettled?.(runId, currentResult);
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
	const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
	const configuredDefaultDepth = initialSubagentDepth(process.env, isSubagentChild);
	let delegationDepth = configuredDefaultDepth;
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
	// Session-only. Agent files are never modified, and accepted dispatches keep
	// the snapshot they were prepared with even if this changes later.
	let rewireConfig: SubagentRewireConfig | undefined;
	const presetFilePath = rewirePresetsPath(getAgentDir());
	const defaultRewireConfig = (ctx: ExtensionContext): SubagentRewireConfig | undefined =>
		ctx.model
			? {
					enabled: false,
					model: `${ctx.model.provider}/${ctx.model.id}`,
					thinkingLevel: ctx.thinkingLevel ?? "off",
				}
			: undefined;
	const publishRewireStatus = (): void => {
		if (rewireConfig?.enabled) {
			pi.events.emit(STATUS_BAR_REWIRE_SET_EVENT, {
				model: rewireConfig.model,
				thinkingLevel: rewireConfig.thinkingLevel,
			});
			return;
		}
		pi.events.emit(STATUS_BAR_REWIRE_CLEAR_EVENT, {});
	};
	const publishDelegationDepthStatus = (): void => {
		if (isSubagentChild) return;
		pi.events.emit(STATUS_BAR_SUBAGENT_DEPTH_SET_EVENT, { depth: delegationDepth });
	};
	const setDelegationDepth = (ctx: ExtensionContext, depth: number): void => {
		delegationDepth = Math.max(-1, Math.min(MAX_SUBAGENT_DEPTH, Math.trunc(depth)));
		delegationDepthSessionStates.set(ctx.sessionManager.getSessionId(), delegationDepth);
		publishDelegationDepthStatus();
	};
	const defaultRewireConfigWithPreset = async (
		ctx: ExtensionContext,
	): Promise<SubagentRewireConfig | undefined> => {
		const base = defaultRewireConfig(ctx);
		if (!base) return undefined;
		try {
			const latest = latestUsedRewirePreset(loadRewirePresets(presetFilePath));
			if (!latest) return base;
			const models =
				ctx.scopedModels.length > 0
					? ctx.scopedModels.map((entry) => entry.model)
					: await ctx.modelRegistry.getAvailable();
			const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === latest.model);
			if (!model || !availableThinkingLevels(model).includes(latest.thinkingLevel)) return base;
			return { ...base, model: latest.model, thinkingLevel: latest.thinkingLevel };
		} catch {
			return base;
		}
	};
	const setRewireConfig = (ctx: ExtensionContext, config: SubagentRewireConfig): void => {
		rewireConfig = config;
		const sessionId = ctx.sessionManager.getSessionId();
		// Refresh insertion order and keep this process-local cache bounded.
		rewireSessionStates.delete(sessionId);
		rewireSessionStates.set(sessionId, { ...config });
		while (rewireSessionStates.size > 32) {
			const oldest = rewireSessionStates.keys().next().value;
			if (oldest === undefined) break;
			rewireSessionStates.delete(oldest);
		}
		publishRewireStatus();
	};
	const unsubscribeRenewSettings = pi.events.on("px:renew:settings:request", (payload) => {
		if (!payload || typeof payload !== "object" || !sessionContext) return;
		const request = payload as { id?: unknown; sourceSessionId?: unknown; cwd?: unknown };
		if (request.sourceSessionId !== sessionContext.sessionManager.getSessionId() || request.cwd !== sessionContext.cwd) return;
		if (typeof request.id !== "string") return;
		pi.events.emit("px:renew:settings:response", {
			id: request.id,
			owner: "subagent",
			sourceSessionId: request.sourceSessionId,
			cwd: request.cwd,
			state: { rewire: rewireConfig ? { ...rewireConfig } : undefined, delegationDepth },
		});
	});
	const unsubscribeRenewApply = pi.events.on("px:renew:settings:apply", (payload) => {
		if (!payload || typeof payload !== "object" || !sessionContext) return;
		const request = payload as { transferId?: unknown; owner?: unknown; targetSessionId?: unknown; cwd?: unknown; state?: unknown };
		if (typeof request.transferId !== "string" || request.owner !== "subagent" || request.targetSessionId !== sessionContext.sessionManager.getSessionId() || request.cwd !== sessionContext.cwd) return;
		const state = request.state as { rewire?: unknown; delegationDepth?: unknown } | undefined;
		if (!state || typeof state.delegationDepth !== "number" || !Number.isInteger(state.delegationDepth)) return;
		if (state.delegationDepth < -1 || state.delegationDepth > MAX_SUBAGENT_DEPTH) return;
		const config = state.rewire;
		if (config !== undefined) {
			if (!config || typeof config !== "object") return;
			const value = config as { enabled?: unknown; model?: unknown; thinkingLevel?: unknown };
			if (typeof value.enabled !== "boolean" || typeof value.model !== "string" || !value.model.trim() || !THINKING_LEVELS.includes(value.thinkingLevel as any)) return;
			setRewireConfig(sessionContext, { enabled: value.enabled, model: value.model, thinkingLevel: value.thinkingLevel as SubagentRewireConfig["thinkingLevel"] });
		}
		setDelegationDepth(sessionContext, state.delegationDepth);
		pi.events.emit("px:renew:settings:ack", {
			transferId: request.transferId,
			owner: "subagent",
			targetSessionId: request.targetSessionId,
			cwd: request.cwd,
		});
	});
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
	// non-interactive; `/px:agents` owns inspection and control. The panel
	// coordinator owns the single `px-panels` widget, so this only publishes
	// formatted lines and never calls `ctx.ui.setWidget` itself. Content is
	// cleared on shutdown before the session context is dropped.
	const activeWidget = new ActiveSubagentWidget({
		setWidget: (content) => {
			// The coordinator caches the lines and calls `render` at draw time with
			// the terminal width, so the subagent keeps its own wrapping and inset.
			pi.events.emit(PANELS_CONTENT_EVENT, {
				id: SUBAGENT_PANEL_ID,
				content,
				render: (lines: readonly string[], width: number) =>
					renderActiveSubagentWidgetContent(lines, width, {
						dim: (text) => sessionContext?.ui.theme.fg("dim", text) ?? text,
					}),
			});
		},
		// Ticks re-read the registry so elapsed time (and any state change that
		// did not emit a progress update) keeps moving during silent periods.
		listRuns: () => registry.list(),
		styles: () => ({
			bold: (text) => sessionContext?.ui.theme.bold(text) ?? text,
			italic: (text) => sessionContext?.ui.theme.italic(text) ?? text,
			// The subagent brand follows Pi's purple thinking-level color.
			accent: (text) => sessionContext?.ui.theme.fg("thinkingHigh", text) ?? text,
			muted: (text) => sessionContext?.ui.theme.fg("muted", text) ?? text,
			dim: (text) => sessionContext?.ui.theme.fg("dim", text) ?? text,
			success: (text) => sessionContext?.ui.theme.fg("success", text) ?? text,
			warning: (text) => sessionContext?.ui.theme.fg("warning", text) ?? text,
			error: (text) => sessionContext?.ui.theme.fg("error", text) ?? text,
		}),
		contextWindowForModel,
	});

	// Panel coordinator bridge. The coordinator owns Alt+P and broadcasts which
	// panel is active; the widget starts collapsed and is expanded only while the
	// subagents panel is selected. The bridge keeps the Watch overlay's temporary
	// suppression separate from the active panel so a cycle change made while
	// Watch is open survives the restore. See ../panels/contract.ts for the
	// protocol.
	const panelBridge = new SubagentPanelBridge((collapsed) => activeWidget.setCollapsed(collapsed));
	const hasActiveSubagentRuns = (): boolean => registry.list().some((run) => !run.completedAt);
	const publishPanelVisibility = (): void => {
		const visible = hasActiveSubagentRuns();
		if (panelBridge.noteVisibility(visible)) {
			pi.events.emit(PANELS_VISIBILITY_EVENT, { id: SUBAGENT_PANEL_ID, visible });
		}
	};
	// Announce the panel on every session start. `register` also makes the
	// coordinator re-broadcast the active panel (always `null`/collapsed until a
	// cycle key), so a panel that starts after the coordinator still learns the
	// current selection. Registration never expands the panel.
	const announceSubagentPanel = (): void => {
		const visible = hasActiveSubagentRuns();
		// Seed the de-dup state so the first widget refresh does not re-announce.
		panelBridge.noteVisibility(visible);
		pi.events.emit(PANELS_REGISTER_EVENT, {
			id: SUBAGENT_PANEL_ID,
			label: SUBAGENT_PANEL_LABEL,
			order: SUBAGENT_PANEL_ORDER,
			visible,
		});
	};
	// Subscribed for the whole extension lifetime; unsubscribed on shutdown so
	// `/reload` cannot leave a stale listener on the shared event bus.
	const offPanelActive = pi.events.on(PANELS_ACTIVE_EVENT, (payload) => {
		const active = parsePanelActive(payload);
		if (active) panelBridge.handleActive(active.activeId);
	});

	let nameState: SessionNameState = { agentIds: new Set(), dispatchIds: new Set() };
	let newRunId = createRunIdGenerator("agent", nameState.agentIds);
	let newDispatchId = createRunIdGenerator("dispatch", nameState.dispatchIds);

	// Extension-owned dispatches: async descendants and blocking dispatches alike.
	// Independent of any parent tool invocation: `deliver` is fire-and-forget and
	// failures are swallowed so a stale extension instance or a replacement
	// session can never throw here.
	const dispatchManager = new DispatchLifecycleManager({
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

	// Mark every run of a dispatch that was detached from a blocking turn so the
	// manager/menu shows it as background work, and hold the Herdr pane `working`
	// until the now-detached dispatch settles.
	function markDispatchDetached(dispatchId: string): void {
		for (const run of registry.list()) {
			if (run.dispatchId === dispatchId) run.detached = true;
		}
		publishActiveSubagentWidget();
		emitHerdrBackground(dispatchId, true);
	}

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
		publishPanelVisibility();
	}

	// Resolve a model's context window for the chat usage line's `ctx:<n>%`. The
	// recorded model may be a bare id (from the child's message) or a
	// `provider/id` string (from the parent's dispatch defaults), so try the split
	// form first and fall back to scanning every registered model. Returns
	// undefined when the registry has no match, which omits the percentage rather
	// than falling back to an absolute token count.
	function contextWindowForModel(model?: string): number | undefined {
		if (!model) return undefined;
		const registry = sessionContext?.modelRegistry;
		if (!registry) return undefined;
		const slash = model.indexOf("/");
		if (slash > 0) {
			const direct = registry.find(model.slice(0, slash), model.slice(slash + 1));
			if (direct && direct.contextWindow > 0) return direct.contextWindow;
		}
		for (const candidate of registry.getAll()) {
			if ((candidate.id === model || `${candidate.provider}/${candidate.id}` === model) && candidate.contextWindow > 0) {
				return candidate.contextWindow;
			}
		}
		return undefined;
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
		/** Watch uses a floating read-only panel and never changes run ownership. */
		watchOnly?: boolean;
	}

	/**
	 * Fraction of the terminal a floating Watch panel may occupy. The view sizes
	 * its frame to the same budget so pi never truncates the bottom border away.
	 */
	const WATCH_OVERLAY_HEIGHT_RATIO = 0.7;

	async function openAttachOverlay(target: AttachOverlayTarget, ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		// Watch floats over the editor, so keep the widget out of its way while it
		// is open. Suppression is a flag, not a snapshot: if the user cycles
		// panels while Watch is open, clearing the flag re-derives the collapsed
		// state from the current active panel instead of undoing the cycle.
		if (target.watchOnly) panelBridge.setWatchSuppress(true);
		try {
			const buildView = (tui: TUI, theme: Theme, done: (result: null) => void) => {
				const editorTheme: EditorTheme = {
					borderColor: (text) => theme.fg("accent", text),
					selectList: getSelectListTheme(),
				};
				const live = target.live;
				const interactive = live && !target.watchOnly;
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
					// Match pi's resolved maxHeight (floor of the ratio, clamped to the
					// margin-reduced terminal) so the view fits instead of being cut.
					maxHeight: target.watchOnly
						? Math.min(
							Math.floor(tui.terminal.rows * WATCH_OVERLAY_HEIGHT_RATIO),
							Math.max(1, tui.terminal.rows - 4),
						)
						: undefined,
					watchOnly: target.watchOnly,
					bordered: target.watchOnly,
					// A recovered persisted transcript has no child to control, so it is
					// always read-only even if its stored result lacks a final state.
					forceReadOnly: !live,
					editor: interactive ? new Editor(tui, editorTheme) : undefined,
					// Address every control through the captured run object, not the
					// registry, so the overlay keeps working after the registry prunes
					// the entry once the run completes.
					steer: interactive ? (_runId, message) => sendSteer(live, message) : undefined,
					pause: interactive ? () => pauseAttachedRun(live) : undefined,
					resume: interactive ? () => resumeAttachedRun(live) : undefined,
					stop: interactive ? () => stopAttachedRun(live) : undefined,
					confirmStop: interactive
						? (run) => ctx.ui.confirm("Stop subagent", `Stop ${run.agentName} [${run.runId}]?`)
						: undefined,
				});
				closeActiveAttach = () => view.close();
				return view;
			};
			await ctx.ui.custom<null>(
				(tui, theme, _keybindings, done) => buildView(tui, theme, done),
				{
					overlay: true,
					overlayOptions: target.watchOnly
						? {
							anchor: "center",
							width: "80%",
							minWidth: 40,
							maxHeight: `${Math.round(WATCH_OVERLAY_HEIGHT_RATIO * 100)}%`,
							margin: 2,
						}
						: { anchor: "center", width: "100%", minWidth: 40, maxHeight: "100%", margin: 1 },
				},
			);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			closeActiveAttach = undefined;
			if (target.watchOnly) panelBridge.setWatchSuppress(false);
		}
	}

	/** Live watch in a floating read-only panel; ownership and execution stay unchanged. */
	function openWatch(run: SubagentRunRuntime, ctx: ExtensionContext): Promise<void> {
		return openAttachOverlay(
			{
				runId: run.runId,
				agentName: run.agentName,
				startedAt: run.startedAt,
				getResult: () => run.result,
				getCompletedAt: () => run.completedAt,
				live: run,
				watchOnly: true,
			},
			ctx,
		);
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
		// Ownership is derived from the lifecycle handle (not only from runs that
		// existed when a detach happened) so a chain step or queued parallel run
		// that registers afterwards still shows correct attached/background state.
		const descriptors = applyDispatchOwnership(
			mergeManagerDescriptors(runs, persisted, dismissedPersistedHerdrRuns),
			dispatchManager,
		);
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
		const selectableRewireModels = async (ctx: ExtensionContext) => {
			const scoped = ctx.scopedModels.length > 0 ? ctx.scopedModels : undefined;
			const models = scoped?.map((entry) => entry.model) ?? (await ctx.modelRegistry.getAvailable());
			return { scoped, byId: new Map(models.map((model) => [`${model.provider}/${model.id}`, model])) };
		};

		const selectRewirePresetValues = async (ctx: ExtensionContext): Promise<RewirePreset | undefined> => {
			const { byId } = await selectableRewireModels(ctx);
			if (byId.size === 0) {
				ctx.ui.notify("No models are available for subagent rewiring.", "warning");
				return undefined;
			}
			const latest = latestUsedRewirePreset(readStoredRewirePresets(ctx));
			const modelIds = [...byId.keys()].sort();
			if (latest && byId.has(latest.model)) {
				modelIds.splice(modelIds.indexOf(latest.model), 1);
				modelIds.unshift(latest.model);
			}
			const selectedModel = await ctx.ui.select("Subagent preset model", modelIds);
			if (!selectedModel) return undefined;
			const model = byId.get(selectedModel);
			if (!model) return undefined;
			const levels = availableThinkingLevels(model);
			if (latest?.model === selectedModel && levels.includes(latest.thinkingLevel)) {
				levels.splice(levels.indexOf(latest.thinkingLevel), 1);
				levels.unshift(latest.thinkingLevel);
			}
			const selectedEffort = await ctx.ui.select("Subagent preset effort", levels);
			const thinkingLevel = levels.find((level) => level === selectedEffort);
			return thinkingLevel ? { model: selectedModel, thinkingLevel } : undefined;
		};

		const readStoredRewirePresets = (ctx: ExtensionContext): RewirePreset[] => {
			try {
				return loadRewirePresets(presetFilePath);
			} catch (error) {
				ctx.ui.notify(
					`Could not read rewire presets: ${error instanceof Error ? error.message : String(error)} Create a preset to replace the invalid file.`,
					"error",
				);
				return [];
			}
		};

		const updateStoredRewirePresets = async (
			ctx: ExtensionContext,
			update: (presets: RewirePreset[]) => RewirePreset[],
		): Promise<boolean> => {
			try {
				await withFileMutationQueue(presetFilePath, async () => {
					let current: RewirePreset[];
					try {
						current = loadRewirePresets(presetFilePath);
					} catch {
						current = [];
					}
					const next = update(current);
					saveRewirePresets(presetFilePath, next);
				});
				return true;
			} catch (error) {
				ctx.ui.notify(`Could not save rewire presets: ${error instanceof Error ? error.message : String(error)}`, "error");
				return false;
			}
		};

		const showRewirePresets = async (ctx: ExtensionContext): Promise<void> => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Rewire preset management requires TUI mode.", "warning");
				return;
			}
			while (true) {
				const presets = readStoredRewirePresets(ctx);
				const result = await ctx.ui.custom<RewirePresetListResult>((tui, theme, keybindings, done) =>
					new RewirePresetListView({
						presets,
						theme: {
							fg: (color, text) => theme.fg(color as Parameters<typeof theme.fg>[0], text),
							bold: (text) => theme.bold(text),
						},
						keybindings,
						requestRender: () => tui.requestRender(),
						done,
					}),
				);
				if (!result || result.type === "cancel") return;
				if (result.type === "create") {
					const preset = await selectRewirePresetValues(ctx);
					if (!preset) continue;
					const existed = presets.some(
						(candidate) => candidate.model === preset.model && candidate.thinkingLevel === preset.thinkingLevel,
					);
					if (existed) {
						ctx.ui.notify(`Preset already exists: ${formatRewirePreset(preset)}`, "warning");
						continue;
					}
					if (await updateStoredRewirePresets(ctx, (current) => addRewirePreset(current, preset))) {
						ctx.ui.notify(`Preset created: ${formatRewirePreset(preset)}`, "info");
					}
					continue;
				}
				const preset = presets[result.index];
				if (!preset) continue;
				if (result.type === "delete") {
					const confirmed = await ctx.ui.confirm("Delete rewire preset", `Delete ${formatRewirePreset(preset)}?`);
					if (confirmed) {
						await updateStoredRewirePresets(ctx, (current) => {
							const index = current.findIndex(
								(candidate) =>
									candidate.model === preset.model && candidate.thinkingLevel === preset.thinkingLevel,
							);
							return deleteRewirePreset(current, index);
						});
					}
					continue;
				}
				const { byId } = await selectableRewireModels(ctx);
				const model = byId.get(preset.model);
				if (!model) {
					ctx.ui.notify(`Model ${preset.model} is not available in this session.`, "warning");
					continue;
				}
				if (!availableThinkingLevels(model).includes(preset.thinkingLevel)) {
					ctx.ui.notify(`Effort ${preset.thinkingLevel} is not supported by ${preset.model}.`, "warning");
					continue;
				}
				const config = rewireConfig ?? (await defaultRewireConfigWithPreset(ctx));
				if (!config) return;
				setRewireConfig(ctx, { ...config, model: preset.model, thinkingLevel: preset.thinkingLevel });
				await updateStoredRewirePresets(ctx, (current) => markRewirePresetUsed(current, preset));
				return;
			}
		};

		const configureRewire = async (ctx: ExtensionContext): Promise<void> => {
			rewireConfig ??= await defaultRewireConfigWithPreset(ctx);
			if (!rewireConfig) {
				ctx.ui.notify("No active model is available for subagent rewiring.", "warning");
				return;
			}
			while (true) {
				const config = rewireConfig;
				if (!config) return;
				const presetChoice = `Presets (${readStoredRewirePresets(ctx).length})`;
				const choice = await ctx.ui.select(
					"Subagent rewire configuration",
					[presetChoice, `Model  ${config.model}`, `Effort  ${config.thinkingLevel}`, "Back"],
				);
				if (!choice || choice === "Back") return;
				if (choice === presetChoice) {
					await showRewirePresets(ctx);
					continue;
				}
				if (choice.startsWith("Model  ")) {
					const { scoped, byId } = await selectableRewireModels(ctx);
					if (byId.size === 0) {
						ctx.ui.notify("No models are available for subagent rewiring.", "warning");
						continue;
					}
					const selected = await ctx.ui.select("Subagent override model", [...byId.keys()].sort());
					if (!selected) continue;
					const model = byId.get(selected);
					if (!model) continue;
					const levels = availableThinkingLevels(model);
					const pinned = scoped?.find((entry) => `${entry.model.provider}/${entry.model.id}` === selected)?.thinkingLevel;
					const fallback = levels.includes(config.thinkingLevel)
						? config.thinkingLevel
						: levels.includes("medium")
							? "medium"
							: levels[0] ?? "off";
					setRewireConfig(ctx, {
						...config,
						model: selected,
						thinkingLevel: pinned && levels.includes(pinned) ? pinned : fallback,
					});
					continue;
				}

				const availableModels = await ctx.modelRegistry.getAvailable();
				const model = availableModels.find(
					(candidate) => `${candidate.provider}/${candidate.id}` === config.model,
				);
				if (!model) {
					ctx.ui.notify(`Model ${config.model} is no longer available.`, "warning");
					continue;
				}
				const levels = availableThinkingLevels(model);
				const selected = await ctx.ui.select("Subagent override effort", levels);
				const effort = levels.find((level) => level === selected);
				if (effort) setRewireConfig(ctx, { ...config, thinkingLevel: effort });
			}
		};

		const toggleRewire = async (ctx: ExtensionContext): Promise<void> => {
			rewireConfig ??= await defaultRewireConfigWithPreset(ctx);
			if (!rewireConfig) {
				ctx.ui.notify("No active model is available for subagent rewiring.", "warning");
				return;
			}
			setRewireConfig(ctx, { ...rewireConfig, enabled: !rewireConfig.enabled });
		};

		const openRewireMenu = async (ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) return;
			rewireConfig ??= await defaultRewireConfigWithPreset(ctx);
			while (true) {
				const rewireBadge = rewireConfig?.enabled
					? ctx.ui.theme.fg("error", "[ON]")
					: ctx.ui.theme.fg("muted", "[OFF]");
				const rewireChoice = `Rewire   ${rewireBadge}`;
				const rewireTarget = rewireConfig?.enabled
					? ctx.ui.theme.fg("muted", `Rewiring to ${formatRewirePreset(rewireConfig)}`)
					: undefined;
				const choice = await ctx.ui.select("Subagent rewiring", [
					rewireChoice,
					"\ue615  Configuration",
					...(rewireTarget ? [rewireTarget] : []),
				]);
				if (!choice) return;
				if (choice === rewireTarget) continue;
				if (choice === rewireChoice) {
					await toggleRewire(ctx);
					continue;
				}
				await configureRewire(ctx);
			}
		};

		const configureDelegationDepth = async (ctx: ExtensionContext): Promise<void> => {
			const choices = [
				"Disabled  (-1)",
				"Top level only  (0)",
				...Array.from({ length: MAX_SUBAGENT_DEPTH }, (_, index) => {
					const depth = index + 1;
					return `${depth} recursive level${depth === 1 ? "" : "s"}  (${depth})`;
				}),
			];
			const selected = await ctx.ui.select("Subagent delegation depth", choices);
			if (!selected) return;
			const match = selected.match(/\((-?\d+)\)$/);
			if (match) setDelegationDepth(ctx, Number(match[1]));
		};

		const openAgentConfigMenu = async (ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) return;
			while (true) {
				const delegationChoice = `Delegation  ${formatSubagentDepth(delegationDepth)} (${delegationDepth})`;
				const rewireChoice = `Rewire  ${rewireConfig?.enabled ? "ON" : "OFF"}`;
				const choice = await ctx.ui.select("Subagent configuration", [delegationChoice, rewireChoice, "Back"]);
				if (!choice || choice === "Back") return;
				if (choice === delegationChoice) {
					await configureDelegationDepth(ctx);
					continue;
				}
				await openRewireMenu(ctx);
			}
		};

		const eventContext = (payload: unknown): ExtensionContext | undefined => {
			if (!payload || typeof payload !== "object") return undefined;
			return (payload as { ctx?: ExtensionContext }).ctx;
		};
		pi.events.on(SUBAGENT_REWIRE_TOGGLE_EVENT, (payload) => {
			const ctx = eventContext(payload);
			if (ctx) void toggleRewire(ctx);
		});
		pi.events.on(SUBAGENT_REWIRE_MENU_EVENT, (payload) => {
			const ctx = eventContext(payload);
			if (ctx) void openRewireMenu(ctx);
		});

		pi.registerCommand("px:agents:rewire", {
			description: "Override the model and effort for every subagent in this session",
			handler: async (_args, ctx) => openRewireMenu(ctx),
		});

		pi.registerCommand("px:agents:config", {
			description: "Configure subagent delegation depth and rewiring for this session",
			handler: async (_args, ctx) => openAgentConfigMenu(ctx),
		});

		const openAgentManager = async (ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) return;
			while (true) {
				const items = managerItems(ctx);
				const result = await ctx.ui.custom<ManagerListResult>((tui, theme, keybindings, done) =>
					new ManagerListView<ManagerItem>({
						items,
						theme: {
							fg: (color, text) => theme.fg(color as Parameters<typeof theme.fg>[0], text),
							bold: (text) => theme.bold(text),
						},
						keybindings,
						requestRender: () => tui.requestRender(),
						done,
						hasTranscript: (item) => Boolean(item.run || item.entry?.result),
					}),
				);
				if (!result || result.type === "cancel") return;
				const item = items[result.itemIndex];
				if (!item) continue;
				if (result.type === "attach") {
					if (item.run) await openAttach(item.run, ctx);
					else if (item.entry) await openRecoveredAttach(item.entry, ctx);
					continue;
				}
				if (result.type === "detach") {
					const dispatchId = item.descriptor.dispatchId;
					if (!dispatchId) continue;
					const outcome = dispatchManager.detach(dispatchId);
					ctx.ui.notify(outcome.message, outcome.ok ? "info" : "warning");
					continue;
				}
				const descriptor = item.descriptor;
				const run = item.run;
				const action = await ctx.ui.select(
					`${descriptor.agentName} [${descriptor.runId}]`,
					managerActions(descriptor),
				);
				if (!action || action === "Back") continue;

				if (action === "Watch") {
					if (run) await openWatch(run, ctx);
					else ctx.ui.notify(`Watch unavailable: ${descriptor.runId} is not a live run.`, "warning");
					continue;
				}

				if (action === "Attach" || action === "View transcript") {
					if (run) await openAttach(run, ctx);
					else if (item.entry) await openRecoveredAttach(item.entry, ctx);
					continue;
				}

				if (action === "Detach") {
					if (!descriptor.dispatchId) continue;
					const outcome = dispatchManager.detach(descriptor.dispatchId);
					ctx.ui.notify(outcome.message, outcome.ok ? "info" : "warning");
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
						// Detached/async work is aborted at the dispatch level so the final
						// completion is classified as aborted and queued chain/parallel work
						// stops. An attached blocking dispatch is per-run: cancelling its
						// controller would kill parallel siblings, so only `run.abort` and the
						// run's child are stopped here.
						if (shouldAbortDispatch(run.dispatchId, (dispatchId) => dispatchManager.isAttached(dispatchId))) {
							dispatchManager.abort(run.dispatchId as string);
						}
						run.abort?.();
						try { run.child?.send({ id: `abort-${run.runId}`, type: "abort" }); } catch {}
						await run.child?.terminate();
					}
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			}
		};

		pi.events.on(SUBAGENT_MANAGER_MENU_EVENT, (payload) => {
			const ctx = eventContext(payload);
			if (ctx) void openAgentManager(ctx);
		});

		pi.registerCommand("px:agents", {
			description: "Manage active and recent subagent runs",
			handler: async (_args, ctx) => openAgentManager(ctx),
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
		const sessionId = ctx.sessionManager.getSessionId();
		nameState = nameSessionStates.get(sessionId) ?? { agentIds: new Set(), dispatchIds: new Set() };
		// Rebuild reservations from persisted session results after a process restart;
		// the global map covers ordinary extension reloads.
		for (const entry of persistedAgentLogEntries(ctx.sessionManager.getBranch())) {
			if (entry.runId?.startsWith("ag_")) nameState.agentIds.add(entry.runId);
			if (entry.dispatchId?.startsWith("dp_")) nameState.dispatchIds.add(entry.dispatchId);
		}
		nameSessionStates.delete(sessionId);
		nameSessionStates.set(sessionId, nameState);
		while (nameSessionStates.size > 32) {
			const oldest = nameSessionStates.keys().next().value;
			if (oldest === undefined) break;
			nameSessionStates.delete(oldest);
		}
		newRunId = createRunIdGenerator("agent", nameState.agentIds);
		newDispatchId = createRunIdGenerator("dispatch", nameState.dispatchIds);
		const storedRewire = rewireSessionStates.get(sessionId);
		rewireConfig = storedRewire ? { ...storedRewire } : await defaultRewireConfigWithPreset(ctx);
		delegationDepth = isSubagentChild
			? configuredDefaultDepth
			: (delegationDepthSessionStates.get(sessionId) ?? configuredDefaultDepth);
		publishRewireStatus();
		publishDelegationDepthStatus();
		sessionEpoch += 1;
		sessionShutdown = new AbortController();
		herdrPreflightInFlight.reset();
		// A replacement session must not adopt the previous session's Herdr tab.
		herdrSession = undefined;
		herdrBackend = undefined;
		dismissedPersistedHerdrRuns.clear();
		dispatchManager.reset();
		// Remove stale persisted tab records left by a crash/manual cleanup.
		cleanupStaleHerdrTabState();
		// Forget the previous widget content so the first refresh always
		// republishes (and clears a stale widget from an earlier session).
		activeWidget.reset();
		announceSubagentPanel();
		publishActiveSubagentWidget();
		// Re-announce detached work: a reload replaces the Herdr integration, so
		// its background lease starts empty.
		for (const handle of dispatchManager.handles) {
			// Attached blocking dispatches belong to the live parent turn; only
			// backgrounded work needs a Herdr lease re-announcement.
			if (handle.ownership !== "attached") emitHerdrBackground(handle.dispatchId, true);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		sessionContext = ctx;
		publishRewireStatus();
		publishDelegationDepthStatus();
		// The tree can re-render with the same active set, so reset the dedup
		// state and force a republish instead of skipping an identical snapshot.
		activeWidget.reset();
		publishActiveSubagentWidget();
		for (const handle of dispatchManager.handles) {
			if (handle.ownership !== "attached") emitHerdrBackground(handle.dispatchId, true);
		}
	});

	pi.on("session_shutdown", async (event) => {
		pi.events.emit(STATUS_BAR_REWIRE_CLEAR_EVENT, {});
		pi.events.emit(STATUS_BAR_SUBAGENT_DEPTH_CLEAR_EVENT, {});
		unsubscribeRenewSettings();
		unsubscribeRenewApply();
		// Drop the panel subscription so `/reload` cannot leave a stale listener
		// on the shared event bus, then forget the coordinator-derived state.
		offPanelActive();
		panelBridge.reset();
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
		const dispatchesSettled = dispatchManager.shutdown();
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

	// Shared theming for the compact run lines: a colored outcome glyph, the run
	// id upright, and the rest italic and muted. Used by the live per-run entry
	// and by the expanded dispatch list so a settled run reads identically.
	const runLineStylesFor = (theme: {
		fg: (color: any, text: string) => string;
		italic: (text: string) => string;
	}): RunLineStyles => ({
		success: (text) => theme.fg("success", text),
		warning: (text) => theme.fg("warning", text),
		error: (text) => theme.fg("error", text),
		muted: (text) => theme.fg("muted", text),
		italic: (text) => theme.italic(text),
	});

	// One muted TUI-only line per settled detached run. `appendEntry` keeps it out
	// of the LLM context and never triggers a turn, so the dispatch's single
	// injected aggregate stays the only thing the model sees.
	function publishRunFinishedEntry(runId: string, result: SingleResult): void {
		if (shuttingDown || process.env.PI_SUBAGENT_CHILD === "1") return;
		try {
			pi.appendEntry<SubagentRunFinishedEntry>(
				SUBAGENT_RUN_FINISHED_CUSTOM_TYPE,
				buildRunFinishedEntry(runId, result, contextWindowForModel(result.model)),
			);
		} catch {
			// A stale instance or a replacement session must never break a run.
		}
	}

	// Renderer for the live per-run line. The host owns transcript spacing and
	// adds one blank line before every entry; the entry API never receives
	// `outputPad`, so the line pads itself. Expanded adds the identity the
	// collapsed line omits.
	pi.registerEntryRenderer<SubagentRunFinishedEntry>(
		SUBAGENT_RUN_FINISHED_CUSTOM_TYPE,
		(entry, { expanded }, theme) => {
			const data = normalizeRunFinishedEntry(entry.data);
			if (!data) {
				return new Text(theme.fg("dim", theme.italic("⊘ subagent run settled")), RUN_LINE_OUTPUT_PAD, 0);
			}
			const container = new Container();
			container.addChild(
				new Text(
					formatRunLine(runLinePartsFromEntry(data), runLineStylesFor(theme)),
					RUN_LINE_OUTPUT_PAD,
					0,
				),
			);
			if (expanded) {
				const detailPad = RUN_LINE_OUTPUT_PAD + 2;
				const identity = [data.agent && `agent ${data.agent}`, data.model].filter(Boolean).join(" · ");
				if (identity) {
					container.addChild(new Text(theme.fg("dim", theme.italic(identity)), detailPad, 0));
				}
				if (data.task) {
					const task = data.task.length > 120 ? `${data.task.slice(0, 120)}…` : data.task;
					container.addChild(new Text(theme.fg("dim", theme.italic(task)), detailPad, 0));
				}
			}
			return container;
		},
	);

	// Compact/expanded renderer for the one async aggregate completion message.
	// Pure data/text/blocks live in `completion.ts`; this adapter only maps them
	// onto TUI components, so collapsed and expanded output cannot drift from the
	// tested model. Legacy/malformed details fall back to the model-visible
	// content so a completion is never hidden. A left click toggles this message
	// on its own; ctrl+o still drives every message through the harness.
	pi.registerMessageRenderer<SubagentDetails>(
		SUBAGENT_COMPLETION_CUSTOM_TYPE,
		(message, { expanded, outputPad }, theme) => {
			const data = buildCompletionRenderData(message.details, undefined, contextWindowForModel);
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

			const build = (isExpanded: boolean): Component => {
				if (!isExpanded) return new Text(`${icon} ${data.title}`, outputPad, 0);
				const container = new Container();
				const mdTheme = getMarkdownTheme();
				const styles = runLineStylesFor(theme);
				let entrySeen = false;
				for (const block of buildCompletionRenderBlocks(data)) {
					switch (block.kind) {
						case "title":
							container.addChild(new Text(`${icon} ${block.text}`, outputPad, 0));
							break;
						case "summary":
							container.addChild(new Text(theme.fg("dim", block.text), outputPad, 0));
							break;
						case "entry":
							// Every settled run first, in planned order, before the verbose
							// per-run detail below.
							if (!entrySeen) {
								container.addChild(new Spacer(1));
								entrySeen = true;
							}
							container.addChild(
								new Text(formatRunLine(block.parts, styles), outputPad, 0),
							);
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
						case "usage":
							container.addChild(new Text(theme.fg("dim", block.text), outputPad, 0));
							break;
					}
				}
				return container;
			};

			return new ClickToggleComponent(build, expanded);
		},
	);

	if (!isSubagentChild || canDelegate(delegationDepth)) {
		pi.registerTool({
			name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential; {previous} in a step task is replaced with the previous step's final output).",
			'Execution: omitted or "async" (default) runs detached in the background and returns a dispatch id immediately; the aggregate result is injected automatically when it settles, so do not poll for it. Use execution: "blocking" to stream progress and wait for the final result in this turn; a blocking dispatch can also be moved to the background mid-turn from /px:agents ("Detach"), after which its result arrives automatically as one completion. Detached children may modify the shared working tree, so re-read affected files before editing them.',
			'Control a running subagent without starting new work: set action to "stop" (abort; repeat to force termination) or "steer" (deliver guidance) and address it with dispatchId (all active runs of one dispatch) or runId (one child). "steer" requires message, and a control call rejects dispatch fields. A stopped dispatch still emits its normal aggregate completion, marked aborted.',
		'Optional herdr object runs the dispatch in a pane of a parent-owned Herdr tab behind an authenticated bridge: herdr: {} uses retain "failed"; herdr: { retain: "always" } keeps successful panes too. Omit to use the default direct process. Herdr is never used as an automatic fallback, and it is rejected on control calls.',
		'Restricted agent names (per the user config) require a timed parent approval for each dispatch and are denied when no UI is available.',
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
						abortDispatch: (dispatchId) => dispatchManager.abort(dispatchId),
						steer: (run, message, options) => sendSteer(run, message, options),
					},
					{ signal },
				);
			}
			// Refuse before preparation once teardown starts: an accepted dispatch
			// must never outlive the session that owns it. Re-checked again below
			// because preparation is async and can straddle a shutdown event.
			if (!canDelegate(delegationDepth)) {
				return buildNotStartedResult("Subagent dispatch not started: delegation is disabled for this session.");
			}
			if (shuttingDown) {
				return buildNotStartedResult("Subagent dispatch not started: the session is shutting down.");
			}
			const restrictedConfig = loadRestrictedAgentConfig();
			const preparation = await prepareSubagentDispatch(params as SubagentRequest, {
				discoverAgents,
				requestPermission: (what, data) => askHubPermission(what, data, ctx),
				restrictedAgentPatterns: restrictedConfig.restrictedAgentPatterns,
				requestRestrictedAgentApproval: (approvalRequest) =>
					promptRestrictedAgentApproval(
						approvalRequest,
						restrictedConfig.restrictedAgentPromptTimeoutSeconds,
						ctx,
						pi.events,
					),
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
					...(rewireConfig?.enabled ? { rewire: { ...rewireConfig } } : {}),
				},
			});
			if (!preparation.ok) return preparation.result;

			const dispatch = preparation.dispatch;
			// `progress` is optional: subagent must keep working when hub is absent.
			// Build the relay wiring per dispatch from the parent runtime.
			let hasProgressTool = false;
			try {
				hasProgressTool = pi.getAllTools().some((tool) => tool.name === "progress");
			} catch {
				hasProgressTool = false;
			}
			const runtime: SingleAgentRuntimeDependencies = {
				activeChildren,
				approvalQueue,
				parentContext: ctx,
				registry,
				events: pi.events,
				backendFor,
				shutdownSignal: sessionShutdown.signal,
				onProgress: publishActiveSubagentWidget,
				onRunSettled: publishRunFinishedEntry,
				hasProgressTool,
				delegationDepth,
				emitProgressRelay: (channel, payload) => pi.events.emit(channel, payload),
			};
			const makeRunner = (target: PreparedSubagentDispatch): DispatchRuntimeDependencies => ({
				runSingle: (request) => runSingleAgent(request, target, runtime),
			});

			// Track the whole post-preparation execution so shutdown can abort and
			// await blocking runs (and the pre-spawn window) before disposing the tab.
			const execution = (async () => {
				if (dispatch.execution === "blocking") {
					// Blocking is only wait/stream policy: the dispatch is owned from launch
					// by the lifecycle manager with its own controller. While attached the
					// parent signal forwards and onUpdate streams; detaching moves the same
					// child to the background without restarting it.
					const handle = dispatchManager.start(
						dispatch,
						(dispatchSignal, gatedUpdate) =>
							runPreparedDispatch(dispatch, makeRunner(dispatch), dispatchSignal, gatedUpdate),
						{
							attach: { parentSignal: signal, onUpdate },
							onDetach: markDispatchDetached,
						},
					);
					if (!handle) {
						return buildDispatchExceptionResult(
							dispatch,
							new Error("Subagent dispatch not started: the session is shutting down."),
							{ aborted: true },
						);
					}
					// Only a detached blocking dispatch holds a Herdr background lease, so
					// clear one only when a detach actually happened.
					const clearDetachedLease = (): void => {
						if (handle.everDetached) emitHerdrBackground(handle.dispatchId, false);
					};
					void handle.promise.then(clearDetachedLease, clearDetachedLease);
					return handle.result;
				}

				// Async acceptance is guarded against shutdown (which may have begun
				// during the awaited preparation) and against an already-aborted parent
				// turn. A refused dispatch is terminal, never a started acknowledgement.
				if (shuttingDown || !dispatchManager.canStart(signal)) {
					const reason = shuttingDown ? "the session is shutting down" : "the parent turn was aborted";
					return buildDispatchExceptionResult(dispatch, new Error(`Subagent dispatch not started: ${reason}.`), {
						aborted: true,
					});
				}

				// Async: detach with an independent controller. Never pass the parent
				// tool signal or the completed invocation's onUpdate callback; live UI
				// comes from the registry and active-subagents widget instead.
				const handle = dispatchManager.start(dispatch, (dispatchSignal) =>
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

			const renderCollapsedSingle = (items: DisplayItem[], runningText: string) => {
				const tools = items.filter((item): item is Extract<DisplayItem, { type: "toolCall" }> => item.type === "toolCall");
				const latestTextLine = runningText
					.trim()
					.split(/\r?\n/)
					.filter((line) => line.trim().length > 0)
					.at(-1);
				const textLineCount = latestTextLine ? 1 : 0;
				const needsSkippedLine = tools.length > COLLAPSED_TOOL_COUNT;
				const toolLimit = Math.min(
					COLLAPSED_TOOL_COUNT,
					COLLAPSED_PREVIEW_LINE_COUNT - textLineCount - (needsSkippedLine ? 1 : 0),
				);
				const toShow = tools.slice(-toolLimit);
				const skipped = tools.length - toShow.length;
				let text = "";
				if (skipped > 0) text += `${theme.fg("muted", `... ${skipped} earlier items`)}\n`;
				for (const item of toShow) text += `${renderToolItem(item)}\n`;
				if (latestTextLine) text += theme.fg("muted", `│ ${latestTextLine}`);
				return { text: text.trimEnd(), truncated: skipped > 0 };
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
					const usageStr = formatUsageStats(r.usage, r.model, r.thinkingLevel, contextWindowForModel(r.model));
					if (timingStr || usageStr) container.addChild(new Spacer(1));
					if (timingStr) container.addChild(new Text(theme.fg("dim", timingStr), 0, 0));
					if (usageStr) container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				const runningText = isActive ? (r.liveText || finalOutput) : "";
				if (isActive) text += ` ${theme.fg("warning", `[${r.state ?? "running"}]`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0 && !runningText) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					const preview = renderCollapsedSingle(displayItems, runningText);
					if (preview.text) text += `\n${preview.text}`;
					const finalOutputLines = isActive ? [] : finalOutput.trim().split(/\r?\n/);
					const finalOutputTruncated = finalOutputLines.length > COLLAPSED_FINAL_OUTPUT_LINE_COUNT;
					const finalOutputPreviewLines = finalOutputLines
						.slice(0, COLLAPSED_FINAL_OUTPUT_LINE_COUNT)
						.map((line) => theme.fg("muted", "│ ") + theme.fg("toolOutput", line));
					if (finalOutputTruncated) finalOutputPreviewLines.push(theme.fg("muted", "│ ..."));
					const finalOutputPreview = finalOutputPreviewLines.join("\n");
					if (finalOutputPreview) text += `\n${finalOutputPreview}`;
					if (preview.truncated || finalOutputTruncated) {
						text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
					}
				}
				const timingStr = formatResultTiming(r);
				const usageStr = formatUsageStats(r.usage, r.model, r.thinkingLevel, contextWindowForModel(r.model));
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
						const stepUsage = formatUsageStats(r.usage, r.model, r.thinkingLevel, contextWindowForModel(r.model));
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
						const taskUsage = formatUsageStats(r.usage, r.model, r.thinkingLevel, contextWindowForModel(r.model));
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
}
