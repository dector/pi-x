import { describe, expect, test } from "bun:test";
import {
	HUB_PROGRESS_CHANNELS,
	HUB_PROGRESS_ROW_ID,
	HUB_PROGRESS_ROW_ORDER,
	ProgressObserver,
	applyProgressRow,
	countChunkStates,
	formatProgressBar,
	formatProgressRow,
	parseProgressSnapshot,
	parseProgressSnapshotResponse,
	queryProgressSnapshot,
	sanitizeUntrustedProgressText,
	selectMostRecentTracker,
	type ProgressChunkState,
	type ProgressSnapshot,
	type ProgressTrackerSnapshot,
} from "./progress.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChunks(states: ProgressChunkState[], phases: (string | undefined)[] = []): ProgressTrackerSnapshot["chunks"] {
	return states.map((state, i) => {
		const chunk: ProgressTrackerSnapshot["chunks"][number] = { index: i + 1, state };
		const phase = phases[i];
		if (phase !== undefined) chunk.phase = phase;
		return chunk;
	});
}

type TrackerInput = Partial<Omit<ProgressTrackerSnapshot, "chunks">> & {
	states: ProgressChunkState[];
	phases?: (string | undefined)[];
};

function makeTracker(input: TrackerInput): ProgressTrackerSnapshot {
	const { states, phases, ...rest } = input;
	return {
		trackerId: "t1",
		owner: "progress-tool",
		title: "Authentication",
		unit: "Stage",
		chunks: makeChunks(states, phases),
		updatedAt: 1000,
		...rest,
	};
}

function makeSnapshot(trackers: ProgressTrackerSnapshot[]): ProgressSnapshot {
	return { active: trackers.length > 0, count: trackers.length, trackers };
}

function createBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	return {
		emitted,
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel: string, handler: (data: unknown) => void) {
			const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
	};
}

// 13 chunks: the first is the focused one, the rest stay pending unless overridden.
function thirteen(overrides: Record<number, ProgressChunkState> = {}, phase?: string): ProgressTrackerSnapshot {
	const states: ProgressChunkState[] = Array.from({ length: 13 }, () => "pending");
	for (const [index, state] of Object.entries(overrides)) states[Number(index) - 1] = state;
	const phases: (string | undefined)[] = [];
	if (phase !== undefined) phases[0] = phase;
	return makeTracker({ states, phases });
}

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

describe("sanitizeUntrustedProgressText", () => {
	test("strips ANSI SGR color", () => {
		expect(sanitizeUntrustedProgressText("\u001b[31mred\u001b[0m")).toBe("red");
	});

	test("strips OSC title and hyperlink escapes (BEL, ST, and C1)", () => {
		expect(sanitizeUntrustedProgressText("\u001b]0;evil\u0007hello")).toBe("hello");
		expect(sanitizeUntrustedProgressText("\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\")).toBe("link");
		expect(sanitizeUntrustedProgressText("\u009d0;evil\u009chello")).toBe("hello");
	});

	test("strips every C0/C1 control and collapses to one trimmed line", () => {
		expect(sanitizeUntrustedProgressText("  a\u0001b\rc\nd\te\u007ff\u0085g\u009bh  ")).toBe("a b c d e f g h");
	});

	test("keeps ordinary unicode text", () => {
		expect(sanitizeUntrustedProgressText("Ünïcode ✓")).toBe("Ünïcode ✓");
	});
});

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

describe("formatProgressBar", () => {
	test("renders one cell per chunk for short trackers", () => {
		expect(formatProgressBar(0, 3)).toBe("□□□");
		expect(formatProgressBar(1, 3)).toBe("■□□");
		expect(formatProgressBar(3, 3)).toBe("■■■");
	});

	test("scales down to the cell cap for long trackers", () => {
		expect(formatProgressBar(13, 13)).toBe("■■■■■■■■■■");
		expect(formatProgressBar(1, 13)).toBe("■□□□□□□□□□");
		expect(formatProgressBar(0, 13)).toBe("□□□□□□□□□□");
	});

	test("counts done and skipped as filled but not failed", () => {
		const settled = 2 + 1; // 2 done + 1 skipped
		expect(formatProgressBar(settled, 4)).toBe("■■■□");
		expect(formatProgressBar(1, 4)).toBe("■□□□");
	});

	test("returns an empty string for a non-positive total", () => {
		expect(formatProgressBar(0, 0)).toBe("");
		expect(formatProgressBar(1, -1)).toBe("");
	});

	test("a tracker with a skipped chunk fills the corresponding cell", () => {
		const snapshot = makeSnapshot([thirteen({ 1: "done", 2: "skipped", 3: "active" })]);
		expect(formatProgressRow(snapshot)?.startsWith("■■")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Focused form
// ---------------------------------------------------------------------------

describe("focused progress format", () => {
	test("one active chunk without a phase falls back to working", () => {
		const snapshot = makeSnapshot([thirteen({ 1: "active" })]);
		expect(formatProgressRow(snapshot)).toBe("□□□□□□□□□□ Authentication · Stage 1/13 (working)");
	});

	test("one active chunk renders its sanitized phase", () => {
		const snapshot = makeSnapshot([thirteen({ 1: "active" }, "reviewing")]);
		expect(formatProgressRow(snapshot)).toBe("□□□□□□□□□□ Authentication · Stage 1/13 (reviewing)");
	});

	test("one blocked chunk always renders blocked even with a phase", () => {
		const tracker = makeTracker({ states: ["blocked"], phases: ["reviewing"] });
		expect(formatProgressRow(makeSnapshot([tracker]))).toBe("□ Authentication · Stage 1/1 (blocked)");
	});

	test("sanitizes title, unit, and phase before rendering", () => {
		const tracker = makeTracker({
			title: "\u001b[31mAuth\u001b[0m",
			unit: "Stage\u0007",
			states: ["active"],
			phases: ["\u001b]0;x\u0007reviewing"],
		});
		expect(formatProgressRow(makeSnapshot([tracker]))).toBe("□ Auth · Stage 1/1 (reviewing)");
	});
});

// ---------------------------------------------------------------------------
// Aggregate / pending / settled forms
// ---------------------------------------------------------------------------

describe("aggregate and remaining progress formats", () => {
	test("several active/blocked chunks render aggregate counts", () => {
		const snapshot = makeSnapshot([thirteen({ 1: "done", 2: "done", 3: "done", 4: "done", 5: "active", 6: "active", 7: "blocked" })]);
		expect(formatProgressRow(snapshot)).toBe("■■■□□□□□□□ Authentication · 4/13 done · 2 active · 1 blocked");
	});

	test("pending-only tracker renders the pending count", () => {
		const snapshot = makeSnapshot([thirteen({ 1: "done", 2: "done", 3: "done", 4: "done" })]);
		expect(formatProgressRow(snapshot)).toBe("■■■□□□□□□□ Authentication · 4/13 done · 9 pending");
	});

	test("failed and skipped counts appear only when non-zero", () => {
		const withFailures = makeSnapshot([
			thirteen({ 1: "done", 2: "done", 3: "done", 4: "blocked", 5: "active", 6: "active", 7: "failed" }),
		]);
		const row = formatProgressRow(withFailures)!;
		expect(row).toContain("1 failed");
		expect(row).not.toContain("skipped");

		const withSkipped = makeSnapshot([thirteen({ 1: "done", 2: "active", 3: "active", 4: "skipped" })]);
		const skippedRow = formatProgressRow(withSkipped)!;
		expect(skippedRow).toContain("1 skipped");
		expect(skippedRow).not.toContain("failed");

		const plain = makeSnapshot([thirteen({ 1: "done", 2: "active", 3: "active" })]);
		expect(formatProgressRow(plain)).toBe("■□□□□□□□□□ Authentication · 1/13 done · 2 active");
	});

	test("pending-only includes non-zero failed/skipped counts", () => {
		const snapshot = makeSnapshot([thirteen({ 1: "done", 2: "failed", 3: "skipped" })]);
		expect(formatProgressRow(snapshot)).toBe("■■□□□□□□□□ Authentication · 1/13 done · 10 pending · 1 failed · 1 skipped");
	});

	test("all-terminal unfinished tracker renders awaiting finish", () => {
		const states: ProgressChunkState[] = Array.from({ length: 13 }, () => "done");
		states[12] = "skipped";
		const snapshot = makeSnapshot([makeTracker({ states })]);
		expect(formatProgressRow(snapshot)).toBe("■■■■■■■■■■ Authentication · 13/13 settled · awaiting finish");
	});

	test("empty or inactive snapshots hide the row", () => {
		expect(formatProgressRow(undefined)).toBeUndefined();
		expect(formatProgressRow({ active: false, count: 0, trackers: [] })).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tracker selection and multiple trackers
// ---------------------------------------------------------------------------

describe("tracker selection", () => {
	test("selects the most recently updated active tracker", () => {
		const older = makeTracker({ trackerId: "old", title: "Older", states: ["active"], updatedAt: 1 });
		const newer = makeTracker({ trackerId: "new", title: "Newer", states: ["active"], updatedAt: 2 });
		expect(selectMostRecentTracker([older, newer])?.trackerId).toBe("new");
		expect(formatProgressRow(makeSnapshot([older, newer]))).toBe("□ Newer · Stage 1/1 (working) · +1 trackers");
	});

	test("breaks updatedAt ties by owner then trackerId", () => {
		const a = makeTracker({ trackerId: "b", owner: "z", states: ["active"], updatedAt: 5 });
		const b = makeTracker({ trackerId: "a", owner: "a", states: ["active"], updatedAt: 5 });
		expect(selectMostRecentTracker([a, b])?.owner).toBe("a");
	});

	test("+N trackers counts the remaining trackers", () => {
		const first = makeTracker({ trackerId: "t1", states: ["active"], updatedAt: 3 });
		const second = makeTracker({ trackerId: "t2", states: ["active"], updatedAt: 2 });
		const third = makeTracker({ trackerId: "t3", states: ["active"], updatedAt: 1 });
		expect(formatProgressRow(makeSnapshot([first, second, third]))).toContain(" · +2 trackers");
	});
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseProgressSnapshot", () => {
	test("accepts a well-formed snapshot and detaches it", () => {
		const input = makeSnapshot([makeTracker({ states: ["active"] })]);
		const parsed = parseProgressSnapshot(input);
		expect(parsed).toEqual(input);
		expect(parsed).not.toBe(input);
		expect(parsed!.trackers[0]).not.toBe(input.trackers[0]);
	});

	test("rejects null, arrays, scalars, and unrelated records", () => {
		expect(parseProgressSnapshot(undefined)).toBeUndefined();
		expect(parseProgressSnapshot(null)).toBeUndefined();
		expect(parseProgressSnapshot([])).toBeUndefined();
		expect(parseProgressSnapshot("nope")).toBeUndefined();
		expect(parseProgressSnapshot(42)).toBeUndefined();
		expect(parseProgressSnapshot({})).toBeUndefined();
	});

	test("rejects inconsistent active/count/trackers", () => {
		expect(parseProgressSnapshot({ active: true, count: 0, trackers: [] })).toBeUndefined();
		expect(parseProgressSnapshot({ active: false, count: 1, trackers: [makeTracker({ states: ["active"] })] })).toBeUndefined();
		expect(parseProgressSnapshot({ active: true, count: 2, trackers: [makeTracker({ states: ["active"] })] })).toBeUndefined();
	});

	test("rejects invalid states, fields, and chunk indices", () => {
		const base = makeTracker({ states: ["active"] });
		expect(parseProgressSnapshot(makeSnapshot([{ ...base, chunks: [{ index: 1, state: "bogus" as ProgressChunkState }] }]))).toBeUndefined();
		expect(parseProgressSnapshot(makeSnapshot([{ ...base, chunks: [{ index: 2, state: "active" }] }]))).toBeUndefined();
		expect(parseProgressSnapshot(makeSnapshot([{ ...base, chunks: [] }]))).toBeUndefined();
		expect(parseProgressSnapshot(makeSnapshot([{ ...base, title: "" }]))).toBeUndefined();
		expect(parseProgressSnapshot(makeSnapshot([{ ...base, updatedAt: Number.NaN }]))).toBeUndefined();
	});

	test("drops a phase on a non-active chunk instead of rendering it", () => {
		const parsed = parseProgressSnapshot(
			makeSnapshot([{ ...makeTracker({ states: ["blocked"] }), chunks: [{ index: 1, state: "blocked", phase: "reviewing" }] }]),
		);
		expect(parsed?.trackers[0]?.chunks[0]?.phase).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Count helpers
// ---------------------------------------------------------------------------

describe("countChunkStates", () => {
	test("counts every state and sums to the chunk total", () => {
		const counts = countChunkStates(makeChunks(["pending", "active", "blocked", "done", "failed", "skipped"]));
		expect(counts).toEqual({ pending: 1, active: 1, blocked: 1, done: 1, failed: 1, skipped: 1 });
		const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
		expect(total).toBe(6);
	});
});

// ---------------------------------------------------------------------------
// Observer store: query and lifecycle
// ---------------------------------------------------------------------------

describe("ProgressObserver", () => {
	test("query response restores state after observer startup", async () => {
		const bus = createBus();
		const expected = makeSnapshot([makeTracker({ states: ["active"], phases: ["reviewing"] })]);
		bus.on(HUB_PROGRESS_CHANNELS.query, (payload) => {
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string") return;
			bus.emit(HUB_PROGRESS_CHANNELS.snapshot, { requestId, snapshot: expected });
		});

		const rows = new Map<string, { content: string; order: number }>();
		const store = new ProgressObserver({
			events: bus,
			onChange: (row) => applyProgressRow(rows, row),
		});
		store.activate();
		await store.refresh({ timeoutMs: 50 });

		expect(store.current).toEqual(expected);
		expect(store.content).toBe("□ Authentication · Stage 1/1 (reviewing)");
		expect(rows.get(HUB_PROGRESS_ROW_ID)?.content).toBe("□ Authentication · Stage 1/1 (reviewing)");
		store.dispose();
	});

	test("refresh is a no-op while inactive", async () => {
		const bus = createBus();
		let requests = 0;
		bus.on(HUB_PROGRESS_CHANNELS.query, () => {
			requests += 1;
		});
		const store = new ProgressObserver({ events: bus, onChange: () => {} });
		await store.refresh({ timeoutMs: 10 });
		expect(requests).toBe(0);
		expect(store.current).toBeUndefined();
		store.dispose();
	});

	test("shutdown prevents stale restoration and ignores late changed events", async () => {
		const bus = createBus();
		const live = makeSnapshot([makeTracker({ states: ["active"] })]);
		const rows = new Map<string, { content: string; order: number }>();
		const store = new ProgressObserver({ events: bus, onChange: (row) => applyProgressRow(rows, row) });

		store.activate();
		bus.emit(HUB_PROGRESS_CHANNELS.changed, live);
		expect(store.content).toBeDefined();
		expect(rows.has(HUB_PROGRESS_ROW_ID)).toBe(true);

		store.deactivate();
		expect(store.current).toBeUndefined();
		expect(store.content).toBeUndefined();
		expect(rows.has(HUB_PROGRESS_ROW_ID)).toBe(false);

		// A late event after shutdown must not restore the previous row.
		bus.emit(HUB_PROGRESS_CHANNELS.changed, live);
		expect(store.current).toBeUndefined();
		expect(rows.has(HUB_PROGRESS_ROW_ID)).toBe(false);

		// Reactivating applies fresh events again.
		store.activate();
		bus.emit(HUB_PROGRESS_CHANNELS.changed, live);
		expect(store.content).toBeDefined();
		store.dispose();
	});

	test("an in-flight query is dropped when the session shuts down", async () => {
		const bus = createBus();
		bus.on(HUB_PROGRESS_CHANNELS.query, (payload) => {
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string") return;
			setTimeout(() => {
				bus.emit(HUB_PROGRESS_CHANNELS.snapshot, {
					requestId,
					snapshot: makeSnapshot([makeTracker({ states: ["active"] })]),
				});
			}, 5);
		});

		const store = new ProgressObserver({ events: bus, onChange: () => {} });
		store.activate();
		const pending = store.refresh({ timeoutMs: 50 });
		store.deactivate();
		await pending;
		expect(store.current).toBeUndefined();
		store.dispose();
	});

	test("an inactive changed snapshot clears the cached state and row", () => {
		const bus = createBus();
		const rows = new Map<string, { content: string; order: number }>();
		const store = new ProgressObserver({ events: bus, onChange: (row) => applyProgressRow(rows, row) });
		store.activate();
		bus.emit(HUB_PROGRESS_CHANNELS.changed, makeSnapshot([makeTracker({ states: ["active"] })]));
		expect(rows.has(HUB_PROGRESS_ROW_ID)).toBe(true);

		bus.emit(HUB_PROGRESS_CHANNELS.changed, { active: false, count: 0, trackers: [] });
		expect(store.current).toBeUndefined();
		expect(store.content).toBeUndefined();
		expect(rows.has(HUB_PROGRESS_ROW_ID)).toBe(false);
		store.dispose();
	});

	test("malformed changed events are ignored safely", () => {
		const bus = createBus();
		let renders = 0;
		const store = new ProgressObserver({ events: bus, onChange: () => renders++ });
		store.activate();
		bus.emit(HUB_PROGRESS_CHANNELS.changed, { active: true, count: 1, trackers: [{ bogus: true }] });
		bus.emit(HUB_PROGRESS_CHANNELS.changed, null);
		expect(store.current).toBeUndefined();
		expect(renders).toBe(0);
		store.dispose();
	});

	test("a live changed event wins over a slower query response", async () => {
		const bus = createBus();
		bus.on(HUB_PROGRESS_CHANNELS.query, (payload) => {
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string") return;
			setTimeout(() => {
				bus.emit(HUB_PROGRESS_CHANNELS.snapshot, {
					requestId,
					snapshot: makeSnapshot([makeTracker({ trackerId: "query", states: ["active"] })]),
				});
			}, 5);
		});
		const store = new ProgressObserver({ events: bus, onChange: () => {} });
		store.activate();
		const pending = store.refresh({ timeoutMs: 50 });
		const live = makeSnapshot([makeTracker({ trackerId: "live", states: ["active"] })]);
		bus.emit(HUB_PROGRESS_CHANNELS.changed, live);
		await pending;
		expect(store.current?.trackers[0]?.trackerId).toBe("live");
		store.dispose();
	});
});

// ---------------------------------------------------------------------------
// queryProgressSnapshot
// ---------------------------------------------------------------------------

describe("queryProgressSnapshot", () => {
	test("resolves the snapshot from a matching response", async () => {
		const bus = createBus();
		const expected = makeSnapshot([makeTracker({ states: ["active"] })]);
		bus.on(HUB_PROGRESS_CHANNELS.query, (payload) => {
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string") return;
			bus.emit(HUB_PROGRESS_CHANNELS.snapshot, { requestId, snapshot: expected });
		});
		await expect(queryProgressSnapshot(bus, { timeoutMs: 50 })).resolves.toEqual(expected);
	});

	test("ignores mismatched ids, malformed responses, and unrelated events", async () => {
		const bus = createBus();
		bus.on(HUB_PROGRESS_CHANNELS.query, (payload) => {
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string") return;
			bus.emit(HUB_PROGRESS_CHANNELS.snapshot, { requestId: "someone-else", snapshot: makeSnapshot([]) });
			bus.emit(HUB_PROGRESS_CHANNELS.snapshot, { requestId, snapshot: { bogus: true } });
			bus.emit("unrelated", { requestId, snapshot: makeSnapshot([]) });
		});
		await expect(queryProgressSnapshot(bus, { timeoutMs: 20 })).resolves.toBeUndefined();
	});

	test("resolves undefined when the hub is absent (timeout)", async () => {
		const bus = createBus();
		await expect(queryProgressSnapshot(bus, { timeoutMs: 10 })).resolves.toBeUndefined();
	});

	test("subscribes to the response before emitting the query", async () => {
		// A synchronous responder can only be observed if the listener was
		// installed before `emit`.
		const bus = createBus();
		bus.on(HUB_PROGRESS_CHANNELS.query, (payload) => {
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string") return;
			bus.emit(HUB_PROGRESS_CHANNELS.snapshot, {
				requestId,
				snapshot: makeSnapshot([makeTracker({ states: ["active"] })]),
			});
		});
		const result = await queryProgressSnapshot(bus, { timeoutMs: 50 });
		expect(result?.active).toBe(true);
	});

	test("parseProgressSnapshotResponse enforces the correlated wrapper", () => {
		const snapshot = makeSnapshot([]);
		expect(parseProgressSnapshotResponse({ requestId: "r", snapshot })).toEqual({ requestId: "r", snapshot });
		expect(parseProgressSnapshotResponse({ requestId: "", snapshot })).toBeUndefined();
		expect(parseProgressSnapshotResponse({ requestId: "r", snapshot: { nope: true } })).toBeUndefined();
		expect(parseProgressSnapshotResponse(null)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Footer row ordering
// ---------------------------------------------------------------------------

describe("progress footer row ordering", () => {
	test("uses order 50 and leaves existing rows unchanged", () => {
		const rows = new Map<string, { content: string; order: number }>([
			["proc", { content: "1 running", order: 100 }],
		]);

		expect(applyProgressRow(rows, "Authentication · Stage 1/1 (working)")).toBe(true);
		const sorted = [...rows.entries()].sort(([, a], [, b]) => a.order - b.order).map(([id]) => id);
		expect(sorted).toEqual([HUB_PROGRESS_ROW_ID, "proc"]);
		expect(rows.get("proc")).toEqual({ content: "1 running", order: 100 });
		expect(rows.get(HUB_PROGRESS_ROW_ID)?.order).toBe(HUB_PROGRESS_ROW_ORDER);

		// Re-applying the same row is not an effective change.
		expect(applyProgressRow(rows, "Authentication · Stage 1/1 (working)")).toBe(false);

		// Removing the row reports a change once and keeps `proc` intact.
		expect(applyProgressRow(rows, undefined)).toBe(true);
		expect(applyProgressRow(rows, undefined)).toBe(false);
		expect([...rows.keys()]).toEqual(["proc"]);
	});
});
