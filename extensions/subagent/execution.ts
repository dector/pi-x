export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

export function interpolatePrevious(task: string, previous: string): string {
	return task.replace(/\{previous\}/g, previous);
}

/**
 * Combine optional abort signals into one. Returns `undefined` when no signal
 * is present. Prefers `AbortSignal.any` and falls back to a manual controller so
 * the module stays usable on runtimes without it.
 */
export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (present.length === 0) return undefined;
	if (present.length === 1) return present[0];
	if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
	const controller = new AbortController();
	for (const signal of present) {
		if (signal.aborted) {
			controller.abort();
			break;
		}
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
	return controller.signal;
}
