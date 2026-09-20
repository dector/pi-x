import { raceWithAbort, throwIfAborted } from "./run-stop.ts";
import type { RpcChild } from "./rpc-client.ts";
import type { SingleResult, SubagentExecution } from "./types.ts";

export interface SubagentRunRuntime {
	runId: string;
	agentName: string;
	task: string;
	cwd: string;
	startedAt: number;
	completedAt?: number;
	result: SingleResult;
	child?: RpcChild;
	/** Dispatch that owns this run; surfaced by the manager and agent log. */
	dispatchId?: string;
	/** Whether the owning dispatch runs detached or blocking. */
	execution?: SubagentExecution;
	/**
	 * Stop just this run. First call asks the child to abort cooperatively;
	 * repeating it escalates to bounded forced termination. Set by the runner
	 * so tool-level control can stop one child without cancelling its dispatch.
	 */
	abort?: () => void;
}

export class SubagentRegistry {
	private runs = new Map<string, SubagentRunRuntime>();
	constructor(
		private readonly completedLimit = 30,
		private readonly onChange?: () => void,
	) {}

	start(run: SubagentRunRuntime): void {
		this.runs.set(run.runId, run);
		this.onChange?.();
	}

	complete(runId: string): void {
		const run = this.runs.get(runId);
		if (!run || run.completedAt) return;
		run.completedAt = Date.now();
		const completed = [...this.runs.values()]
			.filter((item) => item.completedAt)
			.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
		while (completed.length > this.completedLimit) {
			const oldest = completed.shift();
			if (oldest) this.runs.delete(oldest.runId);
		}
		this.onChange?.();
	}

	get(runId: string): SubagentRunRuntime | undefined {
		return this.runs.get(runId);
	}

	list(): SubagentRunRuntime[] {
		return [...this.runs.values()].sort((a, b) => {
			if (!a.completedAt && b.completedAt) return -1;
			if (a.completedAt && !b.completedAt) return 1;
			return b.startedAt - a.startedAt;
		});
	}
}

/** Optional cancellation and deadline for a child control RPC. */
export interface ChildControlOptions {
	/** Parent tool-call signal; aborts the wait without waiting for the deadline. */
	signal?: AbortSignal;
	/** RPC deadline in milliseconds. */
	timeoutMs?: number;
}

function assertRunActive(run: SubagentRunRuntime): RpcChild {
	if (!run.child || run.child.exited || run.completedAt) throw new Error("Run is no longer active");
	return run.child;
}

export async function sendControl(run: SubagentRunRuntime, command: string, options: number | ChildControlOptions = 2000): Promise<void> {
	const { signal, timeoutMs = 2000 } = typeof options === "number" ? { signal: undefined, timeoutMs: options } : options;
	const child = assertRunActive(run);
	throwIfAborted(signal);
	const id = `control-${run.runId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const response = await raceWithAbort(
		child.request({ id, type: "prompt", message: `/px:subagent-control ${command}` }, timeoutMs),
		signal,
	);
	if (!response.success) throw new Error(response.error);
}

/**
 * Deliver a steering message to one running child over the native RPC `steer`
 * command. Throws when the child is gone, the parent signal aborts, or the
 * child rejects the message, so the caller can report a precise per-run
 * failure. The RPC deadline is independent of the abort signal.
 */
export async function sendSteer(
	run: SubagentRunRuntime,
	message: string,
	options: number | ChildControlOptions = 5000,
): Promise<void> {
	const { signal, timeoutMs = 5000 } = typeof options === "number" ? { signal: undefined, timeoutMs: options } : options;
	const child = assertRunActive(run);
	throwIfAborted(signal);
	const id = `steer-${run.runId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const response = await raceWithAbort(child.request({ id, type: "steer", message }, timeoutMs), signal);
	if (!response.success) throw new Error(response.error);
}
