// status-bar observer for the hub semantic-progress protocol.
//
// `status-bar` must not import across extension directories, so this module
// mirrors the validated hub progress wire strings/types locally (exactly the
// approach used by `network.ts`). It stays pure and testable: no pi runtime and
// no TUI imports. `index.ts` binds it to `pi.events` and the footer row map.
//
// All incoming text is untrusted display data. It is sanitized here before it
// can reach a footer row. `sanitizeStatusText` is deliberately NOT reused: that
// helper preserves producer-supplied ANSI color, which progress must not allow.

// ---------------------------------------------------------------------------
// Mirrored hub progress contract (see extensions/hub/contract.ts)
// ---------------------------------------------------------------------------

/** Only the channels the status-bar observer needs. */
export const HUB_PROGRESS_CHANNELS = {
	changed: "hub:progress:changed",
	query: "hub:progress:query",
	snapshot: "hub:progress:snapshot",
} as const;

/** Internal footer row id for the progress line. */
export const HUB_PROGRESS_ROW_ID = "hub-progress";
/** Rendered before `proc` (order 100) and after the built-in status lines. */
export const HUB_PROGRESS_ROW_ORDER = 50;

export const PROGRESS_CHUNK_STATES = [
	"pending",
	"active",
	"blocked",
	"done",
	"failed",
	"skipped",
] as const;

export type ProgressChunkState = (typeof PROGRESS_CHUNK_STATES)[number];

export interface ProgressChunkSnapshot {
	/** One-based and immutable. Derived from create order. */
	index: number;
	state: ProgressChunkState;
	phase?: string;
}

export interface ProgressTrackerSnapshot {
	trackerId: string;
	owner: string;
	title: string;
	/** Singular display noun, for example "Stage" or "File". */
	unit: string;
	chunks: ProgressChunkSnapshot[];
	updatedAt: number;
}

export interface ProgressSnapshot {
	/** True exactly when `count > 0`. */
	active: boolean;
	/** Number of unfinished trackers; always equals `trackers.length`. */
	count: number;
	/** Unfinished trackers only. */
	trackers: ProgressTrackerSnapshot[];
}

export interface ProgressQueryPayload {
	requestId: string;
}

export interface HubProgressSnapshotPayload {
	requestId: string;
	snapshot: ProgressSnapshot;
}

export interface EventBusLike {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

// ---------------------------------------------------------------------------
// Bounds (mirrored from the hub registry so oversized observer input is dropped)
// ---------------------------------------------------------------------------

const MAX_TRACKERS = 256;
const MAX_CHUNKS = 100;
const MAX_OWNER_LENGTH = 128;
const MAX_TRACKER_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_UNIT_LENGTH = 40;
const MAX_PHASE_LENGTH = 80;

const TERMINAL_STATES: ReadonlySet<ProgressChunkState> = new Set(["done", "failed", "skipped"]);

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

// OSC (ESC ] ... or C1 0x9D ...) terminated by BEL, ST (ESC \), C1 ST, or end.
const OSC_ESCAPE = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
// CSI sequences and generic two-character ESC sequences.
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
// Every remaining C0/C1 control (including DEL and the C1 range).
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const WHITESPACE_RUN = /\s+/g;

/**
 * Strip ANSI escapes, OSC escapes, and all C0/C1 controls, then collapse the
 * result to one trimmed line. Never reuses `sanitizeStatusText` because that
 * helper intentionally keeps producer ANSI color.
 */
export function sanitizeUntrustedProgressText(value: string): string {
	if (typeof value !== "string") return "";
	return value
		.replace(OSC_ESCAPE, "")
		.replace(ANSI_ESCAPE, "")
		.replace(CONTROL_CHARS, " ")
		.replace(WHITESPACE_RUN, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// Strict structural parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
	return typeof value === "string" && (options as readonly string[]).includes(value);
}

function isRequiredString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isOptionalString(value: unknown, maxLength: number): value is string | undefined {
	return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseChunk(value: unknown, expectedIndex: number): ProgressChunkSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	if (!Number.isInteger(value.index) || value.index !== expectedIndex) return undefined;
	if (!isOneOf(value.state, PROGRESS_CHUNK_STATES)) return undefined;
	if (!isOptionalString(value.phase, MAX_PHASE_LENGTH)) return undefined;

	const chunk: ProgressChunkSnapshot = { index: value.index, state: value.state };
	// Phase is only meaningful while the chunk is active; drop it otherwise so a
	// malformed producer cannot make a blocked chunk render a phase.
	if (value.phase !== undefined && value.state === "active") chunk.phase = value.phase;
	return chunk;
}

function parseTracker(value: unknown): ProgressTrackerSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	if (!isRequiredString(value.trackerId, MAX_TRACKER_ID_LENGTH)) return undefined;
	if (!isRequiredString(value.owner, MAX_OWNER_LENGTH)) return undefined;
	if (!isRequiredString(value.title, MAX_TITLE_LENGTH)) return undefined;
	if (!isRequiredString(value.unit, MAX_UNIT_LENGTH)) return undefined;
	if (!isFiniteNumber(value.updatedAt) || value.updatedAt < 0) return undefined;
	if (!Array.isArray(value.chunks)) return undefined;
	if (value.chunks.length === 0 || value.chunks.length > MAX_CHUNKS) return undefined;

	const chunks: ProgressChunkSnapshot[] = [];
	for (let i = 0; i < value.chunks.length; i++) {
		const chunk = parseChunk(value.chunks[i], i + 1);
		if (!chunk) return undefined;
		chunks.push(chunk);
	}

	return {
		trackerId: value.trackerId,
		owner: value.owner,
		title: value.title,
		unit: value.unit,
		chunks,
		updatedAt: value.updatedAt,
	};
}

/**
 * Strictly validate an `unknown` observer snapshot. Rejects null, arrays,
 * inconsistent `active`/`count`/`trackers`, invalid states, malformed chunk
 * indices, and oversized fields. Returns a fresh detached snapshot on success.
 */
export function parseProgressSnapshot(value: unknown): ProgressSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.active !== "boolean") return undefined;
	if (!Number.isInteger(value.count) || (value.count as number) < 0) return undefined;
	if (!Array.isArray(value.trackers)) return undefined;
	if (value.trackers.length > MAX_TRACKERS) return undefined;

	const trackers: ProgressTrackerSnapshot[] = [];
	for (const raw of value.trackers) {
		const tracker = parseTracker(raw);
		if (!tracker) return undefined;
		trackers.push(tracker);
	}

	const count = value.count as number;
	if (count !== trackers.length) return undefined;
	if (value.active !== (count > 0)) return undefined;

	return { active: value.active, count, trackers };
}

/** Validate a correlated `hub:progress:snapshot` response. */
export function parseProgressSnapshotResponse(value: unknown): HubProgressSnapshotPayload | undefined {
	if (!isRecord(value)) return undefined;
	if (!isRequiredString(value.requestId, 128)) return undefined;
	const snapshot = parseProgressSnapshot(value.snapshot);
	if (!snapshot) return undefined;
	return { requestId: value.requestId, snapshot };
}

// ---------------------------------------------------------------------------
// Counts and selection
// ---------------------------------------------------------------------------

export type ProgressStateCounts = Record<ProgressChunkState, number>;

/** Count chunks by state in one pass. */
export function countChunkStates(chunks: readonly ProgressChunkSnapshot[]): ProgressStateCounts {
	const counts: ProgressStateCounts = {
		pending: 0,
		active: 0,
		blocked: 0,
		done: 0,
		failed: 0,
		skipped: 0,
	};
	for (const chunk of chunks) counts[chunk.state] += 1;
	return counts;
}

export function isTerminalProgressState(state: ProgressChunkState): boolean {
	return TERMINAL_STATES.has(state);
}

/**
 * Pick the tracker the footer should render: most recently updated first, then
 * `owner` and `trackerId` ascending as deterministic tie-breakers.
 */
export function selectMostRecentTracker(
	trackers: readonly ProgressTrackerSnapshot[],
): ProgressTrackerSnapshot | undefined {
	let best: ProgressTrackerSnapshot | undefined;
	for (const tracker of trackers) {
		if (!best) {
			best = tracker;
			continue;
		}
		if (tracker.updatedAt > best.updatedAt) {
			best = tracker;
			continue;
		}
		if (tracker.updatedAt < best.updatedAt) continue;
		if (tracker.owner < best.owner) {
			best = tracker;
			continue;
		}
		if (tracker.owner > best.owner) continue;
		if (tracker.trackerId < best.trackerId) best = tracker;
	}
	return best;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function safeText(value: string | undefined): string {
	return value === undefined ? "" : sanitizeUntrustedProgressText(value);
}

/** Wider bars crowd narrow footers, so longer trackers scale down to this. */
export const MAX_PROGRESS_BAR_CELLS = 10;
const PROGRESS_BAR_FILLED = "■";
const PROGRESS_BAR_EMPTY = "□";

/**
 * `■■□□□`-style bar for one tracker. One cell per chunk when the tracker fits
 * within `maxCells`; longer trackers scale proportionally. `settled` counts
 * successful terminals (`done` + `skipped`); failures stay empty.
 */
export function formatProgressBar(settled: number, total: number, maxCells = MAX_PROGRESS_BAR_CELLS): string {
	if (!Number.isFinite(total) || total <= 0) return "";
	const cells = Math.min(total, Math.max(1, Math.floor(maxCells)));
	const boundedSettled = Math.min(Math.max(settled, 0), total);
	const filled =
		boundedSettled <= 0 ? 0 : boundedSettled >= total ? cells : Math.round((boundedSettled / total) * cells);
	return PROGRESS_BAR_FILLED.repeat(filled) + PROGRESS_BAR_EMPTY.repeat(cells - filled);
}

/**
 * Render the single footer line for a snapshot, or `undefined` when there is
 * nothing active to show. Every text field is sanitized first. Chunk labels are
 * intentionally absent from the observer snapshot and are never rendered.
 */
export function formatProgressRow(snapshot: ProgressSnapshot | undefined): string | undefined {
	if (!snapshot || !snapshot.active || snapshot.count === 0 || snapshot.trackers.length === 0) {
		return undefined;
	}

	const tracker = selectMostRecentTracker(snapshot.trackers);
	if (!tracker) return undefined;

	const title = safeText(tracker.title) || safeText(tracker.trackerId) || "Progress";
	const unit = safeText(tracker.unit) || "Item";
	const total = tracker.chunks.length;
	const counts = countChunkStates(tracker.chunks);
	const activeCount = counts.active;
	const blockedCount = counts.blocked;
	const inFlight = activeCount + blockedCount;
	const settled = counts.done + counts.skipped;
	const terminal = settled + counts.failed;

	let base: string;
	if (inFlight === 1) {
		const focused = tracker.chunks.find((chunk) => chunk.state === "active" || chunk.state === "blocked");
		// parse guarantees a chunk exists when inFlight === 1.
		const chunk = focused ?? tracker.chunks[0]!;
		const phase = chunk.state === "blocked" ? "blocked" : safeText(chunk.phase) || "working";
		base = `${title} · ${unit} ${chunk.index}/${total} (${phase})`;
	} else if (inFlight > 1) {
		const parts = [`${counts.done}/${total} done`];
		if (activeCount > 0) parts.push(`${activeCount} active`);
		if (blockedCount > 0) parts.push(`${blockedCount} blocked`);
		if (counts.failed > 0) parts.push(`${counts.failed} failed`);
		if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
		base = `${title} · ${parts.join(" · ")}`;
	} else if (counts.pending > 0) {
		const parts = [`${counts.done}/${total} done`, `${counts.pending} pending`];
		if (counts.failed > 0) parts.push(`${counts.failed} failed`);
		if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
		base = `${title} · ${parts.join(" · ")}`;
	} else {
		// Every chunk is terminal but the tracker was never finished.
		base = `${title} · ${terminal}/${total} settled · awaiting finish`;
	}

	const extraTrackers = snapshot.trackers.length - 1;
	if (extraTrackers > 0) base += ` · +${extraTrackers} trackers`;

	const bar = formatProgressBar(settled, total);
	return bar.length > 0 ? `${bar} ${base}` : base;
}

/**
 * Minimal color hooks for the footer row. `bar` is the `■□` prefix; `text` is
 * everything after it. Kept as a tiny interface so this module stays pure and
 * does not import the TUI theme type.
 */
export interface ProgressRowPalette {
	bar(text: string): string;
	text(text: string): string;
}

/**
 * Split a formatted row into its bar and text segments and color them
 * independently. The bar is styled less muted than the descriptive text. A row
 * without a leading bar is treated as all text.
 */
export function styleProgressRow(row: string, palette: ProgressRowPalette): string {
	const space = row.indexOf(" ");
	if (space <= 0) return palette.text(row);
	return `${palette.bar(row.slice(0, space))} ${palette.text(row.slice(space + 1))}`;
}

// ---------------------------------------------------------------------------
// Footer row application (kept pure so index.ts stays thin)
// ---------------------------------------------------------------------------

export interface ProgressRowEntry {
	content: string;
	order: number;
}

/**
 * Apply a formatted progress row to a footer row map. `undefined` removes the
 * row. Returns `true` only when the map actually changed, so callers render
 * only after an effective change. Never touches other rows or their order.
 */
export function applyProgressRow(rows: Map<string, ProgressRowEntry>, row: string | undefined): boolean {
	const existing = rows.get(HUB_PROGRESS_ROW_ID);
	if (row === undefined) {
		if (!existing) return false;
		rows.delete(HUB_PROGRESS_ROW_ID);
		return true;
	}
	if (existing && existing.content === row && existing.order === HUB_PROGRESS_ROW_ORDER) return false;
	rows.set(HUB_PROGRESS_ROW_ID, { content: row, order: HUB_PROGRESS_ROW_ORDER });
	return true;
}

// ---------------------------------------------------------------------------
// Observer store
// ---------------------------------------------------------------------------

const DEFAULT_QUERY_TIMEOUT_MS = 300;

/**
 * Bounded, read-only query for the current snapshot. Subscribes to the
 * correlated response BEFORE emitting `query`, matching the synchronous hub
 * protocol. Never throws; resolves `undefined` on timeout, malformed response,
 * or an absent hub.
 */
export function queryProgressSnapshot(
	events: EventBusLike,
	options?: { timeoutMs?: number; requestId?: string },
): Promise<ProgressSnapshot | undefined> {
	const id = options?.requestId ?? `status-bar-progress-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

	return new Promise((resolve) => {
		let settled = false;
		const finish = (snapshot: ProgressSnapshot | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off();
			resolve(snapshot);
		};

		const off = events.on(HUB_PROGRESS_CHANNELS.snapshot, (payload) => {
			const response = parseProgressSnapshotResponse(payload);
			if (!response || response.requestId !== id) return;
			finish(response.snapshot);
		});

		const timer = setTimeout(() => finish(undefined), timeoutMs);

		try {
			events.emit(HUB_PROGRESS_CHANNELS.query, { requestId: id });
		} catch {
			finish(undefined);
		}
	});
}

/**
 * Live client-side cache of the aggregate progress snapshot.
 *
 * Mirrors `NetworkStateStore`: subscribes to `changed` for live updates and
 * exposes a bounded `refresh()`. A live `changed` event landing during a query
 * always wins over the older query response. Late events are ignored while
 * inactive so shutdown cannot restore stale UI.
 */
export class ProgressObserver {
	private snapshot: ProgressSnapshot | undefined;
	private row: string | undefined;
	private version = 0;
	/** Only an active session may apply live `changed` events. */
	private active = false;
	private readonly unsubscribe: () => void;

	constructor(private readonly options: { events: EventBusLike; onChange: (row: string | undefined) => void }) {
		this.unsubscribe = options.events.on(HUB_PROGRESS_CHANNELS.changed, (payload) => {
			if (!this.active) return;
			const parsed = parseProgressSnapshot(payload);
			if (!parsed) return;
			this.set(parsed);
		});
	}

	get current(): ProgressSnapshot | undefined {
		return this.snapshot;
	}

	/** Current formatted footer row, or `undefined` when hidden. */
	get content(): string | undefined {
		return this.row;
	}

	/** Mark a session active so live `changed` events and `refresh()` apply. */
	activate(): void {
		this.active = true;
	}

	/**
	 * Mark the session inactive and drop cached state. Late `changed` events and
	 * in-flight queries are ignored until the next `activate()`.
	 */
	deactivate(): void {
		this.active = false;
		this.set(undefined);
	}

	clear(): void {
		this.set(undefined);
	}

	/** Bounded read. Keeps no state when the hub is absent. */
	async refresh(options?: { timeoutMs?: number }): Promise<void> {
		if (!this.active) return;
		const version = this.version;
		const next = await queryProgressSnapshot(this.options.events, options);
		if (!this.active || this.version !== version) return;
		this.set(next);
	}

	dispose(): void {
		this.unsubscribe();
	}

	private set(next: ProgressSnapshot | undefined): void {
		// Drop the cache entirely for an empty/inactive snapshot so a reset (or a
		// late query) deletes the row and leaves no stale tracker behind.
		const active = next && next.active ? next : undefined;
		const row = active ? formatProgressRow(active) : undefined;
		const changed = row !== this.row;
		this.snapshot = active;
		this.row = row;
		this.version += 1;
		if (changed) this.options.onChange(row);
	}
}
