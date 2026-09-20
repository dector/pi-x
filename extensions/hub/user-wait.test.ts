/**
 * Tests for the pure hub user-wait registry.
 *
 * The module has no Pi runtime dependency, so this suite covers parsing,
 * composite-keyed storage, idempotent updates, wrong-owner isolation, aggregate
 * snapshots, zero/non-zero transition detection, and reset.
 */

import { describe, expect, test } from "bun:test";
import {
	UserWaitRegistry,
	USER_WAIT_KINDS,
	isUserWaitKind,
	parseUserWaitClear,
	parseUserWaitSet,
	type UserWaitKind,
	type UserWaitSnapshot,
} from "./user-wait.ts";

const EMPTY: UserWaitSnapshot = { active: false, count: 0, waits: [] };

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

describe("parseUserWaitSet", () => {
	test("accepts a minimal payload", () => {
		expect(parseUserWaitSet({ id: "w1", owner: "safe-mode" })).toEqual({
			id: "w1",
			owner: "safe-mode",
			label: undefined,
			kind: undefined,
		});
	});

	test("accepts label and kind", () => {
		expect(parseUserWaitSet({ id: "w1", owner: "safe-mode", label: "approve bash", kind: "approval" })).toEqual({
			id: "w1",
			owner: "safe-mode",
			label: "approve bash",
			kind: "approval",
		});
	});

	test("accepts every declared kind", () => {
		for (const kind of USER_WAIT_KINDS) {
			expect(parseUserWaitSet({ id: "w1", owner: "o", kind })).toEqual({
				id: "w1",
				owner: "o",
				label: undefined,
				kind,
			});
		}
	});

	test("ignores unknown extra fields", () => {
		expect(parseUserWaitSet({ id: "w1", owner: "o", extra: true, nested: { x: 1 } })).toEqual({
			id: "w1",
			owner: "o",
			label: undefined,
			kind: undefined,
		});
	});

	test("rejects non-records", () => {
		for (const value of [undefined, null, 0, 1, "x", true, [], ["w1"]]) {
			expect(parseUserWaitSet(value)).toBeUndefined();
		}
	});

	test("rejects missing, empty, or non-string id", () => {
		expect(parseUserWaitSet({ owner: "o" })).toBeUndefined();
		expect(parseUserWaitSet({ id: "", owner: "o" })).toBeUndefined();
		expect(parseUserWaitSet({ id: 1, owner: "o" })).toBeUndefined();
		expect(parseUserWaitSet({ id: null, owner: "o" })).toBeUndefined();
	});

	test("rejects missing, empty, or non-string owner", () => {
		expect(parseUserWaitSet({ id: "w1" })).toBeUndefined();
		expect(parseUserWaitSet({ id: "w1", owner: "" })).toBeUndefined();
		expect(parseUserWaitSet({ id: "w1", owner: 1 })).toBeUndefined();
		expect(parseUserWaitSet({ id: "w1", owner: null })).toBeUndefined();
	});

	test("rejects a non-string label", () => {
		expect(parseUserWaitSet({ id: "w1", owner: "o", label: 1 })).toBeUndefined();
		expect(parseUserWaitSet({ id: "w1", owner: "o", label: null })).toBeUndefined();
		expect(parseUserWaitSet({ id: "w1", owner: "o", label: {} })).toBeUndefined();
	});

	test("accepts an empty-string label", () => {
		expect(parseUserWaitSet({ id: "w1", owner: "o", label: "" })).toEqual({
			id: "w1",
			owner: "o",
			label: "",
			kind: undefined,
		});
	});

	test("rejects an unknown kind", () => {
		expect(parseUserWaitSet({ id: "w1", owner: "o", kind: "bogus" })).toBeUndefined();
		expect(parseUserWaitSet({ id: "w1", owner: "o", kind: null })).toBeUndefined();
		expect(parseUserWaitSet({ id: "w1", owner: "o", kind: 1 })).toBeUndefined();
	});
});

describe("parseUserWaitClear", () => {
	test("accepts a minimal payload", () => {
		expect(parseUserWaitClear({ id: "w1", owner: "safe-mode" })).toEqual({ id: "w1", owner: "safe-mode" });
	});

	test("ignores unknown extra fields", () => {
		expect(parseUserWaitClear({ id: "w1", owner: "o", label: "ignored" })).toEqual({ id: "w1", owner: "o" });
	});

	test("rejects non-records", () => {
		for (const value of [undefined, null, 0, "x", [], true]) {
			expect(parseUserWaitClear(value)).toBeUndefined();
		}
	});

	test("rejects missing, empty, or non-string id", () => {
		expect(parseUserWaitClear({ owner: "o" })).toBeUndefined();
		expect(parseUserWaitClear({ id: "", owner: "o" })).toBeUndefined();
		expect(parseUserWaitClear({ id: 1, owner: "o" })).toBeUndefined();
	});

	test("rejects missing, empty, or non-string owner", () => {
		expect(parseUserWaitClear({ id: "w1" })).toBeUndefined();
		expect(parseUserWaitClear({ id: "w1", owner: "" })).toBeUndefined();
		expect(parseUserWaitClear({ id: "w1", owner: 1 })).toBeUndefined();
	});
});

describe("isUserWaitKind", () => {
	test("accepts every declared kind", () => {
		for (const kind of USER_WAIT_KINDS) expect(isUserWaitKind(kind)).toBe(true);
	});

	test("rejects everything else", () => {
		for (const value of [undefined, null, "", "APPROVAL", "wait", 1, {}]) {
			expect(isUserWaitKind(value)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("UserWaitRegistry", () => {
	test("starts empty", () => {
		const registry = new UserWaitRegistry();
		expect(registry.size()).toBe(0);
		expect(registry.snapshot()).toEqual(EMPTY);
	});

	test("set adds a wait and reports activation", () => {
		const registry = new UserWaitRegistry();
		const transition = registry.set({ id: "w1", owner: "safe-mode", label: "approve", kind: "approval" });

		expect(transition).toBeDefined();
		expect(transition?.changed).toBe(true);
		expect(transition?.previousCount).toBe(0);
		expect(transition?.activated).toBe(true);
		expect(transition?.deactivated).toBe(false);
		expect(transition?.snapshot).toEqual({
			active: true,
			count: 1,
			waits: [{ id: "w1", owner: "safe-mode", label: "approve", kind: "approval" }],
		});
		expect(registry.size()).toBe(1);
	});

	test("omits absent optional metadata from stored entries", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "w1", owner: "o" });

		const entry = registry.snapshot().waits[0] as Record<string, unknown>;
		expect(entry).toEqual({ id: "w1", owner: "o" });
		expect("label" in entry).toBe(false);
		expect("kind" in entry).toBe(false);
	});

	test("duplicate set is idempotent and reports no change", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "w1", owner: "o", label: "same", kind: "input" });

		const transition = registry.set({ id: "w1", owner: "o", label: "same", kind: "input" });
		expect(transition?.changed).toBe(false);
		expect(transition?.previousCount).toBe(1);
		expect(transition?.snapshot.count).toBe(1);
		expect(registry.size()).toBe(1);
	});

	test("repeated set updates visible metadata without adding a wait", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "w1", owner: "o", label: "old", kind: "approval" });

		const relabel = registry.set({ id: "w1", owner: "o", label: "new", kind: "approval" });
		expect(relabel?.changed).toBe(true);
		expect(relabel?.snapshot.count).toBe(1);
		expect(relabel?.snapshot.waits[0]?.label).toBe("new");

		const rekind = registry.set({ id: "w1", owner: "o", label: "new", kind: "input" });
		expect(rekind?.changed).toBe(true);
		expect(rekind?.snapshot.count).toBe(1);
		expect(rekind?.snapshot.waits[0]?.kind).toBe("input");

		const cleared = registry.set({ id: "w1", owner: "o", kind: "input" });
		expect(cleared?.changed).toBe(true);
		expect(cleared?.snapshot.waits[0]?.label).toBeUndefined();
	});

	test("metadata change does not report activation", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "w1", owner: "o", label: "old" });

		const transition = registry.set({ id: "w1", owner: "o", label: "new" });
		expect(transition?.activated).toBe(false);
		expect(transition?.deactivated).toBe(false);
	});

	test("keeps concurrent waits from one owner", () => {
		const registry = new UserWaitRegistry();
		const first = registry.set({ id: "w1", owner: "safe-mode" });
		const second = registry.set({ id: "w2", owner: "safe-mode" });

		expect(first?.activated).toBe(true);
		expect(second?.activated).toBe(false);
		expect(second?.snapshot.count).toBe(2);
		expect(registry.size()).toBe(2);
	});

	test("treats the same id from different owners as distinct waits", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "shared", owner: "a" });
		registry.set({ id: "shared", owner: "b" });

		expect(registry.size()).toBe(2);
		expect(registry.snapshot().waits.map((wait) => wait.owner)).toEqual(["a", "b"]);
	});

	test("clear removes only the matching owner and id", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "shared", owner: "a" });
		registry.set({ id: "shared", owner: "b" });

		const transition = registry.clear({ id: "shared", owner: "a" });
		expect(transition?.changed).toBe(true);
		expect(transition?.snapshot.count).toBe(1);
		expect(transition?.snapshot.waits).toEqual([{ id: "shared", owner: "b" }]);
	});

	test("a wrong-owner clear does nothing", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "w1", owner: "a", label: "keep" });

		const transition = registry.clear({ id: "w1", owner: "b" });
		expect(transition?.changed).toBe(false);
		expect(transition?.snapshot.count).toBe(1);
		expect(registry.snapshot().waits).toEqual([{ id: "w1", owner: "a", label: "keep" }]);
	});

	test("clearing an unknown wait is harmless", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "w1", owner: "a" });

		const transition = registry.clear({ id: "missing", owner: "a" });
		expect(transition?.changed).toBe(false);
		expect(transition?.previousCount).toBe(1);
		expect(transition?.snapshot.count).toBe(1);
		expect(registry.size()).toBe(1);
	});

	test("a malformed set is rejected and leaves the registry untouched", () => {
		const registry = new UserWaitRegistry();
		const before = registry.snapshot();

		expect(registry.set(undefined)).toBeUndefined();
		expect(registry.set({})).toBeUndefined();
		expect(registry.set({ id: "w1" })).toBeUndefined();
		expect(registry.set({ id: "w1", owner: "o", kind: "bogus" })).toBeUndefined();
		expect(registry.snapshot()).toEqual(before);
		expect(registry.size()).toBe(0);
	});

	test("a malformed clear is rejected and leaves the registry untouched", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "w1", owner: "o" });
		const before = registry.snapshot();

		expect(registry.clear(undefined)).toBeUndefined();
		expect(registry.clear({})).toBeUndefined();
		expect(registry.clear({ id: "w1" })).toBeUndefined();
		expect(registry.snapshot()).toEqual(before);
		expect(registry.size()).toBe(1);
	});

	test("detects the aggregate zero to non-zero crossing once", () => {
		const registry = new UserWaitRegistry();
		expect(registry.set({ id: "w1", owner: "o" })?.activated).toBe(true);
		expect(registry.set({ id: "w2", owner: "o" })?.activated).toBe(false);
		expect(registry.set({ id: "w3", owner: "p" })?.activated).toBe(false);
	});

	test("deactivates only after the final wait clears", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "w1", owner: "o" });
		registry.set({ id: "w2", owner: "o" });

		const first = registry.clear({ id: "w1", owner: "o" });
		expect(first?.changed).toBe(true);
		expect(first?.deactivated).toBe(false);
		expect(first?.snapshot.count).toBe(1);

		const last = registry.clear({ id: "w2", owner: "o" });
		expect(last?.changed).toBe(true);
		expect(last?.deactivated).toBe(true);
		expect(last?.previousCount).toBe(1);
		expect(last?.snapshot).toEqual(EMPTY);
	});

	test("returns snapshots detached from internal state", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "w1", owner: "o", label: "original" });

		const snapshot = registry.snapshot();
		snapshot.waits.push({ id: "injected", owner: "x" });
		(snapshot.waits[0] as { label?: string }).label = "mutated";

		expect(registry.snapshot()).toEqual({
			active: true,
			count: 1,
			waits: [{ id: "w1", owner: "o", label: "original" }],
		});
	});

	test("sorts snapshots by owner then id", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "b", owner: "z" });
		registry.set({ id: "a", owner: "z" });
		registry.set({ id: "m", owner: "a" });
		registry.set({ id: "a", owner: "a" });

		expect(registry.snapshot().waits).toEqual([
			{ id: "a", owner: "a" },
			{ id: "m", owner: "a" },
			{ id: "a", owner: "z" },
			{ id: "b", owner: "z" },
		]);
	});

	test("reset clears every wait and reports deactivation", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "w1", owner: "a" });
		registry.set({ id: "w2", owner: "b" });

		const transition = registry.reset();
		expect(transition.changed).toBe(true);
		expect(transition.previousCount).toBe(2);
		expect(transition.activated).toBe(false);
		expect(transition.deactivated).toBe(true);
		expect(transition.snapshot).toEqual(EMPTY);
		expect(registry.size()).toBe(0);
	});

	test("reset on an empty registry is harmless", () => {
		const registry = new UserWaitRegistry();
		const transition = registry.reset();
		expect(transition.changed).toBe(false);
		expect(transition.previousCount).toBe(0);
		expect(transition.deactivated).toBe(false);
		expect(transition.snapshot).toEqual(EMPTY);
	});

	test("nested waits stay active until all matching entries clear", () => {
		const registry = new UserWaitRegistry();
		registry.set({ id: "outer", owner: "safe-mode" });
		registry.set({ id: "inner", owner: "safe-mode" });

		registry.clear({ id: "inner", owner: "safe-mode" });
		expect(registry.snapshot().active).toBe(true);
		expect(registry.snapshot().count).toBe(1);

		registry.clear({ id: "outer", owner: "safe-mode" });
		expect(registry.snapshot()).toEqual(EMPTY);
	});

	test("accepts the valid kinds through set", () => {
		const registry = new UserWaitRegistry();
		for (const kind of ["approval", "input", "other"] as UserWaitKind[]) {
			const transition = registry.set({ id: kind, owner: "o", kind });
			expect(transition?.snapshot.waits.find((wait) => wait.id === kind)?.kind).toBe(kind);
		}
		expect(registry.size()).toBe(3);
	});
});
