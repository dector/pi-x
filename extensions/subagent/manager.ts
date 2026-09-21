/**
 * Pure decision logic for the `/px:agents` manager UI.
 *
 * The manager lists live registry runs and (when a Herdr location survives)
 * persisted completed runs. Actions and Details fields are derived from a
 * backend-agnostic descriptor so the ordinary process UX stays unchanged while
 * Herdr-backed runs gain `Jump to Herdr pane` and `Close retained pane`.
 *
 * The `ManagerHerdrActions` service performs the pane operations through a
 * narrow port (`focusLocation` / `closeRetainedLocation` / `paneStatus`) and
 * maps stale/foreign pane failures to a structured, notifying result. It never
 * recreates a pane and never touches the recorded subagent result, so a closed
 * pane leaves the transcript and `/px:agent:log` intact.
 *
 * No Pi runtime imports, so this stays loadable from `bun test`.
 */

import { HerdrTabError } from "./herdr-tab.ts";
import type { HerdrPaneStatus } from "./herdr-tab.ts";
import { isFailedResult } from "./result-output.ts";
import type { HerdrRetention, HerdrRunLocation, SubagentBackendKind, SubagentExecution } from "./types.ts";

export type ManagerPaneStatus = HerdrPaneStatus;

/** A manager-visible run, built from a live registry run or a persisted entry. */
export interface ManagerRunDescriptor {
	runId: string;
	agentName: string;
	task: string;
	/** Live run that has not completed. */
	active: boolean;
	failed: boolean;
	state?: string;
	mode?: string;
	execution?: SubagentExecution;
	backend?: SubagentBackendKind;
	herdr?: HerdrRunLocation;
	herdrRetention?: HerdrRetention;
	dispatchId?: string;
	/**
	 * True for an active blocking dispatch that is still attached to its parent
	 * turn. The manager offers `Continue in background` only in this state.
	 */
	attachedBlocking?: boolean;
	/** True once an attached blocking dispatch was moved to the background. */
	detached?: boolean;
	cwd?: string;
	pid?: number;
	inheritedMode?: string;
	effectiveMode?: string;
	outerAccess?: boolean;
	pendingApproval?: string;
	diagnostics?: string[];
	startedAt?: number;
	completedAt?: number;
	/** True when the descriptor came from persisted history, not the registry. */
	persisted?: boolean;
	/** Live-validated status override (for example `missing`). */
	paneStatus?: ManagerPaneStatus;
}

export type ManagerAction =
	| "Attach"
	| "Continue in background"
	| "View transcript"
	| "Details"
	| "Jump to Herdr pane"
	| "Close retained pane"
	| "Configure permissions"
	| "Pause"
	| "Resume"
	| "Abort"
	| "Back";

/** True when a descriptor carries a usable recorded Herdr pane. */
export function hasHerdrPane(descriptor: ManagerRunDescriptor): boolean {
	const herdr = descriptor.herdr;
	return Boolean(herdr && herdr.tabId && herdr.paneId);
}

/** Derived (unvalidated) pane status; `missing` only from a live probe. */
export function derivedPaneStatus(descriptor: ManagerRunDescriptor): ManagerPaneStatus {
	if (descriptor.paneStatus) return descriptor.paneStatus;
	if (!descriptor.herdr) return "missing";
	return descriptor.herdr.retained ? "retained" : "active";
}

/** A completed run whose pane was kept is the only one closeable. */
export function isRetainedCompleted(descriptor: ManagerRunDescriptor): boolean {
	return !descriptor.active && hasHerdrPane(descriptor) && derivedPaneStatus(descriptor) === "retained";
}

/**
 * Actions for one run. Process-backed runs keep exactly the existing actions;
 * Herdr-backed runs gain Jump, and retained completed runs gain Close.
 */
export function managerActions(descriptor: ManagerRunDescriptor): ManagerAction[] {
	const jump = hasHerdrPane(descriptor) && derivedPaneStatus(descriptor) !== "missing";
	if (descriptor.active) {
		const paused =
			descriptor.state === "paused" || descriptor.state === "pause-requested" || descriptor.state === "resuming";
		return [
			"Attach",
			...(descriptor.attachedBlocking ? (["Continue in background"] as ManagerAction[]) : []),
			"Details",
			...(jump ? (["Jump to Herdr pane"] as ManagerAction[]) : []),
			"Configure permissions",
			paused ? "Resume" : "Pause",
			"Abort",
			"Back",
		];
	}
	return [
		"View transcript",
		"Details",
		...(jump ? (["Jump to Herdr pane"] as ManagerAction[]) : []),
		...(isRetainedCompleted(descriptor) ? (["Close retained pane"] as ManagerAction[]) : []),
		"Back",
	];
}

/**
 * Whether `/px:agents` Abort should cancel the whole owning dispatch rather
 * than only the selected run.
 *
 * A detached/async dispatch is aborted at the dispatch level so its aggregate
 * completion is classified as aborted and queued chain/parallel work stops. An
 * attached blocking dispatch is per-run: aborting its controller would cancel
 * parallel siblings, so Abort must use only that run's own stop handle.
 */
export function shouldAbortDispatch(
	dispatchId: string | undefined,
	isAttached: (dispatchId: string) => boolean,
): boolean {
	return dispatchId !== undefined && !isAttached(dispatchId);
}

/**
 * Multi-line Details body. Herdr fields are only included for Herdr-backed
 * locations; `Pane status` reflects a live probe when one was performed.
 */
export function managerDetails(descriptor: ManagerRunDescriptor): string {
	const lines = [
		`Agent: ${descriptor.agentName} [${descriptor.runId}]`,
		`State: ${descriptor.state ?? (descriptor.active ? "running" : "unknown")}`,
		`Execution: ${descriptor.execution ?? "blocking"}`,
		...(descriptor.detached ? ["Ownership: background (detached from blocking turn)"] : []),
		...(descriptor.backend ? [`Backend: ${descriptor.backend}`] : []),
		...(hasHerdrPane(descriptor)
			? [
					`Herdr tab: ${descriptor.herdr?.tabId}`,
					`Herdr pane: ${descriptor.herdr?.paneId}`,
					...(descriptor.herdrRetention ? [`Retention: ${descriptor.herdrRetention}`] : []),
					`Pane status: ${derivedPaneStatus(descriptor)}`,
				]
			: []),
		...(descriptor.dispatchId ? [`Dispatch: ${descriptor.dispatchId}`] : []),
		...(descriptor.pid !== undefined ? [`PID: ${descriptor.pid}`] : []),
		...(descriptor.cwd ? [`CWD: ${descriptor.cwd}`] : []),
		...(descriptor.inheritedMode ? [`Inherited: ${descriptor.inheritedMode}`] : []),
		...(descriptor.effectiveMode
			? [`Effective: ${descriptor.effectiveMode}${descriptor.outerAccess ? "+" : ""}`]
			: []),
		`Task: ${descriptor.task}`,
		...(descriptor.pendingApproval ? [`Pending approval: ${descriptor.pendingApproval}`] : []),
		...(descriptor.diagnostics ?? []).map((item) => `Diagnostic: ${item}`),
	];
	return lines.join("\n");
}

/** One-line picker label, matching the existing manager ordering. */
export function describeManagerRun(descriptor: ManagerRunDescriptor, now = Date.now()): string {
	const elapsedMs = Math.max(0, (descriptor.completedAt ?? now) - (descriptor.startedAt ?? now));
	const elapsed = Math.floor(elapsedMs / 1000);
	const state = descriptor.active ? (descriptor.state ?? "running").toUpperCase() : descriptor.failed ? "FAILED" : "COMPLETED";
	const mode = descriptor.mode?.toUpperCase() ?? "UNKNOWN";
	const clock = `${Math.floor(elapsed / 60)
		.toString()
		.padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`;
	return `${descriptor.agentName} [${descriptor.runId}]  ${state}  ${mode}  ${clock}`;
}

/** Unique labels for the manager picker plus a label -> index map. */
export function buildManagerPicker(
	descriptors: ManagerRunDescriptor[],
	now = Date.now(),
): { labels: string[]; byLabel: Map<string, number> } {
	const byLabel = new Map<string, number>();
	const labels: string[] = [];
	descriptors.forEach((descriptor, index) => {
		const base = describeManagerRun(descriptor, now);
		let label = base;
		let suffix = 2;
		while (byLabel.has(label)) {
			label = `${base} (${suffix})`;
			suffix += 1;
		}
		byLabel.set(label, index);
		labels.push(label);
	});
	return { labels, byLabel };
}

/** Structural subset of a live registry run needed to build a descriptor. */
export interface RegistryRunLike {
	runId: string;
	agentName: string;
	task: string;
	cwd: string;
	startedAt: number;
	completedAt?: number;
	dispatchId?: string;
	execution?: SubagentExecution;
	detached?: boolean;
	backend?: SubagentBackendKind;
	herdrRetention?: HerdrRetention;
	herdr?: HerdrRunLocation;
	result: {
		state?: string;
		effectiveMode?: string;
		inheritedMode?: string;
		outerAccess?: boolean;
		pendingApproval?: { method: string; title?: string };
		diagnostics?: string[];
		exitCode?: number;
		stopReason?: string;
		errorMessage?: string;
		stderr?: string;
		messages?: unknown;
	};
	child?: { pid?: number };
}

/** Structural subset of a persisted agent-log entry needed for a descriptor. */
export interface PersistedEntryLike {
	runId: string;
	agentName: string;
	task: string;
	status: string;
	execution?: SubagentExecution;
	backend?: SubagentBackendKind;
	herdrRetention?: HerdrRetention;
	herdr?: HerdrRunLocation;
	dispatchId?: string;
	startedAt?: number;
	completedAt?: number;
}

/** Build a manager descriptor from a live registry run. */
export function descriptorFromRun(run: RegistryRunLike): ManagerRunDescriptor {
	return {
		runId: run.runId,
		agentName: run.agentName,
		task: run.task,
		active: !run.completedAt,
		failed: isFailedResult(run.result),
		state: run.result.state,
		mode: run.result.effectiveMode,
		execution: run.execution,
		detached: run.detached,
		backend: run.backend,
		herdr: run.herdr,
		herdrRetention: run.herdrRetention,
		dispatchId: run.dispatchId,
		cwd: run.cwd,
		pid: run.child?.pid,
		inheritedMode: run.result.inheritedMode,
		effectiveMode: run.result.effectiveMode,
		outerAccess: run.result.outerAccess,
		pendingApproval: run.result.pendingApproval
			? `${run.result.pendingApproval.method} — ${run.result.pendingApproval.title ?? "untitled"}`
			: undefined,
		diagnostics: run.result.diagnostics,
		startedAt: run.startedAt,
		completedAt: run.completedAt,
	};
}

/** Build a manager descriptor from a persisted agent-log entry. */
export function descriptorFromEntry(entry: PersistedEntryLike): ManagerRunDescriptor {
	return {
		runId: entry.runId,
		agentName: entry.agentName,
		task: entry.task,
		active: entry.status === "running",
		failed: entry.status === "failed",
		state: entry.status,
		execution: entry.execution,
		backend: entry.backend,
		herdr: entry.herdr,
		herdrRetention: entry.herdrRetention,
		dispatchId: entry.dispatchId,
		startedAt: entry.startedAt,
		completedAt: entry.completedAt,
		persisted: true,
	};
}

/**
 * Registry descriptors plus persisted Herdr locations the registry has pruned.
 * Ordinary process runs are never added from history, so the default manager
 * list is unchanged. `dismissed` hides persisted locations the user closed or
 * found stale during this session.
 */
export function mergeManagerDescriptors(
	runs: RegistryRunLike[],
	entries: PersistedEntryLike[],
	dismissed: ReadonlySet<string> = new Set(),
): ManagerRunDescriptor[] {
	const descriptors = runs.map(descriptorFromRun);
	const known = new Set(descriptors.map((descriptor) => descriptor.runId));
	for (const entry of entries) {
		if (!entry.runId || known.has(entry.runId)) continue;
		if (!entry.herdr) continue;
		if (dismissed.has(entry.runId)) continue;
		descriptors.push(descriptorFromEntry(entry));
	}
	return descriptors;
}

/** Ownership queries the manager UI needs from the dispatch lifecycle. */
export interface DispatchOwnershipSource {
	/** True while the dispatch is still attached to its blocking tool call. */
	isAttached(dispatchId: string): boolean;
	/** True once the dispatch was detached, including after its handle is gone. */
	wasEverDetached(dispatchId: string): boolean;
}

/**
 * Overlay live lifecycle ownership onto manager descriptors.
 *
 * `attachedBlocking` enables `Continue in background`; `detached` is shown in
 * Details as background ownership. Ownership is read from the lifecycle handle
 * instead of only from runs that already existed when the detach happened, so a
 * later chain step or queued parallel sibling is classified correctly when it
 * registers after the detach.
 */
export function applyDispatchOwnership<T extends ManagerRunDescriptor>(
	descriptors: readonly T[],
	ownership: DispatchOwnershipSource,
): T[] {
	return descriptors.map((descriptor) => {
		const dispatchId = descriptor.dispatchId;
		if (!dispatchId) return descriptor;
		const attachedBlocking = ownership.isAttached(dispatchId);
		const detached = descriptor.detached === true || ownership.wasEverDetached(dispatchId);
		if (!attachedBlocking && !detached) return descriptor;
		return {
			...descriptor,
			...(attachedBlocking ? { attachedBlocking: true } : {}),
			...(detached ? { detached: true } : {}),
		};
	});
}

/** Clear only the recorded pane location; the subagent result/log is preserved. */
export function clearHerdrLocation(target: {
	herdr?: HerdrRunLocation;
	result?: { herdr?: HerdrRunLocation };
}): void {
	target.herdr = undefined;
	if (target.result) target.result.herdr = undefined;
}

/** Typed pane operations the manager needs from the tab layer. */
export interface HerdrManagerPort {
	/** Validate and focus an exact recorded pane; throws on stale/foreign panes. */
	focusLocation(location: HerdrRunLocation): Promise<void>;
	/** Close a recorded retained pane; false when it is not owned/retained. */
	closeRetainedLocation(location: HerdrRunLocation): Promise<boolean>;
	/** Live presence probe without changing focus. */
	paneStatus(location: HerdrRunLocation): Promise<ManagerPaneStatus>;
}

export interface ManagerPaneResult {
	ok: boolean;
	status: ManagerPaneStatus;
	/** Human-readable notification text. */
	message: string;
	/** The recorded location is stale and should be cleared by the caller. */
	stale: boolean;
}

/** A pane error that means the recorded pane is gone or no longer ours. */
export function isStalePaneError(error: unknown): boolean {
	if (!(error instanceof HerdrTabError)) return false;
	return (
		error.code === "missing_pane" ||
		error.code === "missing_location" ||
		error.code === "missing_tab" ||
		error.code === "not_owned"
	);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Manager-side Herdr pane operations with stale detection. Never recreates. */
export class ManagerHerdrActions {
	constructor(private readonly port: HerdrManagerPort) {}

	async jump(location: HerdrRunLocation): Promise<ManagerPaneResult> {
		try {
			await this.port.focusLocation(location);
			return {
				ok: true,
				status: location.retained ? "retained" : "active",
				message: `Focused Herdr pane ${location.paneId}.`,
				stale: false,
			};
		} catch (error) {
			if (isStalePaneError(error)) {
				return {
					ok: false,
					status: "missing",
					message: `Herdr pane ${location.paneId} is no longer available (${messageOf(error)}). Cleared the stale location.`,
					stale: true,
				};
			}
			return {
				ok: false,
				status: location.retained ? "retained" : "active",
				message: messageOf(error),
				stale: false,
			};
		}
	}

	async closeRetained(location: HerdrRunLocation): Promise<ManagerPaneResult> {
		if (!location.retained) {
			return { ok: false, status: "active", message: "Only retained Herdr panes can be closed.", stale: false };
		}
		try {
			const closed = await this.port.closeRetainedLocation(location);
			if (!closed) {
				return {
					ok: false,
					status: "retained",
					message: `Refusing to close Herdr pane ${location.paneId}: it is not owned by this parent session.`,
					stale: false,
				};
			}
			return {
				ok: true,
				status: "missing",
				message: `Closed retained Herdr pane ${location.paneId}. Subagent result and log are preserved.`,
				stale: true,
			};
		} catch (error) {
			if (isStalePaneError(error)) {
				return {
					ok: false,
					status: "missing",
					message: `Herdr pane ${location.paneId} is already gone (${messageOf(error)}). Cleared the stale location.`,
					stale: true,
				};
			}
			return {
				ok: false,
				status: "retained",
				message: messageOf(error),
				stale: false,
			};
		}
	}

	async status(location: HerdrRunLocation): Promise<ManagerPaneStatus> {
		try {
			return await this.port.paneStatus(location);
		} catch {
			return "missing";
		}
	}
}
