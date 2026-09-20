import { expect, test } from "bun:test";
import { createRunIdGenerator } from "./run-id.ts";

test("run IDs are unique within one generator", () => {
	const next = createRunIdGenerator();
	const ids = new Set(Array.from({ length: 100 }, () => next()));
	expect(ids.size).toBe(100);
	for (const id of ids) expect(id.startsWith("sa-")).toBe(true);
});

test("run IDs stay unique across simulated restarts", () => {
	const first = createRunIdGenerator();
	const firstIds = new Set(Array.from({ length: 50 }, () => first()));

	// A fresh generator simulates an extension reload, new session, or process
	// restart. The old counter-only format would restart at `sa-1` and collide.
	const restarted = createRunIdGenerator();
	const restartedIds = Array.from({ length: 50 }, () => restarted());

	expect(restartedIds).not.toContain("sa-1");
	for (const id of restartedIds) expect(firstIds.has(id)).toBe(false);
});
