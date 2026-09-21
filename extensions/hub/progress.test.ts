/**
 * Tests for the pure hub progress registry.
 *
 * The module imports only `./contract`, so this suite covers payload parsing,
 * bounded storage, create/update/finish/remove semantics, token guarding,
 * finished-history eviction, deterministic deep-detached snapshots, and reset.
 */

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PROGRESS_UNIT,
	MAX_ACTIVE_PROGRESS_TRACKERS,
	MAX_FINISHED_PROGRESS_TRACKERS,
	MAX_PROGRESS_CHUNK_ID_LENGTH,
	MAX_PROGRESS_CHUNKS,
	MAX_PROGRESS_DETAIL_LENGTH,
	MAX_PROGRESS_LABEL_LENGTH,
	MAX_PROGRESS_OWNER_LENGTH,
	MAX_PROGRESS_PHASE_LENGTH,
	MAX_PROGRESS_RELAY_BYTES,
	MAX_PROGRESS_REQUEST_ID_LENGTH,
	MAX_PROGRESS_SUMMARY_LENGTH,
	MAX_PROGRESS_TITLE_LENGTH,
	MAX_PROGRESS_TRACKER_ID_LENGTH,
	MAX_PROGRESS_TRACKER_TOKEN_LENGTH,
	MAX_PROGRESS_UNIT_LENGTH,
	ProgressRegistry,
	isProgressChunkState,
	isProgressOutcome,
	parseProgressCreate,
	parseProgressFinish,
	parseProgressQuery,
	parseProgressRemove,
	parseProgressUpdate,
} from "./progress";
import type {
	ProgressCreatePayload,
	ProgressFinishPayload,
	ProgressRemovePayload,
	ProgressSnapshot,
	ProgressUpdatePayload,
} from "./contract";

const OWNER = "progress-tool";
const EMPTY_SNAPSHOT: ProgressSnapshot = { active: false, count: 0, trackers: [] };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createPayload(overrides: Partial<ProgressCreatePayload> = {}): ProgressCreatePayload {
	return {
		requestId: "req-1",
		trackerId: "t1",
		trackerToken: "tok-1",
		owner: OWNER,
		title: "Authentication",
		chunks: [{ id: "a" }, { id: "b" }],
		...overrides,
	};
}

function updatePayload(overrides: Partial<ProgressUpdatePayload> = {}): ProgressUpdatePayload {
	return {
		requestId: "req-1",
		trackerId: "t1",
		trackerToken: "tok-1",
		owner: OWNER,
		chunkId: "a",
		state: "active",
		...overrides,
	};
}

function finishPayload(overrides: Partial<ProgressFinishPayload> = {}): ProgressFinishPayload {
	return {
		requestId: "req-1",
		trackerId: "t1",
		trackerToken: "tok-1",
		owner: OWNER,
		outcome: "failed",
		...overrides,
	};
}

function removePayload(overrides: Partial<ProgressRemovePayload> = {}): ProgressRemovePayload {
	return {
		requestId: "req-1",
		trackerId: "t1",
		trackerToken: "tok-1",
		owner: OWNER,
		...overrides,
	};
}

/** Registry with a monotonically advancing clock starting at `start`. */
function clocked(start = 100): { registry: ProgressRegistry; reads: () => number } {
	let value = start;
	return { registry: new ProgressRegistry(() => value++), reads: () => value };
}

const long = (length: number): string => "x".repeat(length);

// ---------------------------------------------------------------------------
// Enum guards
// ---------------------------------------------------------------------------

describe("enum guards", () => {
	test("isProgressChunkState accepts declared states only", () => {
		for (const state of ["pending", "active", "blocked", "done", "failed", "skipped"]) {
			expect(isProgressChunkState(state)).toBe(true);
		}
		for (const value of ["reviewing", "", "PENDING", null, 1, {}, []]) {
			expect(isProgressChunkState(value)).toBe(false);
		}
	});

	test("isProgressOutcome accepts declared outcomes only", () => {
		for (const outcome of ["completed", "failed", "cancelled"]) {
			expect(isProgressOutcome(outcome)).toBe(true);
		}
		for (const value of ["ok", "", "COMPLETED", null, 1, {}]) {
			expect(isProgressOutcome(value)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe("parseProgressCreate", () => {
	test("accepts a minimal payload", () => {
		expect(
			parseProgressCreate({
				requestId: "r",
				trackerId: "t",
				trackerToken: "k",
				owner: "o",
				title: "T",
				chunks: [{ id: "a" }],
			}),
		).toEqual({
			requestId: "r",
			trackerId: "t",
			trackerToken: "k",
			owner: "o",
			title: "T",
			unit: undefined,
			chunks: [{ id: "a" }],
		});
	});

	test("accepts unit and chunk labels and ignores extra fields", () => {
		expect(
			parseProgressCreate({
				requestId: "r",
				trackerId: "t",
				trackerToken: "k",
				owner: "o",
				title: "T",
				unit: "Stage",
				chunks: [{ id: "a", label: "Alpha", extra: 1 }],
				extra: true,
			}),
		).toEqual({
			requestId: "r",
			trackerId: "t",
			trackerToken: "k",
			owner: "o",
			title: "T",
			unit: "Stage",
			chunks: [{ id: "a", label: "Alpha" }],
		});
	});

	test("rejects non-records", () => {
		for (const value of [undefined, null, 0, 1, "x", true, [], ["a"]]) {
			expect(parseProgressCreate(value)).toBeUndefined();
		}
	});

	test("rejects empty or missing required strings", () => {
		expect(parseProgressCreate(createPayload({ requestId: "" }))).toBeUndefined();
		expect(parseProgressCreate(createPayload({ trackerId: "" }))).toBeUndefined();
		expect(parseProgressCreate(createPayload({ trackerToken: "" }))).toBeUndefined();
		expect(parseProgressCreate(createPayload({ owner: "" }))).toBeUndefined();
		expect(parseProgressCreate(createPayload({ title: "" }))).toBeUndefined();
	});

	test("rejects oversized fields", () => {
		expect(parseProgressCreate(createPayload({ requestId: long(MAX_PROGRESS_REQUEST_ID_LENGTH + 1) }))).toBeUndefined();
		expect(parseProgressCreate(createPayload({ trackerId: long(MAX_PROGRESS_TRACKER_ID_LENGTH + 1) }))).toBeUndefined();
		expect(
			parseProgressCreate(createPayload({ trackerToken: long(MAX_PROGRESS_TRACKER_TOKEN_LENGTH + 1) })),
		).toBeUndefined();
		expect(parseProgressCreate(createPayload({ owner: long(MAX_PROGRESS_OWNER_LENGTH + 1) }))).toBeUndefined();
		expect(parseProgressCreate(createPayload({ title: long(MAX_PROGRESS_TITLE_LENGTH + 1) }))).toBeUndefined();
		expect(parseProgressCreate(createPayload({ unit: long(MAX_PROGRESS_UNIT_LENGTH + 1) }))).toBeUndefined();
		expect(
			parseProgressCreate(createPayload({ chunks: [{ id: "a", label: long(MAX_PROGRESS_LABEL_LENGTH + 1) }] })),
		).toBeUndefined();
		expect(parseProgressCreate(createPayload({ chunks: [{ id: long(MAX_PROGRESS_CHUNK_ID_LENGTH + 1) }] }))).toBeUndefined();
	});

	test("accepts exactly the maximum lengths", () => {
		const parsed = parseProgressCreate(
			createPayload({
				requestId: long(MAX_PROGRESS_REQUEST_ID_LENGTH),
				title: long(MAX_PROGRESS_TITLE_LENGTH),
				unit: long(MAX_PROGRESS_UNIT_LENGTH),
				chunks: [{ id: long(MAX_PROGRESS_CHUNK_ID_LENGTH), label: long(MAX_PROGRESS_LABEL_LENGTH) }],
			}),
		);
		expect(parsed).toBeDefined();
	});

	test("rejects empty, oversized, or non-array chunk lists", () => {
		expect(parseProgressCreate(createPayload({ chunks: [] }))).toBeUndefined();
		expect(parseProgressCreate(createPayload({ chunks: "x" as unknown as [] }))).toBeUndefined();
		const tooMany = Array.from({ length: MAX_PROGRESS_CHUNKS + 1 }, (_, i) => ({ id: `c${i}` }));
		expect(parseProgressCreate(createPayload({ chunks: tooMany }))).toBeUndefined();
	});

	test("rejects duplicate chunk IDs", () => {
		expect(parseProgressCreate(createPayload({ chunks: [{ id: "a" }, { id: "a" }] }))).toBeUndefined();
	});

	test("rejects malformed chunk entries", () => {
		expect(parseProgressCreate(createPayload({ chunks: [null as unknown as { id: string }] }))).toBeUndefined();
		expect(parseProgressCreate(createPayload({ chunks: [{ id: "" }] }))).toBeUndefined();
		expect(
			parseProgressCreate(createPayload({ chunks: [{ id: "a", label: 1 as unknown as string }] })),
		).toBeUndefined();
	});
});

describe("parseProgressUpdate", () => {
	test("accepts a minimal payload", () => {
		expect(
			parseProgressUpdate({ requestId: "r", trackerId: "t", trackerToken: "k", owner: "o", chunkId: "a", state: "pending" }),
		).toEqual({
			requestId: "r",
			trackerId: "t",
			trackerToken: "k",
			owner: "o",
			chunkId: "a",
			state: "pending",
			phase: undefined,
			detail: undefined,
		});
	});

	test("accepts active phase and detail", () => {
		expect(parseProgressUpdate(updatePayload({ state: "active", phase: "reviewing", detail: "checking" }))).toEqual({
			requestId: "req-1",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: OWNER,
			chunkId: "a",
			state: "active",
			phase: "reviewing",
			detail: "checking",
		});
	});

	test("rejects non-records and unknown states", () => {
		for (const value of [undefined, null, 0, "x", [], true]) {
			expect(parseProgressUpdate(value)).toBeUndefined();
		}
		expect(parseProgressUpdate(updatePayload({ state: "reviewing" as unknown as "active" }))).toBeUndefined();
	});

	test("rejects empty required strings and oversized fields", () => {
		expect(parseProgressUpdate(updatePayload({ chunkId: "" }))).toBeUndefined();
		expect(parseProgressUpdate(updatePayload({ requestId: long(MAX_PROGRESS_REQUEST_ID_LENGTH + 1) }))).toBeUndefined();
		expect(parseProgressUpdate(updatePayload({ trackerId: long(MAX_PROGRESS_TRACKER_ID_LENGTH + 1) }))).toBeUndefined();
		expect(
			parseProgressUpdate(updatePayload({ trackerToken: long(MAX_PROGRESS_TRACKER_TOKEN_LENGTH + 1) })),
		).toBeUndefined();
		expect(parseProgressUpdate(updatePayload({ owner: long(MAX_PROGRESS_OWNER_LENGTH + 1) }))).toBeUndefined();
		expect(
			parseProgressUpdate(updatePayload({ chunkId: long(MAX_PROGRESS_CHUNK_ID_LENGTH + 1) })),
		).toBeUndefined();
		expect(parseProgressUpdate(updatePayload({ phase: long(MAX_PROGRESS_PHASE_LENGTH + 1) }))).toBeUndefined();
		expect(parseProgressUpdate(updatePayload({ detail: long(MAX_PROGRESS_DETAIL_LENGTH + 1) }))).toBeUndefined();
	});

	test("accepts empty phase and detail (they clear)", () => {
		expect(parseProgressUpdate(updatePayload({ state: "active", phase: "", detail: "" }))).toEqual({
			requestId: "req-1",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: OWNER,
			chunkId: "a",
			state: "active",
			phase: "",
			detail: "",
		});
	});
});

describe("parseProgressFinish", () => {
	test("accepts a minimal payload", () => {
		expect(
			parseProgressFinish({ requestId: "r", trackerId: "t", trackerToken: "k", owner: "o", outcome: "failed" }),
		).toEqual({
			requestId: "r",
			trackerId: "t",
			trackerToken: "k",
			owner: "o",
			outcome: "failed",
			summary: undefined,
		});
	});

	test("rejects non-records and unknown outcomes", () => {
		for (const value of [undefined, null, 0, "x", [], true]) {
			expect(parseProgressFinish(value)).toBeUndefined();
		}
		expect(parseProgressFinish(finishPayload({ outcome: "done" as unknown as "failed" }))).toBeUndefined();
	});

	test("rejects empty required strings and oversized fields", () => {
		expect(parseProgressFinish(finishPayload({ trackerId: "" }))).toBeUndefined();
		expect(parseProgressFinish(finishPayload({ requestId: long(MAX_PROGRESS_REQUEST_ID_LENGTH + 1) }))).toBeUndefined();
		expect(parseProgressFinish(finishPayload({ owner: long(MAX_PROGRESS_OWNER_LENGTH + 1) }))).toBeUndefined();
		expect(
			parseProgressFinish(finishPayload({ trackerToken: long(MAX_PROGRESS_TRACKER_TOKEN_LENGTH + 1) })),
		).toBeUndefined();
		expect(parseProgressFinish(finishPayload({ summary: long(MAX_PROGRESS_SUMMARY_LENGTH + 1) }))).toBeUndefined();
	});
});

describe("parseProgressRemove", () => {
	test("accepts a minimal payload", () => {
		expect(
			parseProgressRemove({ requestId: "r", trackerId: "t", trackerToken: "k", owner: "o" }),
		).toEqual({ requestId: "r", trackerId: "t", trackerToken: "k", owner: "o" });
	});

	test("rejects non-records and missing required strings", () => {
		for (const value of [undefined, null, 0, "x", [], true]) {
			expect(parseProgressRemove(value)).toBeUndefined();
		}
		expect(parseProgressRemove(removePayload({ trackerToken: "" }))).toBeUndefined();
		expect(parseProgressRemove(removePayload({ owner: long(MAX_PROGRESS_OWNER_LENGTH + 1) }))).toBeUndefined();
	});
});

describe("parseProgressQuery", () => {
	test("accepts a minimal payload", () => {
		expect(parseProgressQuery({ requestId: "r" })).toEqual({ requestId: "r" });
	});

	test("rejects non-records and missing/oversized request IDs", () => {
		for (const value of [undefined, null, 0, "x", [], true]) {
			expect(parseProgressQuery(value)).toBeUndefined();
		}
		expect(parseProgressQuery({})).toBeUndefined();
		expect(parseProgressQuery({ requestId: "" })).toBeUndefined();
		expect(parseProgressQuery({ requestId: long(MAX_PROGRESS_REQUEST_ID_LENGTH + 1) })).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe("ProgressRegistry create", () => {
	test("creates a tracker with pending chunks and defaults", () => {
		const { registry } = clocked();
		const result = registry.create(createPayload({ title: "Auth" }));

		expect(result?.ok).toBe(true);
		expect(result?.changed).toBe(true);
		expect(result?.snapshotChanged).toBe(true);
		expect(result?.snapshot.count).toBe(1);
		expect(result?.snapshot.trackers[0]?.title).toBe("Auth");
		expect(result?.snapshot.trackers[0]?.unit).toBe(DEFAULT_PROGRESS_UNIT);

		const record = registry.get(OWNER, "t1");
		expect(record?.chunks.map((chunk) => chunk.state)).toEqual(["pending", "pending"]);
		expect(record?.chunks.map((chunk) => chunk.index)).toEqual([1, 2]);
	});

	test("rejects a malformed payload without touching state", () => {
		const { registry } = clocked();
		expect(registry.create({ requestId: "r" })).toBeUndefined();
		expect(registry.snapshot()).toEqual(EMPTY_SNAPSHOT);
	});

	test("an exact duplicate create is an idempotent no-op", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		const before = registry.get(OWNER, "t1");
		const result = registry.create(createPayload());

		expect(result?.ok).toBe(true);
		expect(result?.changed).toBe(false);
		expect(result?.snapshotChanged).toBe(false);
		expect(registry.get(OWNER, "t1")).toEqual(before);
	});

	test("duplicate equality ignores current chunk state", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.update(updatePayload({ chunkId: "a", state: "active" }));

		const result = registry.create(createPayload());
		expect(result?.ok).toBe(true);
		expect(result?.changed).toBe(false);
		expect(registry.get(OWNER, "t1")?.chunks[0]?.state).toBe("active");
	});

	test("a conflicting duplicate create rejects as already-exists", () => {
		const { registry } = clocked();
		registry.create(createPayload());

		expect(registry.create(createPayload({ title: "Other" }))?.error).toBe("already-exists");
		expect(registry.create(createPayload({ trackerToken: "other" }))?.error).toBe("already-exists");
		expect(registry.create(createPayload({ unit: "Stage" }))?.error).toBe("already-exists");
		expect(registry.create(createPayload({ chunks: [{ id: "a" }, { id: "c" }] }))?.error).toBe("already-exists");
		expect(registry.create(createPayload({ chunks: [{ id: "a", label: "A" }, { id: "b" }] }))?.error).toBe(
			"already-exists",
		);
	});

	test("capacity is bounded and returns limit-exceeded without mutating", () => {
		const { registry } = clocked();
		for (let i = 0; i < MAX_ACTIVE_PROGRESS_TRACKERS; i++) {
			expect(registry.create(createPayload({ trackerId: `t${i}`, requestId: `r${i}` }))?.ok).toBe(true);
		}
		const before = registry.snapshot();

		const overflow = registry.create(createPayload({ trackerId: "overflow", requestId: "r-overflow" }));
		expect(overflow?.ok).toBe(false);
		expect(overflow?.error).toBe("limit-exceeded");
		expect(overflow?.changed).toBe(false);
		expect(registry.snapshot()).toEqual(before);
		expect(registry.activeCount()).toBe(MAX_ACTIVE_PROGRESS_TRACKERS);
	});

	test("finishing frees capacity for a new create", () => {
		const { registry } = clocked();
		for (let i = 0; i < MAX_ACTIVE_PROGRESS_TRACKERS; i++) {
			registry.create(createPayload({ trackerId: `t${i}`, requestId: `r${i}` }));
		}
		registry.finish(finishPayload({ trackerId: "t0", outcome: "cancelled" }));

		expect(registry.create(createPayload({ trackerId: "new", requestId: "r-new" }))?.ok).toBe(true);
	});

	test("owner + trackerId is a composite key", () => {
		const { registry } = clocked();
		registry.create(createPayload({ owner: "alpha", trackerToken: "ta" }));
		registry.create(createPayload({ owner: "beta", trackerToken: "tb" }));

		expect(registry.activeCount()).toBe(2);
		expect(registry.update(updatePayload({ owner: "alpha", trackerToken: "tb" }))?.error).toBe("stale-tracker");
		expect(registry.update(updatePayload({ owner: "beta", trackerToken: "tb" }))?.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe("ProgressRegistry update", () => {
	test("pending -> active -> done succeeds", () => {
		const { registry } = clocked();
		registry.create(createPayload());

		expect(registry.update(updatePayload({ chunkId: "a", state: "active", phase: "implementing" }))?.ok).toBe(true);
		expect(registry.update(updatePayload({ chunkId: "a", state: "done" }))?.ok).toBe(true);

		const chunk = registry.get(OWNER, "t1")?.chunks[0];
		expect(chunk?.state).toBe("done");
		expect(chunk?.phase).toBeUndefined();
	});

	test("active -> blocked -> active succeeds", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.update(updatePayload({ chunkId: "a", state: "active", phase: "reviewing" }));

		expect(registry.update(updatePayload({ chunkId: "a", state: "blocked" }))?.ok).toBe(true);
		expect(registry.snapshot().trackers[0]?.chunks[0]).toEqual({ index: 1, state: "blocked" });

		expect(registry.update(updatePayload({ chunkId: "a", state: "active", phase: "reviewing" }))?.ok).toBe(true);
		expect(registry.snapshot().trackers[0]?.chunks[0]).toEqual({ index: 1, state: "active", phase: "reviewing" });
	});

	test("updates use last-arrival-wins within one live token", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.update(updatePayload({ chunkId: "a", state: "active", phase: "implementing" }));
		registry.update(updatePayload({ chunkId: "a", state: "active", phase: "reviewing" }));

		expect(registry.snapshot().trackers[0]?.chunks[0]?.phase).toBe("reviewing");
	});

	test("a non-active state with a non-empty phase rejects as invalid-transition", () => {
		const { registry } = clocked();
		registry.create(createPayload());

		expect(registry.update(updatePayload({ chunkId: "a", state: "blocked", phase: "x" }))?.error).toBe(
			"invalid-transition",
		);
		expect(registry.update(updatePayload({ chunkId: "a", state: "pending", phase: "x" }))?.error).toBe(
			"invalid-transition",
		);
		expect(registry.update(updatePayload({ chunkId: "a", state: "done", phase: "x" }))?.error).toBe(
			"invalid-transition",
		);
		expect(registry.get(OWNER, "t1")?.chunks[0]?.state).toBe("pending");
	});

	test("a terminal chunk rejects further mutation", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.update(updatePayload({ chunkId: "a", state: "done" }));

		expect(registry.update(updatePayload({ chunkId: "a", state: "active" }))?.error).toBe("chunk-terminal");
		expect(registry.update(updatePayload({ chunkId: "a", state: "failed" }))?.error).toBe("chunk-terminal");
		expect(registry.get(OWNER, "t1")?.chunks[0]?.state).toBe("done");
	});

	test("an identical terminal update is an idempotent no-op", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.update(updatePayload({ chunkId: "a", state: "done", detail: "shipped" }));

		const repeat = registry.update(updatePayload({ chunkId: "a", state: "done", detail: "shipped" }));
		expect(repeat?.ok).toBe(true);
		expect(repeat?.changed).toBe(false);
		expect(repeat?.snapshotChanged).toBe(false);
	});

	test("unknown tracker or chunk rejects as not-found", () => {
		const { registry } = clocked();
		registry.create(createPayload());

		expect(registry.update(updatePayload({ trackerId: "missing" }))?.error).toBe("not-found");
		expect(registry.update(updatePayload({ chunkId: "missing" }))?.error).toBe("not-found");
	});

	test("detail-only change mutates the record and advances the visible timestamp", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		const before = registry.get(OWNER, "t1")?.chunks[0]?.updatedAt;
		const detail = registry.update(
			updatePayload({ chunkId: "a", state: "pending", detail: "waiting on schema" }),
		);

		expect(detail?.ok).toBe(true);
		expect(detail?.changed).toBe(true);
		// `updatedAt` is part of the observer snapshot, so the timestamp change
		// is visible even when state and phase are unchanged.
		expect(detail?.snapshotChanged).toBe(true);
		expect(registry.get(OWNER, "t1")?.chunks[0]?.detail).toBe("waiting on schema");
		expect(registry.get(OWNER, "t1")?.chunks[0]?.updatedAt).not.toBe(before);
	});
});

// ---------------------------------------------------------------------------
// Finish
// ---------------------------------------------------------------------------

describe("ProgressRegistry finish", () => {
	test("completed rejects while chunks are nonterminal or failed", () => {
		const { registry } = clocked();
		registry.create(createPayload());

		expect(registry.finish(finishPayload({ outcome: "completed" }))?.error).toBe("incomplete");

		registry.update(updatePayload({ chunkId: "a", state: "done" }));
		expect(registry.finish(finishPayload({ outcome: "completed" }))?.error).toBe("incomplete");

		registry.update(updatePayload({ chunkId: "b", state: "failed" }));
		expect(registry.finish(finishPayload({ outcome: "completed" }))?.error).toBe("incomplete");
	});

	test("completed accepts all done/skipped and freezes the tracker", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.update(updatePayload({ chunkId: "a", state: "done" }));
		registry.update(updatePayload({ chunkId: "b", state: "skipped" }));

		const result = registry.finish(finishPayload({ outcome: "completed", summary: "shipped" }));
		expect(result?.ok).toBe(true);
		expect(result?.changed).toBe(true);
		expect(result?.snapshot).toEqual(EMPTY_SNAPSHOT);

		const record = registry.get(OWNER, "t1");
		expect(record?.outcome).toBe("completed");
		expect(record?.summary).toBe("shipped");
		expect(record?.finishedAt).toBeDefined();

		expect(registry.update(updatePayload({ chunkId: "a", state: "active" }))?.error).toBe("tracker-finished");
	});

	test("failed and cancelled may finish early", () => {
		const first = clocked();
		first.registry.create(createPayload());
		expect(first.registry.finish(finishPayload({ outcome: "failed" }))?.ok).toBe(true);

		const second = clocked();
		second.registry.create(createPayload());
		expect(second.registry.finish(finishPayload({ outcome: "cancelled" }))?.ok).toBe(true);
	});

	test("an exact repeated finish is an idempotent no-op", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.finish(finishPayload({ outcome: "failed", summary: "boom" }));
		const before = registry.get(OWNER, "t1");

		const repeat = registry.finish(finishPayload({ outcome: "failed", summary: "boom" }));
		expect(repeat?.ok).toBe(true);
		expect(repeat?.changed).toBe(false);
		expect(registry.get(OWNER, "t1")).toEqual(before);
	});

	test("a different second finish rejects as conflict", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.finish(finishPayload({ outcome: "failed", summary: "boom" }));

		expect(registry.finish(finishPayload({ outcome: "failed", summary: "different" }))?.error).toBe("conflict");
		expect(registry.finish(finishPayload({ outcome: "cancelled" }))?.error).toBe("conflict");
	});

	test("unknown tracker rejects as not-found", () => {
		const { registry } = clocked();
		expect(registry.finish(finishPayload({ trackerId: "missing" }))?.error).toBe("not-found");
	});
});

// ---------------------------------------------------------------------------
// Remove and reset
// ---------------------------------------------------------------------------

describe("ProgressRegistry remove and reset", () => {
	test("removes the matching incarnation", () => {
		const { registry } = clocked();
		registry.create(createPayload());

		const result = registry.remove(removePayload());
		expect(result?.ok).toBe(true);
		expect(result?.changed).toBe(true);
		expect(registry.get(OWNER, "t1")).toBeUndefined();
		expect(registry.snapshot()).toEqual(EMPTY_SNAPSHOT);
	});

	test("an unknown remove is an accepted no-op", () => {
		const { registry } = clocked();
		const unknown = registry.remove(removePayload({ trackerId: "missing" }));
		expect(unknown?.ok).toBe(true);
		expect(unknown?.changed).toBe(false);

		registry.create(createPayload({ owner: "alpha" }));
		const wrongOwner = registry.remove(removePayload({ owner: "beta" }));
		expect(wrongOwner?.ok).toBe(true);
		expect(wrongOwner?.changed).toBe(false);
		expect(registry.activeCount()).toBe(1);
	});

	test("a stale token cannot update, finish, or remove a recreated tracker", () => {
		const { registry } = clocked();
		registry.create(createPayload({ trackerToken: "old" }));
		registry.remove(removePayload({ trackerToken: "old" }));
		registry.create(createPayload({ trackerToken: "new" }));

		expect(registry.update(updatePayload({ trackerToken: "old" }))?.error).toBe("stale-tracker");
		expect(registry.finish(finishPayload({ trackerToken: "old" }))?.error).toBe("stale-tracker");
		expect(registry.remove(removePayload({ trackerToken: "old" }))?.error).toBe("stale-tracker");
		expect(registry.activeCount()).toBe(1);

		expect(registry.update(updatePayload({ trackerToken: "new" }))?.ok).toBe(true);
		expect(registry.remove(removePayload({ trackerToken: "new" }))?.ok).toBe(true);
	});

	test("removing a finished record changes the registry but not the snapshot", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.finish(finishPayload({ outcome: "cancelled" }));

		const removed = registry.remove(removePayload());
		expect(removed?.ok).toBe(true);
		expect(removed?.changed).toBe(true);
		expect(removed?.snapshotChanged).toBe(false);
	});

	test("reset returns an empty snapshot", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.create(createPayload({ trackerId: "t2" }));

		const result = registry.reset();
		expect(result.ok).toBe(true);
		expect(result.changed).toBe(true);
		expect(result.snapshotChanged).toBe(true);
		expect(result.snapshot).toEqual(EMPTY_SNAPSHOT);
		expect(registry.snapshot()).toEqual(EMPTY_SNAPSHOT);

		const again = registry.reset();
		expect(again.changed).toBe(false);
		expect(again.snapshotChanged).toBe(false);
	});

	test("reset with only finished records does not report a snapshot change", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.finish(finishPayload({ outcome: "failed" }));

		const result = registry.reset();
		expect(result.changed).toBe(true);
		expect(result.snapshotChanged).toBe(false);
	});

	test("query returns a detached snapshot only for a valid payload", () => {
		const { registry } = clocked();
		registry.create(createPayload());

		const snapshot = registry.query({ requestId: "q1" });
		expect(snapshot?.count).toBe(1);
		snapshot!.trackers[0]!.title = "HACK";
		expect(registry.snapshot().trackers[0]?.title).toBe("Authentication");

		expect(registry.query({})).toBeUndefined();
		expect(registry.query(null)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Bounds and history
// ---------------------------------------------------------------------------

describe("ProgressRegistry bounds and history", () => {
	test("chunk bound rejects without mutating state", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		const before = registry.snapshot();

		const tooMany = Array.from({ length: MAX_PROGRESS_CHUNKS + 1 }, (_, i) => ({ id: `c${i}` }));
		expect(registry.create(createPayload({ trackerId: "big", chunks: tooMany }))).toBeUndefined();
		expect(registry.snapshot()).toEqual(before);
	});

	test("finished history evicts only the oldest record at its bound", () => {
		const { registry } = clocked();
		registry.create(createPayload({ trackerId: "keeper" }));
		registry.update(updatePayload({ trackerId: "keeper", chunkId: "a", state: "active" }));

		for (let i = 0; i < MAX_FINISHED_PROGRESS_TRACKERS + 1; i++) {
			registry.create(createPayload({ trackerId: `f${i}`, requestId: `r${i}` }));
			registry.finish(finishPayload({ trackerId: `f${i}`, outcome: "failed" }));
		}

		expect(registry.finishedCount()).toBe(MAX_FINISHED_PROGRESS_TRACKERS);
		expect(registry.get(OWNER, "f0")).toBeUndefined();
		expect(registry.get(OWNER, "f1")).toBeDefined();
		expect(registry.get(OWNER, `f${MAX_FINISHED_PROGRESS_TRACKERS}`)).toBeDefined();

		// The active tracker survives history eviction.
		expect(registry.activeCount()).toBe(1);
		expect(registry.snapshot().trackers[0]?.trackerId).toBe("keeper");
	});

	test("list returns active and finished records as deep copies", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.create(createPayload({ trackerId: "t2" }));
		registry.finish(finishPayload({ trackerId: "t2", outcome: "cancelled" }));

		const list = registry.list();
		expect(list.length).toBe(2);

		list[0]!.chunks[0]!.state = "done";
		expect(registry.get(OWNER, list[0]!.trackerId)?.chunks[0]?.state).toBe("pending");
	});
});

// ---------------------------------------------------------------------------
// Timestamps, ordering, and detachment
// ---------------------------------------------------------------------------

describe("ProgressRegistry timestamps and snapshots", () => {
	test("timestamps change only on real mutations", () => {
		let reads = 0;
		let now = 100;
		const registry = new ProgressRegistry(() => {
			reads++;
			return now++;
		});
		const payload = createPayload();

		registry.create(payload);
		expect(reads).toBe(1);

		registry.create(payload);
		expect(reads).toBe(1);

		expect(registry.update(updatePayload({ chunkId: "a", state: "pending" }))?.changed).toBe(false);
		expect(reads).toBe(1);

		expect(registry.update(updatePayload({ chunkId: "a", state: "active" }))?.changed).toBe(true);
		expect(reads).toBe(2);
		expect(registry.get(OWNER, "t1")?.chunks[0]?.updatedAt).toBe(101);
		expect(registry.get(OWNER, "t1")?.updatedAt).toBe(101);

		registry.finish(finishPayload({ outcome: "failed" }));
		expect(reads).toBe(3);
		registry.finish(finishPayload({ outcome: "failed" }));
		expect(reads).toBe(3);
	});

	test("snapshot ordering is deterministic", () => {
		let now = 0;
		const byTime = new ProgressRegistry(() => now++);
		byTime.create(createPayload({ trackerId: "first", requestId: "r1" }));
		byTime.create(createPayload({ trackerId: "second", requestId: "r2" }));
		expect(byTime.snapshot().trackers.map((tracker) => tracker.trackerId)).toEqual(["second", "first"]);

		const fixed = new ProgressRegistry(() => 5);
		fixed.create(createPayload({ owner: "zeta", trackerId: "t1", requestId: "r1" }));
		fixed.create(createPayload({ owner: "alpha", trackerId: "t2", requestId: "r2" }));
		fixed.create(createPayload({ owner: "alpha", trackerId: "t1", requestId: "r3" }));
		expect(fixed.snapshot().trackers.map((tracker) => `${tracker.owner}/${tracker.trackerId}`)).toEqual([
			"alpha/t1",
			"alpha/t2",
			"zeta/t1",
		]);
	});

	test("mutating a returned snapshot cannot mutate the registry", () => {
		const { registry } = clocked();
		registry.create(createPayload());
		registry.update(updatePayload({ chunkId: "a", state: "active", phase: "reviewing" }));

		const snapshot = registry.snapshot();
		snapshot.active = false;
		snapshot.count = 0;
		snapshot.trackers[0]!.title = "HACK";
		snapshot.trackers[0]!.chunks[0]!.state = "done";
		snapshot.trackers[0]!.chunks.push({ index: 99, state: "done" });

		const fresh = registry.snapshot();
		expect(fresh.active).toBe(true);
		expect(fresh.count).toBe(1);
		expect(fresh.trackers[0]?.title).toBe("Authentication");
		expect(fresh.trackers[0]?.chunks).toEqual([
			{ index: 1, state: "active", phase: "reviewing" },
			{ index: 2, state: "pending" },
		]);
	});
});

// ---------------------------------------------------------------------------
// Relay bound relationship
// ---------------------------------------------------------------------------

describe("progress relay bound", () => {
	test("a maximum valid create fits under MAX_PROGRESS_RELAY_BYTES", () => {
		const control = "\u0000";
		const repeated = (length: number): string => control.repeat(length);

		const chunks = Array.from({ length: MAX_PROGRESS_CHUNKS }, (_, i) => ({
			// Unique IDs at the maximum length, using six-byte JSON escapes.
			id: repeated(MAX_PROGRESS_CHUNK_ID_LENGTH - 2) + String(i).padStart(2, "0"),
			label: repeated(MAX_PROGRESS_LABEL_LENGTH),
		}));

		const payload = {
			requestId: repeated(MAX_PROGRESS_REQUEST_ID_LENGTH),
			trackerId: repeated(MAX_PROGRESS_TRACKER_ID_LENGTH),
			trackerToken: repeated(MAX_PROGRESS_TRACKER_TOKEN_LENGTH),
			owner: repeated(MAX_PROGRESS_OWNER_LENGTH),
			title: repeated(MAX_PROGRESS_TITLE_LENGTH),
			unit: repeated(MAX_PROGRESS_UNIT_LENGTH),
			chunks,
		};

		expect(parseProgressCreate(payload)).toBeDefined();

		const statusText = JSON.stringify({ version: 1, channel: "hub:progress:create", payload });
		expect(Buffer.byteLength(statusText, "utf8")).toBeLessThan(MAX_PROGRESS_RELAY_BYTES);
	});
});
