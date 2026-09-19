import { describe, expect, test } from "bun:test";
import {
	parseSafeModeSnapshot,
	parseSafeModeStateRequest,
	parseSafeModeStateResponse,
	parseSafeModeStateSet,
} from "./contract.ts";

describe("safe-mode state contract", () => {
	test("accepts valid snapshots and messages", () => {
		expect(parseSafeModeSnapshot({ mode: "smart", outerAccess: false })).toEqual({
			mode: "smart",
			outerAccess: false,
		});
		expect(parseSafeModeStateRequest({ id: "request-1" })).toEqual({ id: "request-1" });
		expect(
			parseSafeModeStateResponse({ id: "request-1", state: { mode: "reader", outerAccess: true } }),
		).toEqual({ id: "request-1", state: { mode: "reader", outerAccess: true } });
		expect(
			parseSafeModeStateSet({
				state: { mode: "yolo", outerAccess: true },
				source: "subagent-child-control",
			}),
		).toEqual({
			state: { mode: "yolo", outerAccess: true },
			source: "subagent-child-control",
		});
	});

	test("rejects malformed messages", () => {
		for (const value of [
			null,
			{},
			{ mode: "invalid", outerAccess: false },
			{ mode: "smart", outerAccess: "false" },
		]) {
			expect(parseSafeModeSnapshot(value)).toBeUndefined();
		}
		expect(parseSafeModeStateRequest({ id: "" })).toBeUndefined();
		expect(parseSafeModeStateResponse({ id: "r", state: { mode: "smart" } })).toBeUndefined();
		expect(
			parseSafeModeStateSet({ state: { mode: "smart", outerAccess: false }, source: 123 }),
		).toBeUndefined();
	});
});
