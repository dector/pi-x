import { describe, expect, test } from "bun:test";
import {
	collectGitSnapshot,
	dirtyStats,
	formatGitStatsText,
	GIT_STATS_COLORS,
	GitStatsWatcher,
	renderGitStatsLabel,
} from "./git-stats.ts";

const RESET = "\u001b[0m";
const STATS = { filesAdded: 1, filesRemoved: 2, filesModified: 4, linesAdded: 150, linesRemoved: 200 };

describe("git stats labels", () => {
	test("renders files first, then changed lines", () => {
		expect(formatGitStatsText(STATS)).toBe("+1 -2 M4 · +150 -200");
	});

	test("keeps zero counters so the label width stays stable", () => {
		expect(formatGitStatsText({ filesAdded: 0, filesRemoved: 0, filesModified: 0, linesAdded: 0, linesRemoved: 0 })).toBe(
			"+0 -0 M0 · +0 -0",
		);
	});

	test("colorizes each counter group in UI mode", () => {
		expect(renderGitStatsLabel(STATS, true)).toBe(
			`${GIT_STATS_COLORS.added}+1${RESET} ${GIT_STATS_COLORS.removed}-2${RESET} ${GIT_STATS_COLORS.modified}M4${RESET} · ${GIT_STATS_COLORS.added}+150${RESET} ${GIT_STATS_COLORS.removed}-200${RESET}`,
		);
	});
});

describe("git snapshot", () => {
	test("returns undefined outside a git repo", () => {
		expect(collectGitSnapshot("/")).toBeUndefined();
	});

	test("dirtyStats drops a clean repo", () => {
		expect(dirtyStats(undefined)).toBeUndefined();
		expect(
			dirtyStats({ repoRoot: "/repo", branch: "trunk", isDirty: false, stats: { ...STATS } }),
		).toBeUndefined();
		expect(
			dirtyStats({ repoRoot: "/repo", branch: "trunk", isDirty: true, stats: { ...STATS } }),
		).toEqual(STATS);
	});
});

describe("GitStatsWatcher", () => {
	test("collapses debounced refreshes and notifies only on change", async () => {
		const seen: Array<string | undefined> = [];
		const watcher = new GitStatsWatcher((stats) => seen.push(stats));
		// A non-repo directory yields no counters, so the first notification is
		// the initial "no label" state and repeats stay silent.
		watcher.schedule("/");
		watcher.schedule("/");
		watcher.schedule("/");
		watcher.refresh("/");
		expect(seen).toEqual([undefined]);
		watcher.dispose();
	});

	test("stops notifying after dispose", () => {
		let calls = 0;
		const watcher = new GitStatsWatcher(() => {
			calls += 1;
		});
		watcher.refresh("/");
		const before = calls;
		watcher.schedule("/");
		watcher.dispose();
		expect(calls).toBe(before);
	});
});
