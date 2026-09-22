import { expect, test } from "bun:test";
import { createRunIdGenerator } from "./run-id.ts";

const AGENT_ID = /^ag_[a-z]+-[a-z]+$/;
const DISPATCH_ID = /^dp_[a-z]+-[a-z]+$/;

test("agent IDs use short animal names and stay unique in one session", () => {
	const used = new Set<string>();
	const next = createRunIdGenerator("agent", used);
	const ids = new Set(Array.from({ length: 100 }, () => next()));
	expect(ids.size).toBe(100);
	expect(used).toEqual(ids);
	for (const id of ids) expect(id).toMatch(AGENT_ID);
});

test("default generators share a process-wide uniqueness fallback", () => {
	const first = createRunIdGenerator();
	const second = createRunIdGenerator();
	const ids = new Set([...Array.from({ length: 50 }, () => first()), ...Array.from({ length: 50 }, () => second())]);
	expect(ids.size).toBe(100);
});

test("a retained session set prevents reuse after generator recreation", () => {
	const used = new Set<string>();
	const first = createRunIdGenerator("agent", used);
	const firstIds = new Set(Array.from({ length: 50 }, () => first()));
	const reloaded = createRunIdGenerator("agent", used);
	const laterIds = Array.from({ length: 50 }, () => reloaded());

	for (const id of laterIds) {
		expect(id).toMatch(AGENT_ID);
		expect(firstIds.has(id)).toBe(false);
	}
});

test("dispatch IDs use the geographic dp_ namespace without suffixes", () => {
	const id = createRunIdGenerator("dispatch", new Set())();
	expect(id).toMatch(DISPATCH_ID);
	expect(id.split("-")).toHaveLength(2);
});

test("foreign reservations do not reduce capacity and exhaustion throws", () => {
	const used = new Set(["foreign", "dp_snowy-mountain"]);
	const next = createRunIdGenerator("agent", used);
	for (let index = 0; index < 32 * 64; index += 1) expect(next()).toMatch(AGENT_ID);
	expect(() => next()).toThrow("No unused agent names remain");
});
