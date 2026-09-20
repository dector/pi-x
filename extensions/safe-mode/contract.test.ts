import { describe, expect, test } from "bun:test";
import {
	parseSafeModeSnapshot,
	parseSafeModeStateRequest,
	parseSafeModeStateResponse,
	parseSafeModeStateSet,
	parseToolAuthorized,
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

	test("parses only narrowly valid tool authorization handoffs", () => {
		expect(parseToolAuthorized({ toolCallId: "call-1", toolName: "http" })).toEqual({
			toolCallId: "call-1",
			toolName: "http",
		});
		expect(
			parseToolAuthorized({ toolCallId: "call-1", toolName: "http", source: "safe-mode" }),
		).toEqual({ toolCallId: "call-1", toolName: "http", source: "safe-mode" });

		for (const value of [
			null,
			{},
			{ toolCallId: "", toolName: "http" },
			{ toolCallId: "call-1" },
			{ toolCallId: "call-1", toolName: "" },
			{ toolCallId: "call-1", toolName: "http", source: 42 },
			{ toolCallId: 42, toolName: "http" },
		]) {
			expect(parseToolAuthorized(value)).toBeUndefined();
		}
	});
});
