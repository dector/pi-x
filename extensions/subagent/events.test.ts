import { describe, expect, test } from "bun:test";
import { applyRpcStreamEvent, emptyUsage, type RpcStreamState } from "./events.ts";
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
