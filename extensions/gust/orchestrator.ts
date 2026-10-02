/**
 * Deterministic Gust orchestrator.
 *
 * Watches Gust for thread changes and runs one worker per actionable thread,
 * strictly serially. It owns the receive loop; each worker owns its thread's
 * reply and review. The orchestrator never edits files and never resolves a
 * thread.
 *
 * Flow:
 *   1. `gust ctl comments watch --since <cursor>` blocks until a thread changes.
 *   2. Reconciled submitted threads are queued (seen threads on the first pass,
 *      for recovery).
 *   3. Each queued thread is claimed with `comments seen` and handed to its
 *      worker session.
 *   4. The next watch cycle observes the resulting review/done state.
 */

import type { GustClient, WatchSnapshot } from "./gust.ts";
import type { Thread, ThreadState } from "./types.ts";
import { runWorker } from "./worker.ts";
import { appendActivity, type ThreadActivity, type WorkerActivity } from "./activity.ts";
import type { WorkerModel } from "./models.ts";

/** Run one worker turn; injectable so the loop is testable. */
export type WorkerDispatch = (options: {
	thread: Thread;
	root: string;
	invocationHint: string;
	socketHint: string;
	signal: AbortSignal;
	onActivity?: (activity: WorkerActivity) => void;
	model?: WorkerModel;
}) => Promise<{ code: number }>;

export interface OrchestratorThread {
	id: string;
	state: ThreadState;
	path: string;
	note?: string;
}

export interface OrchestratorStatus {
	running: boolean;
	started: boolean;
	phase: string;
	active: string | null;
	processed: number;
	failed: number;
	resolved: number;
	lastError?: string;
	threads: OrchestratorThread[];
}

const STATE_ORDER: Record<ThreadState, number> = {
	submitted: 0,
	seen: 1,
	review: 2,
	created: 3,
	done: 4,
};

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export class Orchestrator {
	private abort = new AbortController();
	private running = false;
	private started = false;
	private phase = "idle";
	private active: string | null = null;
	private cursor = 0;
	private processed = 0;
	private failed = 0;
	private lastError: string | undefined;
	private recovered = false;
	private queue: string[] = [];
	private threads = new Map<string, Thread>();
	private notes = new Map<string, string>();
	private histories = new Map<string, ThreadActivity>();
	private listeners = new Set<() => void>();
	private loop: Promise<void> | undefined;

	constructor(
		private readonly root: string,
		private readonly client: GustClient,
		private readonly dispatch: WorkerDispatch = runWorker,
		private readonly modelForThread?: (threadId: string) => WorkerModel | undefined,
	) {}

	/** Subscribe to state changes; returns an unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A listener must not break the orchestration loop.
			}
		}
	}

	/** Load the monitor list without starting workers. Retain threads with activity. */
	async loadThreads(): Promise<void> {
		const threads = await this.client.listThreads();
		for (const id of this.threads.keys()) {
			if (!this.histories.has(id) && id !== this.active) this.threads.delete(id);
		}
		this.record(threads);
	}

	monitorThreads(): Thread[] {
		return [...this.threads.values()];
	}

	activity(id: string): ThreadActivity {
		const history = this.histories.get(id);
		return history ? { state: history.state, entries: history.entries.map((entry) => ({ ...entry })) } : { state: "idle", entries: [] };
	}

	private addActivity(id: string, activity: WorkerActivity): void {
		const history = this.histories.get(id);
		if (!history) return;
		appendActivity(history, activity);
		this.emit();
	}

	isRunning(): boolean {
		return this.running;
	}

	status(): OrchestratorStatus {
		const items = [...this.threads.values()]
			.filter((t) => t.state !== "done")
			.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.updatedAt.localeCompare(a.updatedAt))
			.map<OrchestratorThread>((t) => ({ id: t.id, state: t.state, path: t.path, note: this.notes.get(t.id) }));
		return {
			running: this.running,
			started: this.started,
			phase: this.phase,
			active: this.active,
			processed: this.processed,
			failed: this.failed,
			resolved: [...this.threads.values()].filter((t) => t.state === "done").length,
			lastError: this.lastError,
			threads: items,
		};
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.started = true;
		this.abort = new AbortController();
		this.phase = "watching";
		this.lastError = undefined;
		this.emit();
		this.loop = this.run();
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.phase = "stopping";
		this.emit();
		this.abort.abort();
		await this.loop?.catch(() => {});
		this.loop = undefined;
		this.active = null;
		this.phase = "stopped";
		this.emit();
	}

	private async run(): Promise<void> {
		while (this.running) {
			let snapshot: WatchSnapshot;
			try {
				snapshot = await this.client.watch(this.cursor, this.abort.signal);
			} catch (error) {
				if (!this.running) break;
				this.lastError = message(error);
				this.phase = "gust unreachable";
				this.emit();
				await delay(2000, this.abort.signal);
				continue;
			}
			this.cursor = snapshot.cursor;
			this.phase = "watching";
			this.record(snapshot.comments);
			this.enqueue(snapshot.comments, !this.recovered);
			this.recovered = true;
			await this.drain();
		}
	}

	private record(comments: Thread[]): void {
		for (const comment of comments) {
			this.threads.set(comment.id, comment);
		}
		this.emit();
	}

	private enqueue(comments: Thread[], recover: boolean): void {
		for (const comment of comments) {
			const actionable = comment.state === "submitted" || (recover && comment.state === "seen");
			if (!actionable) continue;
			if (this.active === comment.id || this.queue.includes(comment.id)) continue;
			this.queue.push(comment.id);
		}
	}

	private async drain(): Promise<void> {
		while (this.running && this.queue.length > 0) {
			const id = this.queue.shift() as string;
			this.active = id;
			this.phase = "working";
			this.emit();
			const history = this.histories.get(id) ?? { state: "idle", entries: [] } as ThreadActivity;
			history.state = "running";
			this.histories.set(id, history);
			try {
				const thread = await this.client.seen(id);
				this.threads.set(id, thread);
				this.phase = "worker";
				this.emit();
				const model = this.modelForThread?.(id);
				const result = await this.dispatch({
					thread,
					model,
					root: this.root,
					invocationHint: this.client.invocationLabel(),
					socketHint: this.client.socketLabel(),
					signal: this.abort.signal,
					onActivity: (activity) => this.addActivity(id, activity),
				});
				if (!this.running) break;
				history.state = result.code === 0 ? "completed" : "failed";
				if (result.code === 0) {
					this.processed += 1;
					this.notes.set(id, "worker finished");
				} else {
					this.failed += 1;
					this.lastError = `worker exited ${result.code}`;
					this.notes.set(id, this.lastError);
					this.addActivity(id, { kind: "error", text: this.lastError });
				}
			} catch (error) {
				if (!this.running) break;
				history.state = "failed";
				this.failed += 1;
				this.lastError = message(error);
				this.addActivity(id, { kind: "error", text: this.lastError });
				this.notes.set(id, this.lastError);
			} finally {
				if (!this.running) history.state = "stopped";
				this.active = null;
				this.emit();
			}
		}
		if (this.running) {
			this.phase = "watching";
			this.emit();
		}
	}
}
