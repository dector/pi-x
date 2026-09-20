/**
 * Unique subagent run IDs.
 *
 * `/px:agent:log` dedupes live registry runs against persisted tool results by
 * `runId`. A counter-only ID (`sa-1`, `sa-2`, ...) resets on every extension
 * reload, new session, or process restart, so a fresh run reused an old ID and
 * silently shadowed (dropped) the persisted run. IDs therefore embed a
 * timestamp and a random suffix, which stay unique across those restarts.
 *
 * Format: `sa-<base36 time>-<base36 counter>-<random>`.
 */

export function createRunIdGenerator(prefix = "sa"): () => string {
	let counter = 0;
	return () => {
		counter += 1;
		const time = Date.now().toString(36);
		const sequence = counter.toString(36);
		const random = Math.random().toString(36).slice(2, 10);
		return `${prefix}-${time}-${sequence}-${random}`;
	};
}
