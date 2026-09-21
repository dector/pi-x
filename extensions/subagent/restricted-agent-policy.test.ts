/**
 * Pure restricted-agent policy tests.
 *
 * Covers the shipped defaults, glob matching, stable/deduped request
 * collection, family/tier ranking, alternative suggestions, and config parsing.
 */

import { describe, expect, test } from "bun:test";
import {
	AGENT_TIER_SUFFIXES,
	DEFAULT_RESTRICTED_AGENT_PATTERNS,
	DEFAULT_RESTRICTED_AGENT_PROMPT_TIMEOUT_SECONDS,
	agentFamily,
	agentTierRank,
	collectRestrictedAgentNames,
	defaultRestrictedAgentPolicy,
	isAgentNameRestricted,
	matchesRestrictedPattern,
	parseRestrictedAgentConfig,
	suggestUnrestrictedAgents,
} from "./restricted-agent-policy.ts";

/** Shipped profile names, in discovery order. */
const SHIPPED_AGENTS = [
	"planner-fast",
	"planner-strong",
	"planner-ultra-explicit",
	"researcher-fast",
	"researcher-strong",
	"reviewer-fast",
	"reviewer-strong",
	"reviewer-ultra-explicit",
	"reviewer-xfast",
	"reviewer-xultra-explicit",
	"scout-fast",
	"scout-xfast",
	"worker-fast",
	"worker-strong-explicit",
	"worker-xfast",
].map((name) => ({ name }));

describe("defaults", () => {
	test("restrict strong and explicit tiers", () => {
		const policy = defaultRestrictedAgentPolicy();
		expect(policy.restrictedAgentPatterns).toEqual(["*-strong", "*-explicit"]);
		expect(policy.restrictedAgentPromptTimeoutSeconds).toBe(15);
		expect(DEFAULT_RESTRICTED_AGENT_PATTERNS).toEqual(["*-strong", "*-explicit"]);
		expect(DEFAULT_RESTRICTED_AGENT_PROMPT_TIMEOUT_SECONDS).toBe(15);
	});

	test("return a fresh patterns array each call", () => {
		const first = defaultRestrictedAgentPolicy();
		first.restrictedAgentPatterns.push("*-custom");
		expect(defaultRestrictedAgentPolicy().restrictedAgentPatterns).toEqual(["*-strong", "*-explicit"]);
	});
});

describe("glob matching", () => {
	test("default patterns match the intended explicit profiles", () => {
		for (const name of ["reviewer-ultra-explicit", "reviewer-xultra-explicit", "worker-strong-explicit"]) {
			expect(isAgentNameRestricted(name, DEFAULT_RESTRICTED_AGENT_PATTERNS)).toBe(true);
		}
	});

	test("*-strong matches strong tiers but not strong-explicit", () => {
		expect(isAgentNameRestricted("reviewer-strong", DEFAULT_RESTRICTED_AGENT_PATTERNS)).toBe(true);
		expect(isAgentNameRestricted("planner-strong", DEFAULT_RESTRICTED_AGENT_PATTERNS)).toBe(true);
		expect(isAgentNameRestricted("reviewer-strong", ["*-strong"])).toBe(true);
		expect(isAgentNameRestricted("worker-strong-explicit", ["*-strong"])).toBe(false);
	});

	test("unrestricted profiles do not match", () => {
		for (const name of ["reviewer-fast", "reviewer-xfast", "scout-xfast", "worker", "reviewer"]) {
			expect(isAgentNameRestricted(name, DEFAULT_RESTRICTED_AGENT_PATTERNS)).toBe(false);
		}
	});

	test("empty patterns disable restrictions", () => {
		expect(isAgentNameRestricted("reviewer-ultra-explicit", [])).toBe(false);
	});

	test("? matches exactly one character and regex metacharacters are literal", () => {
		expect(matchesRestrictedPattern("worker-a", "worker-?")).toBe(true);
		expect(matchesRestrictedPattern("worker-ab", "worker-?")).toBe(false);
		expect(matchesRestrictedPattern("a.b", "a.b")).toBe(true);
		expect(matchesRestrictedPattern("axb", "a.b")).toBe(false);
	});
});

describe("collecting requested names", () => {
	test("keeps first occurrence order and dedupes", () => {
		const collected = collectRestrictedAgentNames(
			[
				"reviewer-ultra-explicit",
				"worker-fast",
				"worker-strong-explicit",
				"reviewer-ultra-explicit",
				"reviewer-strong",
			],
			DEFAULT_RESTRICTED_AGENT_PATTERNS,
		);
		expect(collected).toEqual(["reviewer-ultra-explicit", "worker-strong-explicit", "reviewer-strong"]);
	});

	test("ignores unrestricted names and handles empty input", () => {
		expect(collectRestrictedAgentNames(["reviewer-fast", "scout"], DEFAULT_RESTRICTED_AGENT_PATTERNS)).toEqual([]);
		expect(collectRestrictedAgentNames([], DEFAULT_RESTRICTED_AGENT_PATTERNS)).toEqual([]);
	});

	test("returns nothing when restrictions are disabled", () => {
		expect(collectRestrictedAgentNames(["reviewer-ultra-explicit"], [])).toEqual([]);
	});
});

describe("family and tier ranking", () => {
	test("strips the longest matching tier suffix", () => {
		expect(agentFamily("reviewer-xultra-explicit")).toBe("reviewer");
		expect(agentFamily("reviewer-ultra-explicit")).toBe("reviewer");
		expect(agentFamily("worker-strong-explicit")).toBe("worker");
		expect(agentFamily("reviewer-xfast")).toBe("reviewer");
		expect(agentFamily("reviewer")).toBe("reviewer");
	});

	test("ranks known tier suffixes in the documented order", () => {
		expect(AGENT_TIER_SUFFIXES).toEqual([
			"xfast",
			"fast",
			"strong",
			"strong-explicit",
			"ultra-explicit",
			"xultra-explicit",
		]);
		expect(agentTierRank("reviewer-xfast")).toBe(0);
		expect(agentTierRank("reviewer-fast")).toBe(1);
		expect(agentTierRank("reviewer-strong")).toBe(2);
		expect(agentTierRank("worker-strong-explicit")).toBe(3);
		expect(agentTierRank("reviewer-ultra-explicit")).toBe(4);
		expect(agentTierRank("reviewer-xultra-explicit")).toBe(5);
		expect(agentTierRank("reviewer")).toBeUndefined();
	});
});

describe("suggesting unrestricted alternatives", () => {
	test("puts same-family agents first, ordered by tier", () => {
		expect(suggestUnrestrictedAgents("reviewer-ultra-explicit", SHIPPED_AGENTS, DEFAULT_RESTRICTED_AGENT_PATTERNS)).toEqual([
			"reviewer-xfast",
			"reviewer-fast",
			"planner-fast",
			"researcher-fast",
			"scout-fast",
			"scout-xfast",
			"worker-fast",
			"worker-xfast",
		]);
	});

	test("dedupes discovery entries and never suggests the requested name", () => {
		const agents = [{ name: "reviewer-fast" }, { name: "reviewer-fast" }, { name: "reviewer-ultra-explicit" }, { name: "scout" }];
		expect(suggestUnrestrictedAgents("reviewer-ultra-explicit", agents, DEFAULT_RESTRICTED_AGENT_PATTERNS)).toEqual([
			"reviewer-fast",
			"scout",
		]);
	});

	test("returns other agents in discovery order when no family matches", () => {
		const agents = [{ name: "scout-xfast" }, { name: "worker-fast" }, { name: "scout-fast" }];
		expect(suggestUnrestrictedAgents("reviewer-ultra-explicit", agents, DEFAULT_RESTRICTED_AGENT_PATTERNS)).toEqual([
			"scout-xfast",
			"worker-fast",
			"scout-fast",
		]);
	});

	test("ranks newly allowed strong tiers after fast tiers when patterns change", () => {
		const agents = [{ name: "reviewer-strong" }, { name: "reviewer-fast" }, { name: "reviewer-xfast" }];
		expect(suggestUnrestrictedAgents("reviewer-ultra-explicit", agents, ["*-explicit"])).toEqual([
			"reviewer-xfast",
			"reviewer-fast",
			"reviewer-strong",
		]);
	});

	test("suggests everything unrestricted when restrictions are disabled", () => {
		const agents = [{ name: "reviewer-xfast" }, { name: "planner-ultra-explicit" }, { name: "planner-fast" }];
		expect(suggestUnrestrictedAgents("reviewer-ultra-explicit", agents, [])).toEqual([
			"reviewer-xfast",
			"planner-ultra-explicit",
			"planner-fast",
		]);
	});
});

describe("parsing config", () => {
	test("missing or malformed values use defaults", () => {
		for (const value of [undefined, null, "nope", 42, [], true]) {
			const policy = parseRestrictedAgentConfig(value);
			expect(policy.restrictedAgentPatterns).toEqual(["*-strong", "*-explicit"]);
			expect(policy.restrictedAgentPromptTimeoutSeconds).toBe(15);
		}
	});

	test("empty object uses defaults", () => {
		const policy = parseRestrictedAgentConfig({});
		expect(policy.restrictedAgentPatterns).toEqual(["*-strong", "*-explicit"]);
		expect(policy.restrictedAgentPromptTimeoutSeconds).toBe(15);
	});

	test("reads valid fields", () => {
		const policy = parseRestrictedAgentConfig({
			restrictedAgentPatterns: ["*-explicit", "special-*"],
			restrictedAgentPromptTimeoutSeconds: 30,
		});
		expect(policy.restrictedAgentPatterns).toEqual(["*-explicit", "special-*"]);
		expect(policy.restrictedAgentPromptTimeoutSeconds).toBe(30);
	});

	test("explicit empty array disables restrictions", () => {
		const policy = parseRestrictedAgentConfig({ restrictedAgentPatterns: [] });
		expect(policy.restrictedAgentPatterns).toEqual([]);
	});

	test("trims pattern entries", () => {
		const policy = parseRestrictedAgentConfig({ restrictedAgentPatterns: ["  *-explicit  "] });
		expect(policy.restrictedAgentPatterns).toEqual(["*-explicit"]);
	});

	test("invalid pattern field falls back without discarding a valid timeout", () => {
		for (const patterns of ["*-strong", [""], ["  "], ["ok", 3], [null]]) {
			const policy = parseRestrictedAgentConfig({
				restrictedAgentPatterns: patterns,
				restrictedAgentPromptTimeoutSeconds: 20,
			});
			expect(policy.restrictedAgentPatterns).toEqual(["*-strong", "*-explicit"]);
			expect(policy.restrictedAgentPromptTimeoutSeconds).toBe(20);
		}
	});

	test("invalid timeout falls back without discarding valid patterns", () => {
		for (const timeout of [undefined, null, "15", 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const policy = parseRestrictedAgentConfig({
				restrictedAgentPatterns: ["special-*"],
				restrictedAgentPromptTimeoutSeconds: timeout,
			});
			expect(policy.restrictedAgentPatterns).toEqual(["special-*"]);
			expect(policy.restrictedAgentPromptTimeoutSeconds).toBe(15);
		}
	});

	test("accepts a positive fractional timeout", () => {
		const policy = parseRestrictedAgentConfig({ restrictedAgentPromptTimeoutSeconds: 2.5 });
		expect(policy.restrictedAgentPromptTimeoutSeconds).toBe(2.5);
	});
});
