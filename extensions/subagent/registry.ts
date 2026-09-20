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

export async function sendControl(run: SubagentRunRuntime, command: string, timeoutMs = 2000): Promise<void> {
	if (!run.child || run.child.exited || run.completedAt) throw new Error("Run is no longer active");
	const id = `control-${run.runId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const response = await run.child.request(
		{ id, type: "prompt", message: `/px:subagent-control ${command}` },
		timeoutMs,
	);
	if (!response.success) throw new Error(response.error);
}
