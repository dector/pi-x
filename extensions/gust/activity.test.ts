import { expect, test } from "bun:test";
import { appendActivity, ACTIVITY_MAX_CHARS, ACTIVITY_MAX_ENTRIES, parseActivity, type ThreadActivity } from "./activity.ts";

test("RPC parser streams only visible assistant text", () => {
	expect(parseActivity({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } })).toEqual({ kind: "text", text: "hello" });
	expect(parseActivity({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret" } })).toBeUndefined();
	expect(parseActivity({ type: "message_end", message: { content: [{ type: "thinking", thinking: "secret" }] } })).toBeUndefined();
	expect(parseActivity("not json")).toBeUndefined();
});

test("RPC parser captures tool arguments, text results and errors", () => {
	expect(parseActivity({ type: "tool_execution_start", toolName: "read", args: { path: "test" } })?.text).toBe('read {"path":"test"}');
	expect(parseActivity({ type: "tool_execution_end", toolName: "read", result: { content: [{ type: "text", text: "result" }, { type: "thinking", text: "secret" }] } })?.text).toBe("read: result");
	expect(parseActivity({ type: "tool_execution_end", isError: true, result: { content: [{ type: "text", text: "ENOENT" }] } })?.kind).toBe("error");
	expect(parseActivity({ type: "response", success: false, error: "rejected" })?.text).toBe("rejected");
	expect(parseActivity({ type: "message_end", message: { role: "assistant", errorMessage: "API failed" } })?.text).toBe("API failed");
});

test("history is bounded and text deltas coalesce", () => {
	const history: ThreadActivity = { state: "running", entries: [] };
	appendActivity(history, { kind: "text", text: "a" });
	appendActivity(history, { kind: "text", text: "b" });
	expect(history.entries).toEqual([{ kind: "text", text: "ab" }]);
	for (let i = 0; i < 1000; i++) appendActivity(history, { kind: "tool", text: `${i} ` + "x".repeat(200) });
	expect(history.entries.length).toBeLessThanOrEqual(ACTIVITY_MAX_ENTRIES);
	expect(history.entries.reduce((sum, entry) => sum + entry.text.length, 0)).toBeLessThanOrEqual(ACTIVITY_MAX_CHARS);
	appendActivity(history, { kind: "text", text: "x".repeat(ACTIVITY_MAX_CHARS * 2) });
	expect(history.entries.length).toBe(1);
});
