import { describe, expect, test } from "bun:test";
import {
	countLoadedSkills,
	countSessionSkills,
	getReadToolPath,
	renderSkillStatsLabel,
	SKILL_STATS_ICON,
	SkillStatsTracker,
} from "./skill-stats.ts";

function makeTracker() {
	const seen: Array<{ read: number; loaded: number }> = [];
	const tracker = new SkillStatsTracker((stats) => seen.push(stats));
	return { tracker, seen };
}

describe("skill stats label", () => {
	test("prefixes the skills icon with the read/loaded counters", () => {
		expect(renderSkillStatsLabel({ read: 2, loaded: 7 }, false)).toBe(`${SKILL_STATS_ICON}2/7`);
	});

	test("grays the label in UI mode", () => {
		expect(renderSkillStatsLabel({ read: 0, loaded: 3 }, true)).toBe(
			`\u001b[90m${SKILL_STATS_ICON}0/3\u001b[0m`,
		);
	});
});

describe("loaded skill counting", () => {
	test("reads the skills array from system prompt options", () => {
		expect(countLoadedSkills({ skills: [1, 2, 3] })).toBe(3);
		expect(countLoadedSkills({ skills: "nope" })).toBe(0);
		expect(countLoadedSkills(undefined)).toBe(0);
	});

	test("falls back to zero when the host has no accessor", () => {
		expect(countSessionSkills({})).toBe(0);
		expect(countSessionSkills({ getSystemPromptOptions: () => ({ skills: [1] }) })).toBe(1);
	});
});

describe("getReadToolPath", () => {
	test("accepts only non-empty string paths", () => {
		expect(getReadToolPath({ path: "/a/SKILL.md" })).toBe("/a/SKILL.md");
		expect(getReadToolPath({ path: "   " })).toBeUndefined();
		expect(getReadToolPath({ path: 3 })).toBeUndefined();
		expect(getReadToolPath(undefined)).toBeUndefined();
	});
});

describe("SkillStatsTracker", () => {
	test("counts unique successful SKILL.md reads, resolving relative paths", () => {
		const { tracker, seen } = makeTracker();
		tracker.startSession(2);
		tracker.recordRead({ toolName: "read", isError: false, input: { path: "docs/SKILL.md" }, cwd: "/repo" });
		tracker.recordRead({ toolName: "read", isError: false, input: { path: "/repo/docs/SKILL.md" }, cwd: "/other" });
		expect(tracker.snapshot()).toEqual({ read: 1, loaded: 2 });
		expect(tracker.readPathsList()).toEqual(["/repo/docs/SKILL.md"]);
		// One notification for the session start, one for the single new path.
		expect(seen).toEqual([
			{ read: 0, loaded: 2 },
			{ read: 1, loaded: 2 },
		]);
	});

	test("ignores errors, other tools, and non-skill reads", () => {
		const { tracker, seen } = makeTracker();
		tracker.startSession(1);
		tracker.recordRead({ toolName: "read", isError: true, input: { path: "a/SKILL.md" }, cwd: "/repo" });
		tracker.recordRead({ toolName: "write", isError: false, input: { path: "a/SKILL.md" }, cwd: "/repo" });
		tracker.recordRead({ toolName: "read", isError: false, input: { path: "a/README.md" }, cwd: "/repo" });
		tracker.recordRead({ toolName: "read", isError: false, input: {}, cwd: "/repo" });
		expect(tracker.snapshot()).toEqual({ read: 0, loaded: 1 });
		expect(seen).toHaveLength(1);
	});

	test("refreshes the denominator and notifies only when it changes", () => {
		const { tracker, seen } = makeTracker();
		tracker.startSession(1);
		tracker.setLoaded(4);
		tracker.setLoaded(4);
		expect(tracker.snapshot()).toEqual({ read: 0, loaded: 4 });
		expect(seen).toEqual([
			{ read: 0, loaded: 1 },
			{ read: 0, loaded: 4 },
		]);
	});

	test("reset clears the session and lets the next start publish again", () => {
		const { tracker, seen } = makeTracker();
		tracker.startSession(1);
		tracker.recordRead({ toolName: "read", isError: false, input: { path: "a/SKILL.md" }, cwd: "/repo" });
		tracker.reset();
		expect(tracker.snapshot()).toEqual({ read: 0, loaded: 0 });
		expect(tracker.readPathsList()).toEqual([]);
		tracker.startSession(2);
		expect(seen).toEqual([
			{ read: 0, loaded: 1 },
			{ read: 1, loaded: 1 },
			{ read: 0, loaded: 2 },
		]);
	});
});
