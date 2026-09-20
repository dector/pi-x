/**
 * Parent-side control of already-running subagents.
 *
 * `stop` and `steer` are addressed by `dispatchId` (every active run of one
 * dispatch) or `runId` (one child). They are ordinary subagent tool calls, so
 * the parent model can abort or redirect work without shell-killing child
 * processes and leaving the registry stale.
 *
 * `stop` escalates: the first stop aborts cooperatively (the owning controller
 * for a detached dispatch, or a run's stop handle otherwise) and a later stop
 * forces termination, so a wedged child cannot keep the registry stale.
 *
 * `steer` reuses the child's native RPC `steer` command (see `registry.ts`).
 *
 * Error contract: Pi 0.85.1 ignores a returned `isError` flag and only marks a
 * tool result failed when `execute` throws. Genuine failures (validation,
 * unknown/finished targets, total steer failure) therefore throw an `Error`
 * whose message carries the model-visible diagnostic. Partial steer delivery
 * is still a successful result that lists the unreachable runs.
 *
 * Everything runtime-facing is injected (`SubagentControlRuntime`), so this
 * module is unit-testable with fakes and imports no Pi runtime.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SubagentRunRuntime } from "./registry.ts";
import { throwIfAborted } from "./run-stop.ts";
import type {
	SubagentControlAction,
	SubagentControlDetails,
	SubagentDetails,
	SubagentExecution,
} from "./types.ts";

export type { SubagentControlAction } from "./types.ts";

export type SubagentControlTarget =
	| { kind: "dispatch"; dispatchId: string }
	| { kind: "run"; runId: string };

export interface SubagentControlRequest {
	action: SubagentControlAction;
	target: SubagentControlTarget;
	/** Required for `steer`; ignored for `stop`. */
	message?: string;
}

/** Raw fields a control call may carry (the control subset of tool params). */
export interface SubagentControlInput {
	action?: unknown;
	dispatchId?: unknown;
	runId?: unknown;
	message?: unknown;
	agent?: unknown;
	task?: unknown;
	tasks?: unknown;
	chain?: unknown;
	execution?: unknown;
	cwd?: unknown;
	agentScope?: unknown;
	confirmProjectAgents?: unknown;
}

export type SubagentControlParseResult =
	| { ok: true; request: SubagentControlRequest }
	| { ok: false; error: string };

/** Per-call cancellation and RPC deadline for a control operation. */
export interface SubagentControlOptions {
	/** Parent tool-call signal; aborts a steer wait and any pending RPC. */
	signal?: AbortSignal;
	/** RPC deadline for each steer delivery, in milliseconds. */
	timeoutMs?: number;
}

export interface SubagentControlRuntime {
	/** Snapshot of active and recent runs, in registry order. */
	runs(): SubagentRunRuntime[];
	getRun(runId: string): SubagentRunRuntime | undefined;
	/** Abort a detached dispatch controller; false when the manager does not own it. */
	abortDispatch(dispatchId: string): boolean;
	/** Deliver a steering message to one live child; throws when unreachable. */
	steer(
		run: SubagentRunRuntime,
		message: string,
		options?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<void>;
}

/**
 * True when a tool call is a control operation rather than a dispatch. Normal
 * dispatch calls omit `action` and keep their existing behavior.
 */
export function isSubagentControlRequest(input: { action?: unknown }): boolean {
	return input.action !== undefined && input.action !== null;
}

function trimmed(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Field names that describe a new dispatch and must not appear on a control call. */
const DISPATCH_ONLY_FIELDS = ["agent", "task", "tasks", "chain", "execution", "cwd", "agentScope", "confirmProjectAgents"] as const;

/**
 * Validate a control call. Requires an explicit `stop`/`steer` action, exactly
 * one target (`dispatchId` or `runId`), no dispatch-defining fields, and a
 * non-empty `message` for `steer`. IDs are trimmed; the message is preserved.
 */
export function parseSubagentControl(input: SubagentControlInput): SubagentControlParseResult {
	const action = input.action;
	if (action !== "stop" && action !== "steer") {
		return { ok: false, error: `Unknown subagent action ${JSON.stringify(action)}. Use "stop" or "steer".` };
	}
	const presentDispatchFields = DISPATCH_ONLY_FIELDS.filter((field) => input[field] !== undefined);
	if (presentDispatchFields.length > 0) {
		return {
			ok: false,
			error: `A subagent ${action} control cannot include dispatch fields: ${presentDispatchFields.join(", ")}.`,
		};
	}
	const dispatchId = trimmed(input.dispatchId);
	const runId = trimmed(input.runId);
	if ((dispatchId === undefined) === (runId === undefined)) {
		return { ok: false, error: `A subagent ${action} control requires exactly one of dispatchId or runId.` };
	}
	const target: SubagentControlTarget =
		dispatchId !== undefined ? { kind: "dispatch", dispatchId } : { kind: "run", runId: runId as string };

	if (action === "steer") {
		const message = typeof input.message === "string" ? input.message : "";
		if (message.trim().length === 0) {
			return { ok: false, error: "A subagent steer control requires a non-empty message." };
		}
		return { ok: true, request: { action, target, message } };
	}
	return { ok: true, request: { action, target } };
}

function targetId(request: SubagentControlRequest): string {
	return request.target.kind === "dispatch" ? request.target.dispatchId : request.target.runId;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Only unambiguous execution metadata is reported; mixed targets omit it. */
function executionOf(runs: SubagentRunRuntime[]): SubagentExecution | undefined {
	const values = new Set<SubagentExecution>();
	for (const run of runs) if (run.execution) values.add(run.execution);
	return values.size === 1 ? [...values][0] : undefined;
}

/**
 * Canonical successful control tool result. `results` stays empty so a control
 * call is never surfaced as completed history by `/px:agent:log`, and the
 * execution metadata is derived from the targeted runs instead of being
 * hardcoded. Control calls are not dispatches, so no `dispatchStatus` is
 * claimed; `details.control` describes what actually happened.
 */
function controlResult(
	request: SubagentControlRequest,
	text: string,
	options: { runIds?: string[]; failures?: Array<{ runId: string; error: string }>; runs?: SubagentRunRuntime[] } = {},
): AgentToolResult<SubagentDetails> {
	const control: SubagentControlDetails = {
		action: request.action,
		targetKind: request.target.kind,
		targetId: targetId(request),
		runIds: options.runIds ?? [],
		failures: options.failures ?? [],
	};
	const dispatchId = request.target.kind === "dispatch" ? request.target.dispatchId : undefined;
	const execution = options.runs ? executionOf(options.runs) : undefined;
	return {
		content: [{ type: "text", text }],
		details: {
			mode: "single",
			...(execution !== undefined ? { execution } : {}),
			...(dispatchId !== undefined ? { dispatchId } : {}),
			agentScope: "user",
			projectAgentsDir: null,
			results: [],
			control,
		},
	};
}

function failureNote(failures: Array<{ runId: string; error: string }>): string {
	if (failures.length === 0) return "";
	return ` Failed for ${failures.map((failure) => `${failure.runId} (${failure.error})`).join(", ")}.`;
}

/**
 * Stop one run, or every active run of a dispatch. For a dispatch with a
 * managed detached controller, abort that controller too so the lifecycle
 * emits one aborted aggregate completion and stops queued work. A repeated
 * stop reaches the same runs and escalates through their stop handles.
 */
function executeStop(
	request: SubagentControlRequest,
	runtime: SubagentControlRuntime,
): AgentToolResult<SubagentDetails> {
	if (request.target.kind === "run") {
		const runId = request.target.runId;
		const run = runtime.getRun(runId);
		if (!run) throw new Error(`No subagent run ${runId} was found. It may have already settled and been pruned.`);
		if (run.completedAt) throw new Error(`Run ${runId} has already finished and cannot be stopped.`);
		if (!run.abort) throw new Error(`Run ${runId} has no stop handle and cannot be stopped.`);
		run.abort();
		return controlResult(request, `Stopped run ${runId} (${run.agentName}).`, { runIds: [runId], runs: [run] });
	}

	const dispatchId = request.target.dispatchId;
	const active = runtime.runs().filter((run) => run.dispatchId === dispatchId && !run.completedAt);
	const aborted: string[] = [];
	const failures: Array<{ runId: string; error: string }> = [];
	for (const run of active) {
		if (!run.abort) {
			failures.push({ runId: run.runId, error: "no stop handle" });
			continue;
		}
		run.abort();
		aborted.push(run.runId);
	}
	const dispatchAborted = runtime.abortDispatch(dispatchId);
	if (!dispatchAborted && aborted.length === 0) {
		throw new Error(
			`No running dispatch ${dispatchId} could be stopped. It may have already settled.${failureNote(failures)}`,
		);
	}
	const label = aborted.length > 0 ? ` (${aborted.length} run${aborted.length === 1 ? "" : "s"}: ${aborted.join(", ")})` : "";
	const note = dispatchAborted ? " Its aggregate completion will report it as aborted." : "";
	return controlResult(request, `Stopped dispatch ${dispatchId}${label}.${note}${failureNote(failures)}`, {
		runIds: aborted,
		failures,
		runs: active,
	});
}

/**
 * Steer one run, or broadcast a steering message to every active run of a
 * dispatch. Partial delivery is a success that lists the failed runs; total
 * failure or an aborted parent signal throws.
 */
async function executeSteer(
	request: SubagentControlRequest,
	runtime: SubagentControlRuntime,
	options: SubagentControlOptions,
): Promise<AgentToolResult<SubagentDetails>> {
	const message = request.message ?? "";
	const steerOptions = { signal: options.signal, timeoutMs: options.timeoutMs };
	throwIfAborted(options.signal);

	if (request.target.kind === "run") {
		const runId = request.target.runId;
		const run = runtime.getRun(runId);
		if (!run) throw new Error(`No subagent run ${runId} was found.`);
		if (run.completedAt) throw new Error(`Run ${runId} has already finished and cannot be steered.`);
		try {
			await runtime.steer(run, message, steerOptions);
		} catch (error) {
			throwIfAborted(options.signal);
			throw new Error(`Could not steer run ${runId}: ${errorMessage(error)}`);
		}
		return controlResult(request, `Steered run ${runId} (${run.agentName}).`, { runIds: [runId], runs: [run] });
	}

	const dispatchId = request.target.dispatchId;
	const active = runtime.runs().filter((run) => run.dispatchId === dispatchId && !run.completedAt);
	if (active.length === 0) {
		throw new Error(`No active runs found for dispatch ${dispatchId}. It may have already settled.`);
	}
	const delivered: string[] = [];
	const failures: Array<{ runId: string; error: string }> = [];
	for (const run of active) {
		throwIfAborted(options.signal);
		try {
			await runtime.steer(run, message, steerOptions);
			delivered.push(run.runId);
		} catch (error) {
			throwIfAborted(options.signal);
			failures.push({ runId: run.runId, error: errorMessage(error) });
		}
	}
	if (delivered.length === 0) {
		const detail = failures.map((failure) => `${failure.runId}: ${failure.error}`).join("; ");
		throw new Error(`Could not steer dispatch ${dispatchId}. ${detail}`);
	}
	return controlResult(
		request,
		`Steered ${delivered.length} run${delivered.length === 1 ? "" : "s"} of dispatch ${dispatchId}: ${delivered.join(", ")}.${failureNote(failures)}`,
		{ runIds: delivered, failures, runs: active },
	);
}

/** Execute a validated control request against the running subagents. */
export async function executeSubagentControl(
	request: SubagentControlRequest,
	runtime: SubagentControlRuntime,
	options: SubagentControlOptions = {},
): Promise<AgentToolResult<SubagentDetails>> {
	return request.action === "stop" ? executeStop(request, runtime) : executeSteer(request, runtime, options);
}

/** Theme seam for {@link formatControlCall}: only the methods the renderer uses. */
export interface ControlCallTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/**
 * Render the collapsed tool-call line for a control call. Pure and theme
 * injected so it can be tested without the TUI runtime. The steer preview is
 * bounded so a long message cannot flood the transcript.
 */
export function formatControlCall(
	args: { action?: unknown; dispatchId?: unknown; runId?: unknown; message?: unknown },
	theme: ControlCallTheme,
): string {
	const action = typeof args.action === "string" ? args.action : "?";
	const target = args.dispatchId ? `dispatch ${args.dispatchId}` : args.runId ? `run ${args.runId}` : "?(missing target)";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", action) + theme.fg("muted", ` ${target}`);
	if (action === "steer" && typeof args.message === "string" && args.message.length > 0) {
		const preview = args.message.length > 60 ? `${args.message.slice(0, 60)}...` : args.message;
		text += `\n  ${theme.fg("dim", preview)}`;
	}
	return text;
}
