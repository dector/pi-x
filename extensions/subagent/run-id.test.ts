import { expect, test } from "bun:test";
import { createRunIdGenerator } from "./run-id.ts";

const READABLE_RUN_ID = /^[a-z]+-[a-z]+-[a-z0-9]{10}$/;

test("run IDs are readable and unique within one generator", () => {
	const next = createRunIdGenerator();
	const ids = new Set(Array.from({ length: 100 }, () => next()));
	expect(ids.size).toBe(100);
	for (const id of ids) expect(id).toMatch(READABLE_RUN_ID);
});

test("run IDs stay unique across generators in one process", () => {
	const first = createRunIdGenerator();
	const firstIds = new Set(Array.from({ length: 50 }, () => first()));
	const restarted = createRunIdGenerator();
	const restartedIds = Array.from({ length: 50 }, () => restarted());

	for (const id of restartedIds) {
		expect(id).toMatch(READABLE_RUN_ID);
		expect(firstIds.has(id)).toBe(false);
	}
});

test("namespaced IDs keep a readable suffix", () => {
	const id = createRunIdGenerator("dispatch")();
	expect(id).toMatch(/^dispatch-[a-z]+-[a-z]+-[a-z0-9]{10}$/);
});
