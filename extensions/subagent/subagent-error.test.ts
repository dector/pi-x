import { describe, expect, test } from "bun:test";
import { emptyUsage } from "./events.ts";
import { formatSubagentError, subagentErrorEntry } from "./subagent-error.ts";
import type { SingleResult } from "./types.ts";

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return { agent: "scout", agentSource: "user", task: "test", runId: "run-1", exitCode: 0, messages: [], stderr: "", usage: emptyUsage(), ...overrides };
}

describe("parent subagent error entry", () => {
	test("preserves a provider error and identifies its child", () => {
		const entry = subagentErrorEntry(result({ stopReason: "error", errorMessage: "Usage limit reached" }));
		expect(entry).toEqual({ agent: "scout", runId: "run-1", message: "Usage limit reached" });
		expect(formatSubagentError(entry!)).toBe("Subagent scout [run-1] error: Usage limit reached");
	});

	test("reports child process failures, not tool errors or cancellations", () => {
		expect(subagentErrorEntry(result({ exitCode: 1, errorMessage: "RPC child exited before settling" }))?.message).toBe("RPC child exited before settling");
		expect(subagentErrorEntry(result({ toolRuns: [{ toolCallId: "bash", toolName: "bash", args: {}, status: "failed" }] }))).toBeUndefined();
		expect(subagentErrorEntry(result({ exitCode: 1, stopReason: "aborted", errorMessage: "aborted" }))).toBeUndefined();
	});
});
