/**
 * Pure user-wait registry for the hub extension.
 *
 * A user wait is an explicit declaration by the extension that owns a UI (for
 * example an approval dialog or a text prompt) that the user is currently being
 * waited on. Hub never infers waits from pending requests or `confirm` results:
 * the UI owner calls `set` before opening the UI and `clear` once it closes.
 *
 * Waits are keyed by `owner` + `id`, so concurrent and nested waits from the
 * same or different extensions cannot clear each other. The module holds no Pi
 * runtime state and is safe to unit test with `bun test`.
 */

/** Why the user is being waited on. Purely descriptive metadata. */
export type UserWaitKind = "approval" | "input" | "other";

/** Every accepted `kind`. Kept as a list so validation has one source. */
export const USER_WAIT_KINDS: readonly UserWaitKind[] = ["approval", "input", "other"];

/** Validated `hub:user-wait:set` payload. */
export interface UserWaitSetPayload {
	id: string;
	owner: string;
	/** Display text only; consumers sanitize before rendering. */
	label?: string;
	kind?: UserWaitKind;
}

/** Validated `hub:user-wait:clear` payload. */
export interface UserWaitClearPayload {
	id: string;
	owner: string;
}

/** One active wait as stored in the registry (and copied into snapshots). */
export interface UserWaitEntry {
	id: string;
	owner: string;
	label?: string;
	kind?: UserWaitKind;
}

/** Aggregate view handed to observers; never a live reference to the map. */
export interface UserWaitSnapshot {
	active: boolean;
	count: number;
	waits: UserWaitEntry[];
}

/**
 * Result of applying one registry operation.
 *
 * `changed` distinguishes an accepted no-op (duplicate set, unknown clear) from
 * a real state or metadata change, so callers emit `changed` only when needed.
 * `activated` / `deactivated` encode the aggregate zero/non-zero crossing that
 * the Herdr compatibility adapter cares about.
 */
export interface UserWaitTransition {
	/** Snapshot after the operation. */
	snapshot: UserWaitSnapshot;
	/** Aggregate count before the operation. */
	previousCount: number;
	/** Registry contents or visible metadata changed. */
	changed: boolean;
	/** Aggregate crossed from empty to non-empty. */
	activated: boolean;
	/** Aggregate crossed from non-empty to empty. */
	deactivated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isUserWaitKind(value: unknown): value is UserWaitKind {
	return typeof value === "string" && (USER_WAIT_KINDS as readonly string[]).includes(value);
}

/**
 * Validate a `hub:user-wait:set` payload. Returns `undefined` for malformed
 * input (non-record, missing/empty `id` or `owner`, wrong-typed `label`, or an
 * unknown `kind`) so callers can drop it without acknowledging.
 */
export function parseUserWaitSet(payload: unknown): UserWaitSetPayload | undefined {
	if (!isRecord(payload)) return undefined;

	const id = nonEmptyString(payload.id);
	const owner = nonEmptyString(payload.owner);
	if (!id || !owner) return undefined;

	let label: string | undefined;
	if (payload.label !== undefined) {
		if (typeof payload.label !== "string") return undefined;
		label = payload.label;
	}

	let kind: UserWaitKind | undefined;
	if (payload.kind !== undefined) {
		if (!isUserWaitKind(payload.kind)) return undefined;
		kind = payload.kind;
	}

	return { id, owner, label, kind };
}

/** Validate a `hub:user-wait:clear` payload. Returns `undefined` when malformed. */
export function parseUserWaitClear(payload: unknown): UserWaitClearPayload | undefined {
	if (!isRecord(payload)) return undefined;

	const id = nonEmptyString(payload.id);
	const owner = nonEmptyString(payload.owner);
	if (!id || !owner) return undefined;

	return { id, owner };
}

/** Store only the fields that are present, so snapshots stay clean. */
function toEntry(payload: UserWaitSetPayload): UserWaitEntry {
	const entry: UserWaitEntry = { id: payload.id, owner: payload.owner };
	if (payload.label !== undefined) entry.label = payload.label;
	if (payload.kind !== undefined) entry.kind = payload.kind;
	return entry;
}

/**
 * In-memory registry of active user waits.
 *
 * Not a singleton: hub owns one instance and clears it on session shutdown.
 * Parsing happens at the boundary (`set` / `clear` accept `unknown`), so a
 * malformed event returns `undefined` and leaves the registry untouched.
 */
export class UserWaitRegistry {
	private readonly byOwner = new Map<string, Map<string, UserWaitEntry>>();

	/** Apply a set. Returns `undefined` when the payload is malformed. */
	set(payload: unknown): UserWaitTransition | undefined {
		const parsed = parseUserWaitSet(payload);
		if (!parsed) return undefined;

		const previous = this.snapshot();
		const byId = this.byOwner.get(parsed.owner) ?? new Map<string, UserWaitEntry>();
		const existing = byId.get(parsed.id);
		const changed = !existing || existing.label !== parsed.label || existing.kind !== parsed.kind;

		// set is idempotent: the same owner+id always upserts, never duplicates.
		byId.set(parsed.id, toEntry(parsed));
		this.byOwner.set(parsed.owner, byId);

		return this.transition(previous, changed);
	}

	/** Apply a clear. Returns `undefined` when the payload is malformed. */
	clear(payload: unknown): UserWaitTransition | undefined {
		const parsed = parseUserWaitClear(payload);
		if (!parsed) return undefined;

		const previous = this.snapshot();
		const byId = this.byOwner.get(parsed.owner);
		const changed = byId?.delete(parsed.id) ?? false;
		if (changed && byId && byId.size === 0) this.byOwner.delete(parsed.owner);

		return this.transition(previous, changed);
	}

	/** Drop every wait. Session shutdown calls this; it is also safe anytime. */
	reset(): UserWaitTransition {
		const previous = this.snapshot();
		const changed = this.byOwner.size > 0;
		this.byOwner.clear();
		return this.transition(previous, changed);
	}

	/** Total number of active waits across all owners. */
	size(): number {
		let total = 0;
		for (const byId of this.byOwner.values()) total += byId.size;
		return total;
	}

	/**
	 * Immutable-ish aggregate copy. Entries are sorted by owner then id so the
	 * snapshot (and anything rendered from it) is deterministic. Callers may
	 * mutate the returned array/objects without touching the registry.
	 */
	snapshot(): UserWaitSnapshot {
		const waits: UserWaitEntry[] = [];
		for (const byId of this.byOwner.values()) {
			for (const entry of byId.values()) waits.push({ ...entry });
		}
		waits.sort((a, b) => (a.owner === b.owner ? a.id.localeCompare(b.id) : a.owner.localeCompare(b.owner)));

		return { active: waits.length > 0, count: waits.length, waits };
	}

	private transition(previous: UserWaitSnapshot, changed: boolean): UserWaitTransition {
		const snapshot = this.snapshot();
		return {
			snapshot,
			previousCount: previous.count,
			changed,
			activated: previous.count === 0 && snapshot.count > 0,
			deactivated: previous.count > 0 && snapshot.count === 0,
		};
	}
}
