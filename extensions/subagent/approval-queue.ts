export interface ApprovalQueueEntry<T> {
	runId: string;
	requestId: string;
	run(signal: AbortSignal): Promise<T>;
}

type Queued<T> = ApprovalQueueEntry<T> & {
	resolve: (value: T | undefined) => void;
};

export class ApprovalQueue {
	private queue: Queued<unknown>[] = [];
	private active: { entry: Queued<unknown>; controller: AbortController } | undefined;
	private keys = new Set<string>();

	enqueue<T>(entry: ApprovalQueueEntry<T>): Promise<T | undefined> {
		const key = `${entry.runId}\0${entry.requestId}`;
		if (this.keys.has(key)) return Promise.reject(new Error(`Duplicate UI request: ${entry.requestId}`));
		this.keys.add(key);
		return new Promise<T | undefined>((resolve) => {
			this.queue.push({ ...entry, resolve } as Queued<unknown>);
			void this.drain();
		});
	}

	cancelRun(runId: string): void {
		const retained: Queued<unknown>[] = [];
		for (const entry of this.queue) {
			if (entry.runId === runId) {
				this.keys.delete(`${entry.runId}\0${entry.requestId}`);
				entry.resolve(undefined);
			} else retained.push(entry);
		}
		this.queue = retained;
		if (this.active?.entry.runId === runId) this.active.controller.abort();
	}

	private async drain(): Promise<void> {
		if (this.active) return;
		const entry = this.queue.shift();
		if (!entry) return;
		const controller = new AbortController();
		this.active = { entry, controller };
		try {
			entry.resolve(await entry.run(controller.signal));
		} catch {
			entry.resolve(undefined);
		} finally {
			this.keys.delete(`${entry.runId}\0${entry.requestId}`);
			this.active = undefined;
			void this.drain();
		}
	}
}
