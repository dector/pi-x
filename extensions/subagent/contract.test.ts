/**
 * Stage 0 backward-compatibility fixtures.
 *
 * These tests freeze the current blocking tool-result and persisted agent-log
 * shapes in `fixtures/legacy-contracts.json`. They exist so later stages that
 * add `execution`/`dispatch*` metadata keep reading old records unchanged.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { persistedAgentLogEntries } from "./agent-log.ts";
import { getFinalOutput, getResultOutput, isFailedResult } from "./result-output.ts";
import type { SubagentDetails } from "./types.ts";

interface LegacyFixture {
	subagentDetails: SubagentDetails;
	agentLogBranch: unknown[];
}

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/legacy-contracts.json", import.meta.url), "utf8"),
) as LegacyFixture;

interface FutureDispatchMetadata {
	execution: string;
	dispatchId: string;
	dispatchStatus: string;
}

function withFutureMetadata(details: SubagentDetails): SubagentDetails & FutureDispatchMetadata {
	return {
		...details,
		execution: "blocking",
		dispatchId: "dispatch-legacy",
		dispatchStatus: "completed",
	};
}

describe("legacy tool-result fixture", () => {
	test("has exactly the pre-async top-level keys", () => {
		expect(Object.keys(fixture.subagentDetails).sort()).toEqual(["agentScope", "mode", "projectAgentsDir", "results"]);
	});

	test("round-trips through JSON without loss", () => {
		expect(JSON.parse(JSON.stringify(fixture.subagentDetails))).toEqual(fixture.subagentDetails);
	});

	test("resolves output and failure status through the canonical helpers", () => {
		const [ok, failed] = fixture.subagentDetails.results;
		expect(getFinalOutput(ok?.messages)).toBe("scout output");
		expect(getResultOutput(ok ?? {})).toBe("scout output");
		expect(isFailedResult(ok ?? {})).toBe(false);
		expect(getResultOutput(failed ?? {})).toBe("boom on stderr");
		expect(isFailedResult(failed ?? {})).toBe(true);
	});
});

describe("legacy agent-log fixture", () => {
	test("extracts every result from an old persisted branch", () => {
		const entries = persistedAgentLogEntries(fixture.agentLogBranch);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			runId: "sa-legacy-1",
			agentName: "scout",
			task: "find auth code",
			output: "scout output",
			status: "completed",
			mode: "parallel",
			source: "persisted",
		});
		expect(entries[1]).toMatchObject({
			runId: "sa-legacy-2",
			agentName: "worker",
			task: "apply fix",
			output: "boom on stderr",
			status: "failed",
			mode: "parallel",
			step: 2,
			source: "persisted",
		});
	});

	test("still parses details that carry future execution metadata", () => {
		const details = withFutureMetadata(fixture.subagentDetails);
		// Future dispatch metadata lives on SubagentDetails, not on each result.
		expect(details.execution).toBe("blocking");
		expect(details.dispatchId).toBe("dispatch-legacy");
		expect(details.dispatchStatus).toBe("completed");
		for (const result of details.results) {
			expect(Object.keys(result)).not.toContain("execution");
			expect(Object.keys(result)).not.toContain("dispatchId");
		}

		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					details,
				},
			},
		];
		expect(persistedAgentLogEntries(branch)).toHaveLength(2);
	});
});
