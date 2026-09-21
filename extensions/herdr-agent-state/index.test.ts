import { describe, expect, test } from "bun:test";
import { applyBackgroundEvent, parseBackgroundId } from "./index.ts";

describe("parseBackgroundId", () => {
	test("accepts a bounded non-empty string", () => {
		expect(parseBackgroundId("px:subagent")).toBe("px:subagent");
		expect(parseBackgroundId("a".repeat(128))).toHaveLength(128);
	});

	test("rejects anything that is not a bounded non-empty string", () => {
		expect(parseBackgroundId(undefined)).toBeUndefined();
		expect(parseBackgroundId(null)).toBeUndefined();
		expect(parseBackgroundId("")).toBeUndefined();
		expect(parseBackgroundId("a".repeat(129))).toBeUndefined();
		expect(parseBackgroundId(42)).toBeUndefined();
		expect(parseBackgroundId({})).toBeUndefined();
	});
});

describe("applyBackgroundEvent", () => {
	test("adds on active true and removes on active false", () => {
		const background = new Set<string>();

		expect(applyBackgroundEvent(background, { id: "a", active: true })).toBe(true);
		expect([...background]).toEqual(["a"]);

		expect(applyBackgroundEvent(background, { id: "a", active: false })).toBe(true);
		expect(background.size).toBe(0);
	});

	test("tracks concurrent ids independently", () => {
		const background = new Set<string>();

		expect(applyBackgroundEvent(background, { id: "a", active: true })).toBe(true);
		expect(applyBackgroundEvent(background, { id: "b", active: true })).toBe(true);
		expect(background.size).toBe(2);

		// Clearing one leaves the other holding the working state.
		expect(applyBackgroundEvent(background, { id: "a", active: false })).toBe(true);
		expect([...background]).toEqual(["b"]);
	});

	test("is idempotent", () => {
		const background = new Set<string>();

		expect(applyBackgroundEvent(background, { id: "a", active: true })).toBe(true);
		expect(applyBackgroundEvent(background, { id: "a", active: true })).toBe(false);
		expect(applyBackgroundEvent(background, { id: "a", active: false })).toBe(true);
		expect(applyBackgroundEvent(background, { id: "a", active: false })).toBe(false);
		expect(background.size).toBe(0);
	});

	test("ignores malformed payloads", () => {
		const background = new Set<string>();

		for (const payload of [undefined, null, "a", 42, {}, { id: "a" }, { id: "", active: true }, { id: "a", active: "yes" }]) {
			expect(applyBackgroundEvent(background, payload)).toBe(false);
		}
		expect(background.size).toBe(0);
	});
});
