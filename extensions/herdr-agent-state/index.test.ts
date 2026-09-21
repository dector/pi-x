import { describe, expect, test } from "bun:test";
import { HERDR_BACKGROUND_EVENT as PRODUCER_EVENT, herdrBackgroundPayload } from "../subagent/herdr-background.ts";
import { HERDR_BACKGROUND_EVENT, applyBackgroundEvent, desiredAgentState, parseBackgroundId } from "./index.ts";

describe("herdr background contract", () => {
	test("is the event the subagent extension emits", () => {
		expect(HERDR_BACKGROUND_EVENT).toBe("herdr:background");
	});
});

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

describe("desiredAgentState", () => {
	const base = { blockedCount: 0, agentActive: false, backgroundCount: 0 };

	test("is idle with no activity", () => {
		expect(desiredAgentState(base)).toEqual({ state: "idle", message: undefined });
	});

	test("is working while the agent runs", () => {
		expect(desiredAgentState({ ...base, agentActive: true })).toEqual({ state: "working", message: undefined });
	});

	test("stays working after the turn settles while background work is active", () => {
		expect(desiredAgentState({ ...base, backgroundCount: 1 })).toEqual({ state: "working", message: undefined });
		expect(desiredAgentState({ ...base, agentActive: false, backgroundCount: 3 })).toEqual({
			state: "working",
			message: undefined,
		});
	});

	test("blocked wins over working and background work", () => {
		expect(desiredAgentState({ ...base, blockedCount: 1, blockedMessage: "approve?" })).toEqual({
			state: "blocked",
			message: "approve?",
		});
		expect(desiredAgentState({ ...base, blockedCount: 2, blockedMessage: "approve?", agentActive: true, backgroundCount: 2 })).toEqual({
			state: "blocked",
			message: "approve?",
		});
	});
});

describe("subagent -> integration contract", () => {
	test("the emitted lease holds the pane working until the last dispatch settles", () => {
		expect(PRODUCER_EVENT).toBe(HERDR_BACKGROUND_EVENT);
		const background = new Set<string>();

		// A detached dispatch starts while the pane is working, then the
		// accepting turn settles (agentActive false): still working.
		expect(applyBackgroundEvent(background, herdrBackgroundPayload("dispatch-1", true))).toBe(true);
		expect(desiredAgentState({ blockedCount: 0, agentActive: false, backgroundCount: background.size }).state).toBe("working");

		// Parallel dispatch: clearing one keeps the pane working.
		applyBackgroundEvent(background, herdrBackgroundPayload("dispatch-2", true));
		applyBackgroundEvent(background, herdrBackgroundPayload("dispatch-1", false));
		expect(desiredAgentState({ blockedCount: 0, agentActive: false, backgroundCount: background.size }).state).toBe("working");

		// Last dispatch settles.
		applyBackgroundEvent(background, herdrBackgroundPayload("dispatch-2", false));
		expect(desiredAgentState({ blockedCount: 0, agentActive: false, backgroundCount: background.size }).state).toBe("idle");
	});
});
