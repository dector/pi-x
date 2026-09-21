/**
 * Global restricted-agent config loader tests.
 *
 * The loader is exercised against temporary agent directories so no real user
 * config is read or written, and so "missing file", "bad JSON", and
 * "invalid fields" paths are covered deterministically.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RESTRICTED_AGENT_CONFIG_FILE,
	loadRestrictedAgentConfig,
	restrictedAgentConfigPath,
} from "./restricted-agent-config.ts";

const tempDirs: string[] = [];

function makeAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-restricted-agent-"));
	tempDirs.push(dir);
	return dir;
}

function writeConfig(agentDir: string, contents: string): void {
	writeFileSync(restrictedAgentConfigPath(agentDir), contents);
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

describe("restrictedAgentConfigPath", () => {
	test("resolves subagent.json directly under the agent directory", () => {
		expect(restrictedAgentConfigPath("/home/user/.pi/agent")).toBe(
			join("/home/user/.pi/agent", RESTRICTED_AGENT_CONFIG_FILE),
		);
		expect(RESTRICTED_AGENT_CONFIG_FILE).toBe("subagent.json");
	});
});

describe("loadRestrictedAgentConfig", () => {
	test("missing file uses defaults", () => {
		const policy = loadRestrictedAgentConfig(makeAgentDir());
		expect(policy.restrictedAgentPatterns).toEqual(["*-strong", "*-explicit"]);
		expect(policy.restrictedAgentPromptTimeoutSeconds).toBe(15);
	});

	test("invalid JSON uses defaults", () => {
		const agentDir = makeAgentDir();
		writeConfig(agentDir, "{ not json");
		const policy = loadRestrictedAgentConfig(agentDir);
		expect(policy.restrictedAgentPatterns).toEqual(["*-strong", "*-explicit"]);
		expect(policy.restrictedAgentPromptTimeoutSeconds).toBe(15);
	});

	test("valid file is parsed", () => {
		const agentDir = makeAgentDir();
		writeConfig(
			agentDir,
			JSON.stringify({ restrictedAgentPatterns: ["special-*"], restrictedAgentPromptTimeoutSeconds: 45 }),
		);
		const policy = loadRestrictedAgentConfig(agentDir);
		expect(policy.restrictedAgentPatterns).toEqual(["special-*"]);
		expect(policy.restrictedAgentPromptTimeoutSeconds).toBe(45);
	});

	test("invalid fields fall back individually", () => {
		const agentDir = makeAgentDir();
		writeConfig(
			agentDir,
			JSON.stringify({ restrictedAgentPatterns: "nope", restrictedAgentPromptTimeoutSeconds: 30 }),
		);
		const policy = loadRestrictedAgentConfig(agentDir);
		expect(policy.restrictedAgentPatterns).toEqual(["*-strong", "*-explicit"]);
		expect(policy.restrictedAgentPromptTimeoutSeconds).toBe(30);
	});

	test("explicit empty array disables restrictions from disk", () => {
		const agentDir = makeAgentDir();
		writeConfig(agentDir, JSON.stringify({ restrictedAgentPatterns: [] }));
		expect(loadRestrictedAgentConfig(agentDir).restrictedAgentPatterns).toEqual([]);
	});
});
