export const PROC_STOP_ALL_REQUEST_EVENT = "px:proc:stop-all:request";
export const PROC_STOP_ALL_REPLY_EVENT = "px:proc:stop-all:reply";

export const PROC_STOP_ALL_MAX_WAIT_MS = 4_000;
const MAX_REQUEST_ID_LENGTH = 128;

export interface ProcStopAllRequest {
	id: string;
}

export interface ManagedProcessRef {
	name: string;
	state: string;
}

export interface ProcStopAllResult {
	id: string;
	stopped: string[];
	timedOut: string[];
}

/** Accept only correlated requests with a bounded, non-empty identifier. */
export function validateProcStopAllRequest(value: unknown): ProcStopAllRequest | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const request = value as Record<string, unknown>;
	if (Object.keys(request).length !== 1 || typeof request.id !== "string") return undefined;
	if (request.id.length === 0 || request.id.length > MAX_REQUEST_ID_LENGTH) return undefined;
	return { id: request.id };
}

/**
 * Stop the running snapshot and settle within the supplied bounded interval.
 * Records already `stopping` are waited for and reported (they are neither
 * re-signalled nor silently treated as clean).
 */
export async function stopAllRunningProcesses<T extends ManagedProcessRef>(
	records: readonly T[],
	stop: (record: T) => void,
	waitForExit: (record: T) => Promise<void>,
	timeoutMs = PROC_STOP_ALL_MAX_WAIT_MS,
): Promise<Omit<ProcStopAllResult, "id">> {
	const affected = records.filter((record) => record.state === "running" || record.state === "stopping");
	for (const record of affected.filter((record) => record.state === "running")) {
		try {
			stop(record);
		} catch {
			// A concurrent exit may win between snapshot and signal. Settlement below
			// reports the final observed state, not an assumed successful signal.
		}
	}
	if (affected.length > 0) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.all(affected.map((record) => waitForExit(record))).then(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, Math.max(0, Math.min(timeoutMs, PROC_STOP_ALL_MAX_WAIT_MS)));
			}),
		]);
		if (timer) clearTimeout(timer);
	}
	return {
		stopped: affected.filter((record) => record.state === "exited").map((record) => record.name),
		timedOut: affected.filter((record) => record.state !== "exited").map((record) => record.name),
	};
}
