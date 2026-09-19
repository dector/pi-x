import { describe, expect, test } from "bun:test";
import {
	applyRpcStreamEvent,
	emptyUsage,
	interruptActiveTools,
	setLatestToolApprovalState,
	type RpcStreamState,
} from "./events.ts";
import type { SingleResult } from "./types.ts";

function result(): SingleResult {
	return { agent: "scout", agentSource: "user", task: "test", exitCode: 0, messages: [], stderr: "", usage: emptyUsage() };
}

describe("RPC event mapping", () => {
	test("uses finalized messages as authoritative and aggregates usage", () => {
		const current = result();
		const state: RpcStreamState = { liveText: "", settled: false };
		applyRpcStreamEvent(current, state, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "partial" },
		});
		expect(state.liveText).toBe("partial");
		applyRpcStreamEvent(current, state, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "final" }],
				usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7, cost: { total: 0.02 } },
			},
		});
		expect(state.liveText).toBe("");
		expect(current.messages).toHaveLength(1);
		expect(current.usage).toMatchObject({ input: 4, output: 2, cacheRead: 1, cost: 0.02, contextTokens: 7, turns: 1 });
	});

	test("tracks successful, blocked, failed, and interrupted tool outcomes", () => {
		const current = result();
		const state: RpcStreamState = { liveText: "", settled: false };
		applyRpcStreamEvent(current, state, { type: "tool_execution_start", toolCallId: "ok", toolName: "read", args: { path: "a" } });
		applyRpcStreamEvent(current, state, { type: "tool_execution_end", toolCallId: "ok", toolName: "read", result: { content: [{ type: "text", text: "contents" }] }, isError: false });
		applyRpcStreamEvent(current, state, { type: "tool_execution_start", toolCallId: "blocked", toolName: "bash", args: { command: "rm x" } });
		setLatestToolApprovalState(current, "waiting");
		expect(current.toolRuns?.[1].status).toBe("waiting-approval");
		setLatestToolApprovalState(current, "approved");
		expect(current.toolRuns?.[1].status).toBe("approved");
		setLatestToolApprovalState(current, "waiting");
		setLatestToolApprovalState(current, "denied");
		applyRpcStreamEvent(current, state, { type: "tool_execution_end", toolCallId: "blocked", toolName: "bash", result: { content: [{ type: "text", text: "Blocked by user" }] }, isError: true });
		applyRpcStreamEvent(current, state, { type: "tool_execution_start", toolCallId: "failed", toolName: "read", args: {} });
		applyRpcStreamEvent(current, state, { type: "tool_execution_end", toolCallId: "failed", toolName: "read", result: { content: [{ type: "text", text: "ENOENT" }] }, isError: true });
		applyRpcStreamEvent(current, state, { type: "tool_execution_start", toolCallId: "stuck", toolName: "bash", args: {} });
		interruptActiveTools(current);
		expect(current.toolRuns?.map((run) => run.status)).toEqual(["completed", "blocked", "failed", "interrupted"]);
		expect(current.toolRuns?.[1].summary).toBe("Blocked by user");
		expect(current.toolRuns?.[2].summary).toBe("ENOENT");
	});

	test("settles only on a terminal agent end", () => {
		const current = result();
		const state: RpcStreamState = { liveText: "", settled: false };
		applyRpcStreamEvent(current, state, { type: "agent_end", willRetry: true });
		expect(state.settled).toBe(false);
		applyRpcStreamEvent(current, state, { type: "agent_end", willRetry: false });
		expect(state.settled).toBe(true);
		expect(current.state).toBe("settled");
	});
});
