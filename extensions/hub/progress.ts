/**
 * Pure semantic-progress registry for the hub extension.
 *
 * Producers own a tracker identified by `owner + trackerId` and guarded by an
 * opaque `trackerToken`. The registry stores full records (including chunk
 * labels, details, outcomes, and timestamps) but publishes lightweight,
 * deep-detached snapshots that contain active (unfinished) trackers only.
 *
 * This module holds no Pi runtime state and imports only `./contract`, so it is
 * safe to unit test with `bun test`. Protocol acknowledgements, event emission,
 * and the child relay are deliberately kept outside this file.
 */

import {
	PROGRESS_CHUNK_STATES,
	PROGRESS_OUTCOMES,
	type ProgressAckError,
	type ProgressChunkDefinition,
	type ProgressChunkSnapshot,
	type ProgressChunkState,
	type ProgressCreatePayload,
	type ProgressFinishPayload,
	type ProgressOutcome,
	type ProgressQueryPayload,
	type ProgressRemovePayload,
	type ProgressSnapshot,
	type ProgressTrackerSnapshot,
	type ProgressUpdatePayload,
} from "./contract";

// ---------------------------------------------------------------------------
// Bounds (section 7.6 of idea-progress.md)
// ---------------------------------------------------------------------------

export const MAX_ACTIVE_PROGRESS_TRACKERS = 8;
export const MAX_FINISHED_PROGRESS_TRACKERS = 16;
export const MAX_PROGRESS_CHUNKS = 100;
export const MAX_PROGRESS_REQUEST_ID_LENGTH = 128;
export const MAX_PROGRESS_OWNER_LENGTH = 128;
export const MAX_PROGRESS_TRACKER_ID_LENGTH = 128;
export const MAX_PROGRESS_TRACKER_TOKEN_LENGTH = 128;
export const MAX_PROGRESS_CHUNK_ID_LENGTH = 128;
export const MAX_PROGRESS_TITLE_LENGTH = 200;
export const MAX_PROGRESS_UNIT_LENGTH = 40;
export const MAX_PROGRESS_LABEL_LENGTH = 200;
export const MAX_PROGRESS_PHASE_LENGTH = 80;
export const MAX_PROGRESS_DETAIL_LENGTH = 500;
export const MAX_PROGRESS_SUMMARY_LENGTH = 500;
export const MAX_PROGRESS_RELAY_BYTES = 256 * 1024;

/** Default display noun when a create omits `unit`. */
export const DEFAULT_PROGRESS_UNIT = "Item";

// ---------------------------------------------------------------------------
// Stored record shapes (section 5.3)
// ---------------------------------------------------------------------------

export interface ProgressChunkRecord {
	id: string;
	index: number;
	label?: string;
	parentId?: string;
	childUnit?: string;
	state: ProgressChunkState;
	phase?: string;
	detail?: string;
	updatedAt: number;
}

export interface ProgressTrackerRecord {
	trackerId: string;
	trackerToken: string;
	owner: string;
	title: string;
	unit: string;
	chunks: ProgressChunkRecord[];
	outcome?: ProgressOutcome;
	summary?: string;
	createdAt: number;
	updatedAt: number;
	finishedAt?: number;
}

// ---------------------------------------------------------------------------
// Enum guards
// ---------------------------------------------------------------------------

export function isProgressChunkState(value: unknown): value is ProgressChunkState {
	return typeof value === "string" && (PROGRESS_CHUNK_STATES as readonly string[]).includes(value);
}

export function isProgressOutcome(value: unknown): value is ProgressOutcome {
	return typeof value === "string" && (PROGRESS_OUTCOMES as readonly string[]).includes(value);
}

/** Terminal chunk states accept no further mutation. */
export function isTerminalProgressChunkState(state: ProgressChunkState): boolean {
	return state === "done" || state === "failed" || state === "skipped";
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty string within the given limit, or `undefined`. */
function requiredString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
	return value;
}

/** Optional display string within the given limit; empty strings are valid. */
function boundedString(value: unknown, maxLength: number): string | undefined | null {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > maxLength) return null;
	return value;
}

/**
 * Validate a `hub:progress:create` payload. Returns `undefined` for malformed
 * input (non-record, missing/empty/oversized identity fields, an empty or
 * oversized chunk list, duplicate chunk IDs, or oversized display fields) so
 * callers can drop it without acknowledging.
 */
export function parseProgressCreate(payload: unknown): ProgressCreatePayload | undefined {
	if (!isRecord(payload)) return undefined;

	const requestId = requiredString(payload.requestId, MAX_PROGRESS_REQUEST_ID_LENGTH);
	const trackerId = requiredString(payload.trackerId, MAX_PROGRESS_TRACKER_ID_LENGTH);
	const trackerToken = requiredString(payload.trackerToken, MAX_PROGRESS_TRACKER_TOKEN_LENGTH);
	const owner = requiredString(payload.owner, MAX_PROGRESS_OWNER_LENGTH);
	const title = requiredString(payload.title, MAX_PROGRESS_TITLE_LENGTH);
	if (!requestId || !trackerId || !trackerToken || !owner || !title) return undefined;

	const unit = boundedString(payload.unit, MAX_PROGRESS_UNIT_LENGTH);
	if (unit === null) return undefined;

	if (!Array.isArray(payload.chunks)) return undefined;
	if (payload.chunks.length === 0 || payload.chunks.length > MAX_PROGRESS_CHUNKS) return undefined;

	const chunks: ProgressChunkDefinition[] = [];
	const seen = new Set<string>();
	for (const raw of payload.chunks) {
		if (!isRecord(raw)) return undefined;
		const id = requiredString(raw.id, MAX_PROGRESS_CHUNK_ID_LENGTH);
		if (!id || seen.has(id)) return undefined;

		const label = boundedString(raw.label, MAX_PROGRESS_LABEL_LENGTH);
		const parentId = boundedString(raw.parentId, MAX_PROGRESS_CHUNK_ID_LENGTH);
		const childUnit = boundedString(raw.childUnit, MAX_PROGRESS_UNIT_LENGTH);
		if (label === null || parentId === null || childUnit === null) return undefined;
		if (parentId !== undefined && (!parentId || !seen.has(parentId))) return undefined;

		const chunk: ProgressChunkDefinition = { id };
		if (label !== undefined) chunk.label = label;
		if (parentId !== undefined) chunk.parentId = parentId;
		if (childUnit !== undefined) chunk.childUnit = childUnit;
		chunks.push(chunk);
		seen.add(id);
	}

	return { requestId, trackerId, trackerToken, owner, title, unit, chunks };
}

/** Validate a `hub:progress:update` payload. Returns `undefined` when malformed. */
export function parseProgressUpdate(payload: unknown): ProgressUpdatePayload | undefined {
	if (!isRecord(payload)) return undefined;

	const requestId = requiredString(payload.requestId, MAX_PROGRESS_REQUEST_ID_LENGTH);
	const trackerId = requiredString(payload.trackerId, MAX_PROGRESS_TRACKER_ID_LENGTH);
	const trackerToken = requiredString(payload.trackerToken, MAX_PROGRESS_TRACKER_TOKEN_LENGTH);
	const owner = requiredString(payload.owner, MAX_PROGRESS_OWNER_LENGTH);
	const chunkId = requiredString(payload.chunkId, MAX_PROGRESS_CHUNK_ID_LENGTH);
	if (!requestId || !trackerId || !trackerToken || !owner || !chunkId) return undefined;

	if (!isProgressChunkState(payload.state)) return undefined;

	const phase = boundedString(payload.phase, MAX_PROGRESS_PHASE_LENGTH);
	if (phase === null) return undefined;
	const detail = boundedString(payload.detail, MAX_PROGRESS_DETAIL_LENGTH);
	if (detail === null) return undefined;

	return { requestId, trackerId, trackerToken, owner, chunkId, state: payload.state, phase, detail };
}

/** Validate a `hub:progress:finish` payload. Returns `undefined` when malformed. */
export function parseProgressFinish(payload: unknown): ProgressFinishPayload | undefined {
	if (!isRecord(payload)) return undefined;

	const requestId = requiredString(payload.requestId, MAX_PROGRESS_REQUEST_ID_LENGTH);
	const trackerId = requiredString(payload.trackerId, MAX_PROGRESS_TRACKER_ID_LENGTH);
	const trackerToken = requiredString(payload.trackerToken, MAX_PROGRESS_TRACKER_TOKEN_LENGTH);
	const owner = requiredString(payload.owner, MAX_PROGRESS_OWNER_LENGTH);
	if (!requestId || !trackerId || !trackerToken || !owner) return undefined;

	if (!isProgressOutcome(payload.outcome)) return undefined;

	const summary = boundedString(payload.summary, MAX_PROGRESS_SUMMARY_LENGTH);
	if (summary === null) return undefined;

	return { requestId, trackerId, trackerToken, owner, outcome: payload.outcome, summary };
}

/** Validate a `hub:progress:remove` payload. Returns `undefined` when malformed. */
export function parseProgressRemove(payload: unknown): ProgressRemovePayload | undefined {
	if (!isRecord(payload)) return undefined;

	const requestId = requiredString(payload.requestId, MAX_PROGRESS_REQUEST_ID_LENGTH);
	const trackerId = requiredString(payload.trackerId, MAX_PROGRESS_TRACKER_ID_LENGTH);
	const trackerToken = requiredString(payload.trackerToken, MAX_PROGRESS_TRACKER_TOKEN_LENGTH);
	const owner = requiredString(payload.owner, MAX_PROGRESS_OWNER_LENGTH);
	if (!requestId || !trackerId || !trackerToken || !owner) return undefined;

	return { requestId, trackerId, trackerToken, owner };
}

/** Validate a `hub:progress:query` payload. Returns `undefined` when malformed. */
export function parseProgressQuery(payload: unknown): ProgressQueryPayload | undefined {
	if (!isRecord(payload)) return undefined;

	const requestId = requiredString(payload.requestId, MAX_PROGRESS_REQUEST_ID_LENGTH);
	if (!requestId) return undefined;

	return { requestId };
}

// ---------------------------------------------------------------------------
// Registry result
// ---------------------------------------------------------------------------

/**
 * Result of applying one registry operation.
 *
 * `changed` describes a mutation of the full registry record/history;
 * `snapshotChanged` describes a change to the lightweight active snapshot that
 * observers receive. A cleared finished record changes the registry but not the
 * snapshot, so callers emit `changed` only when `snapshotChanged` is true.
 *
 * Malformed payloads return `undefined` from the operation instead of a result,
 * because they receive no acknowledgement at all.
 */
export interface ProgressRegistryResult {
	ok: boolean;
	changed: boolean;
	snapshotChanged: boolean;
	error?: ProgressAckError;
	snapshot: ProgressSnapshot;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compareSnapshots(a: ProgressTrackerSnapshot, b: ProgressTrackerSnapshot): number {
	if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
	if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1;
	if (a.trackerId !== b.trackerId) return a.trackerId < b.trackerId ? -1 : 1;
	return 0;
}

function compareRecords(a: ProgressTrackerRecord, b: ProgressTrackerRecord): number {
	if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
	if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1;
	if (a.trackerId !== b.trackerId) return a.trackerId < b.trackerId ? -1 : 1;
	return 0;
}

function snapshotsEqual(a: ProgressSnapshot, b: ProgressSnapshot): boolean {
	if (a.active !== b.active || a.count !== b.count) return false;
	if (a.trackers.length !== b.trackers.length) return false;

	for (let i = 0; i < a.trackers.length; i++) {
		const left = a.trackers[i]!;
		const right = b.trackers[i]!;
		if (
			left.trackerId !== right.trackerId ||
			left.owner !== right.owner ||
			left.title !== right.title ||
			left.unit !== right.unit ||
			left.updatedAt !== right.updatedAt
		) {
			return false;
		}
		if (left.chunks.length !== right.chunks.length) return false;

		for (let j = 0; j < left.chunks.length; j++) {
			const lc = left.chunks[j]!;
			const rc = right.chunks[j]!;
			if (
				lc.index !== rc.index ||
				lc.state !== rc.state ||
				lc.label !== rc.label ||
				lc.phase !== rc.phase ||
				JSON.stringify(lc.path) !== JSON.stringify(rc.path)
			) return false;
		}
	}

	return true;
}

function cloneChunk(chunk: ProgressChunkRecord): ProgressChunkRecord {
	const clone: ProgressChunkRecord = {
		id: chunk.id,
		index: chunk.index,
		state: chunk.state,
		updatedAt: chunk.updatedAt,
	};
	if (chunk.label !== undefined) clone.label = chunk.label;
	if (chunk.parentId !== undefined) clone.parentId = chunk.parentId;
	if (chunk.childUnit !== undefined) clone.childUnit = chunk.childUnit;
	if (chunk.phase !== undefined) clone.phase = chunk.phase;
	if (chunk.detail !== undefined) clone.detail = chunk.detail;
	return clone;
}

function sameCreateDefinition(record: ProgressTrackerRecord, payload: ProgressCreatePayload): boolean {
	if (record.title !== payload.title) return false;
	// An empty display noun is treated as absent (section 7.2), matching create.
	if (record.unit !== (payload.unit || DEFAULT_PROGRESS_UNIT)) return false;
	if (record.chunks.length !== payload.chunks.length) return false;

	for (let i = 0; i < record.chunks.length; i++) {
		const existing = record.chunks[i]!;
		const incoming = payload.chunks[i]!;
		if (existing.id !== incoming.id) return false;
		if (existing.label !== incoming.label) return false;
		if (existing.parentId !== incoming.parentId) return false;
		if (existing.childUnit !== incoming.childUnit) return false;
	}

	return true;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * In-memory registry of progress trackers.
 *
 * Not a singleton: hub owns one instance and resets it on session shutdown.
 * Every mutation accepts `unknown` and parses at the boundary, so a malformed
 * event returns `undefined` (no ack) and leaves the registry untouched.
 */
export class ProgressRegistry {
	private readonly byOwner = new Map<string, Map<string, ProgressTrackerRecord>>();
	private readonly finishedOrder: Array<{ owner: string; trackerId: string }> = [];
	private readonly clock: () => number;

	constructor(clock: () => number = () => Date.now()) {
		this.clock = clock;
	}

	// -- mutations ------------------------------------------------------------

	/** Create a tracker. Returns `undefined` when the payload is malformed. */
	create(payload: unknown): ProgressRegistryResult | undefined {
		const parsed = parseProgressCreate(payload);
		if (!parsed) return undefined;

		const previous = this.snapshot();
		const existing = this.find(parsed.owner, parsed.trackerId);
		if (existing) {
			const sameToken = existing.trackerToken === parsed.trackerToken;
			if (!sameToken || !sameCreateDefinition(existing, parsed)) {
				return this.result(previous, false, "already-exists");
			}
			return this.result(previous, false);
		}

		if (this.activeCountInternal() >= MAX_ACTIVE_PROGRESS_TRACKERS) {
			return this.result(previous, false, "limit-exceeded");
		}

		const now = this.clock();
		const record: ProgressTrackerRecord = {
			trackerId: parsed.trackerId,
			trackerToken: parsed.trackerToken,
			owner: parsed.owner,
			title: parsed.title,
			// Treat an empty unit as absent so the observer snapshot always carries
			// the default display noun; the status-bar rejects an empty `unit`.
			unit: parsed.unit || DEFAULT_PROGRESS_UNIT,
			chunks: parsed.chunks.map((chunk, i) => {
				const stored: ProgressChunkRecord = { id: chunk.id, index: i + 1, state: "pending", updatedAt: now };
				if (chunk.label !== undefined) stored.label = chunk.label;
				if (chunk.parentId !== undefined) stored.parentId = chunk.parentId;
				if (chunk.childUnit !== undefined) stored.childUnit = chunk.childUnit;
				return stored;
			}),
			createdAt: now,
			updatedAt: now,
		};
		this.setRecord(record);

		return this.result(previous, true);
	}

	/** Replace one chunk's reported state/metadata. Returns `undefined` when malformed. */
	update(payload: unknown): ProgressRegistryResult | undefined {
		const parsed = parseProgressUpdate(payload);
		if (!parsed) return undefined;

		const previous = this.snapshot();
		const record = this.find(parsed.owner, parsed.trackerId);
		if (!record) return this.result(previous, false, "not-found");
		if (record.trackerToken !== parsed.trackerToken) return this.result(previous, false, "stale-tracker");
		if (record.outcome !== undefined) return this.result(previous, false, "tracker-finished");

		const chunk = record.chunks.find((entry) => entry.id === parsed.chunkId);
		if (!chunk) return this.result(previous, false, "not-found");
		if (record.chunks.some((entry) => entry.parentId === chunk.id)) {
			return this.result(previous, false, "not-leaf");
		}

		const nextPhase = parsed.phase;
		const nextDetail = parsed.detail;

		// A non-empty phase is only meaningful while the chunk is active. This
		// keeps `blocked` always rendering as blocked.
		if (nextPhase !== undefined && nextPhase.length > 0 && parsed.state !== "active") {
			return this.result(previous, false, "invalid-transition");
		}

		if (isTerminalProgressChunkState(chunk.state)) {
			const identical =
				chunk.state === parsed.state &&
				(chunk.phase ?? undefined) === nextPhase &&
				(chunk.detail ?? undefined) === nextDetail;
			if (identical) return this.result(previous, false);
			return this.result(previous, false, "chunk-terminal");
		}

		const changed =
			chunk.state !== parsed.state ||
			(chunk.phase ?? undefined) !== nextPhase ||
			(chunk.detail ?? undefined) !== nextDetail;
		if (!changed) return this.result(previous, false);

		const now = this.clock();
		chunk.state = parsed.state;
		if (nextPhase === undefined) delete chunk.phase;
		else chunk.phase = nextPhase;
		if (nextDetail === undefined) delete chunk.detail;
		else chunk.detail = nextDetail;
		chunk.updatedAt = now;
		record.updatedAt = now;

		return this.result(previous, true);
	}

	/** Finish a tracker and freeze it. Returns `undefined` when malformed. */
	finish(payload: unknown): ProgressRegistryResult | undefined {
		const parsed = parseProgressFinish(payload);
		if (!parsed) return undefined;

		const previous = this.snapshot();
		const record = this.find(parsed.owner, parsed.trackerId);
		if (!record) return this.result(previous, false, "not-found");
		if (record.trackerToken !== parsed.trackerToken) return this.result(previous, false, "stale-tracker");

		const nextSummary = parsed.summary;
		if (record.outcome !== undefined) {
			const identical = record.outcome === parsed.outcome && (record.summary ?? undefined) === nextSummary;
			if (identical) return this.result(previous, false);
			return this.result(previous, false, "conflict");
		}

		if (
			parsed.outcome === "completed" &&
			!this.leaves(record).every((chunk) => chunk.state === "done" || chunk.state === "skipped")
		) {
			return this.result(previous, false, "incomplete");
		}

		const now = this.clock();
		record.outcome = parsed.outcome;
		if (nextSummary === undefined) delete record.summary;
		else record.summary = nextSummary;
		record.finishedAt = now;
		record.updatedAt = now;

		this.finishedOrder.push({ owner: record.owner, trackerId: record.trackerId });
		this.evictFinished();

		return this.result(previous, true);
	}

	/** Remove the exact tracker incarnation. Returns `undefined` when malformed. */
	remove(payload: unknown): ProgressRegistryResult | undefined {
		const parsed = parseProgressRemove(payload);
		if (!parsed) return undefined;

		const previous = this.snapshot();
		const record = this.find(parsed.owner, parsed.trackerId);
		if (!record) return this.result(previous, false);
		if (record.trackerToken !== parsed.trackerToken) return this.result(previous, false, "stale-tracker");

		this.deleteRecord(parsed.owner, parsed.trackerId);
		return this.result(previous, true);
	}

	/** Drop every tracker. Session shutdown calls this; it is also safe anytime. */
	reset(): ProgressRegistryResult {
		const previous = this.snapshot();
		const changed = this.byOwner.size > 0;
		this.byOwner.clear();
		this.finishedOrder.length = 0;
		return this.result(previous, changed);
	}

	/** Return the current detached snapshot when the query payload is valid. */
	query(payload: unknown): ProgressSnapshot | undefined {
		const parsed = parseProgressQuery(payload);
		if (!parsed) return undefined;
		return this.snapshot();
	}

	// -- reads ----------------------------------------------------------------

	/** Total number of unfinished trackers. */
	activeCount(): number {
		return this.activeCountInternal();
	}

	/** Number of retained finished records (bounded history). */
	finishedCount(): number {
		return this.finishedOrder.length;
	}

	/** Deep copy of one full record, addressed by owner then tracker ID. */
	get(owner: string, trackerId: string): ProgressTrackerRecord | undefined {
		const record = this.find(owner, trackerId);
		return record ? this.cloneRecord(record) : undefined;
	}

	/**
	 * Deep copies of every retained record (active and finished), ordered by
	 * `updatedAt` descending with `owner`/`trackerId` as deterministic
	 * tie-breakers. Callers may mutate the result without touching the registry.
	 */
	list(): ProgressTrackerRecord[] {
		const records: ProgressTrackerRecord[] = [];
		for (const byId of this.byOwner.values()) {
			for (const record of byId.values()) records.push(this.cloneRecord(record));
		}
		records.sort(compareRecords);
		return records;
	}

	/**
	 * Deep-detached aggregate snapshot of active trackers only. Chunks are the
	 * immutable leaf projection; hierarchical leaves also carry a root-to-leaf path.
	 */
	snapshot(): ProgressSnapshot {
		const trackers: ProgressTrackerSnapshot[] = [];
		for (const byId of this.byOwner.values()) {
			for (const record of byId.values()) {
				if (record.outcome !== undefined) continue;
				const hierarchical = record.chunks.some((chunk) => chunk.parentId !== undefined);
				const leaves = this.leaves(record);
				trackers.push({
					trackerId: record.trackerId,
					owner: record.owner,
					title: record.title,
					unit: record.unit,
					chunks: leaves.map((chunk, index) => {
						const copy: ProgressChunkSnapshot = { index: index + 1, state: chunk.state };
						if (chunk.label !== undefined) copy.label = chunk.label;
						if (hierarchical) copy.path = this.chunkPath(record, chunk);
						if (chunk.phase !== undefined) copy.phase = chunk.phase;
						return copy;
					}),
					updatedAt: record.updatedAt,
				});
			}
		}
		trackers.sort(compareSnapshots);

		return { active: trackers.length > 0, count: trackers.length, trackers };
	}

	// -- internals ------------------------------------------------------------

	private leaves(record: ProgressTrackerRecord): ProgressChunkRecord[] {
		const parents = new Set(record.chunks.flatMap((chunk) => chunk.parentId ? [chunk.parentId] : []));
		return record.chunks.filter((chunk) => !parents.has(chunk.id));
	}

	private chunkPath(record: ProgressTrackerRecord, leaf: ProgressChunkRecord): ProgressChunkSnapshot["path"] {
		const byId = new Map(record.chunks.map((chunk) => [chunk.id, chunk]));
		const nodes: ProgressChunkRecord[] = [];
		let current: ProgressChunkRecord | undefined = leaf;
		while (current) {
			nodes.unshift(current);
			current = current.parentId === undefined ? undefined : byId.get(current.parentId);
		}

		return nodes.map((node, depth) => {
			const parent = depth === 0 ? undefined : nodes[depth - 1];
			const siblings = record.chunks.filter((candidate) => candidate.parentId === parent?.id);
			const segment = {
				index: siblings.findIndex((candidate) => candidate.id === node.id) + 1,
				total: siblings.length,
				unit: depth === 0 ? record.unit : parent?.childUnit || DEFAULT_PROGRESS_UNIT,
			};
			return node.label === undefined ? segment : { ...segment, label: node.label };
		});
	}

	private find(owner: string, trackerId: string): ProgressTrackerRecord | undefined {
		return this.byOwner.get(owner)?.get(trackerId);
	}

	private setRecord(record: ProgressTrackerRecord): void {
		const byId = this.byOwner.get(record.owner) ?? new Map<string, ProgressTrackerRecord>();
		byId.set(record.trackerId, record);
		this.byOwner.set(record.owner, byId);
	}

	private deleteRecord(owner: string, trackerId: string): void {
		const byId = this.byOwner.get(owner);
		if (!byId) return;
		byId.delete(trackerId);
		if (byId.size === 0) this.byOwner.delete(owner);

		for (let i = this.finishedOrder.length - 1; i >= 0; i--) {
			const entry = this.finishedOrder[i]!;
			if (entry.owner === owner && entry.trackerId === trackerId) this.finishedOrder.splice(i, 1);
		}
	}

	private activeCountInternal(): number {
		let total = 0;
		for (const byId of this.byOwner.values()) {
			for (const record of byId.values()) {
				if (record.outcome === undefined) total++;
			}
		}
		return total;
	}

	/** Evict only the oldest finished record; active trackers are never evicted. */
	private evictFinished(): void {
		while (this.finishedOrder.length > MAX_FINISHED_PROGRESS_TRACKERS) {
			const oldest = this.finishedOrder.shift();
			if (!oldest) break;
			const record = this.find(oldest.owner, oldest.trackerId);
			if (!record || record.outcome === undefined) continue;
			this.deleteRecord(oldest.owner, oldest.trackerId);
		}
	}

	private cloneRecord(record: ProgressTrackerRecord): ProgressTrackerRecord {
		const clone: ProgressTrackerRecord = {
			trackerId: record.trackerId,
			trackerToken: record.trackerToken,
			owner: record.owner,
			title: record.title,
			unit: record.unit,
			chunks: record.chunks.map(cloneChunk),
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		};
		if (record.outcome !== undefined) clone.outcome = record.outcome;
		if (record.summary !== undefined) clone.summary = record.summary;
		if (record.finishedAt !== undefined) clone.finishedAt = record.finishedAt;
		return clone;
	}

	private result(
		previous: ProgressSnapshot,
		changed: boolean,
		error?: ProgressAckError,
	): ProgressRegistryResult {
		const snapshot = this.snapshot();
		return {
			ok: error === undefined,
			changed,
			snapshotChanged: !snapshotsEqual(previous, snapshot),
			error,
			snapshot,
		};
	}
}
