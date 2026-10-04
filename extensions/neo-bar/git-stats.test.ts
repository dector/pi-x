import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	collectGitSnapshot,
	dirtyStats,
	formatGitStatsText,
	GIT_STATS_COLORS,
	GitStatsWatcher,
	GIT_STATS_CACHE_MS,
	UNTRACKED_SCAN_LIMITS,
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


function withRepo(run: (root: string, git: (...args: string[]) => void) => void) {
	const root = mkdtempSync(join(tmpdir(), "neo-bar-git-"));
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr);
	};
	try {
		git("init", "-q");
		git("config", "user.name", "Test");
		git("config", "user.email", "test@example.invalid");
		writeFileSync(join(root, "tracked"), "old\n");
		git("add", ".");
		git("commit", "-qm", "initial");
		run(root, git);
	} finally { rmSync(root, { recursive: true, force: true }); }
}

test("collects tracked changes exactly and handles NUL-delimited unusual paths", () => {
	withRepo((root, git) => {
		writeFileSync(join(root, "tracked"), "new\nsecond\n");
		git("add", "tracked");
		writeFileSync(join(root, "tracked"), "new\nsecond\nthird\n");
		mkdirSync(join(root, "dir"));
		writeFileSync(join(root, "dir", " leading\ntrailing "), "one\ntwo");
		writeFileSync(join(root, "empty"), "");
		writeFileSync(join(root, "renamed\nfile"), "rename\n");
		git("add", "renamed\nfile");
		git("commit", "-qm", "add rename source");
		git("mv", "renamed\nfile", "destination\nfile");
		const snapshot = collectGitSnapshot(root)!;
		expect(snapshot.stats).toEqual({ filesAdded: 2, filesRemoved: 0, filesModified: 2, linesAdded: 3, linesRemoved: 0 });
		expect(snapshot.untrackedLinesCapped).toBe(false);
	});
});

test("caps untracked file count without truncating tracked/file totals", () => {
	withRepo((root) => {
		writeFileSync(join(root, "tracked"), "replacement\nextra\n");
		for (let i = 0; i < UNTRACKED_SCAN_LIMITS.files + 5; i++) writeFileSync(join(root, `u${i}`), "line\n");
		const snapshot = collectGitSnapshot(root)!;
		expect(snapshot.stats).toEqual({ filesAdded: 105, filesRemoved: 0, filesModified: 1, linesAdded: 102, linesRemoved: 1 });
		expect(snapshot.untrackedLinesCapped).toBe(true);
	});
});

test("caps per-file and total bytes and skips symlinks", () => {
	withRepo((root) => {
		for (let i = 0; i < 6; i++) writeFileSync(join(root, `big${i}`), "\n".repeat(UNTRACKED_SCAN_LIMITS.fileBytes + 10));
		const snapshot = collectGitSnapshot(root)!;
		expect(snapshot.stats.filesAdded).toBe(6);
		expect(snapshot.stats.linesAdded).toBe(UNTRACKED_SCAN_LIMITS.totalBytes);
		expect(snapshot.untrackedLinesCapped).toBe(true);
	});
	withRepo((root) => {
		writeFileSync(join(root, "fragment"), "x".repeat(UNTRACKED_SCAN_LIMITS.fileBytes + 1));
		symlinkSync("tracked", join(root, "link"));
		const snapshot = collectGitSnapshot(root)!;
		expect(snapshot.stats.filesAdded).toBe(2);
		expect(snapshot.stats.linesAdded).toBe(0);
		expect(snapshot.untrackedLinesCapped).toBe(true);
	});
});

test("supports tracked additions on an unborn branch", () => {
	withRepo((root, git) => {
		git("checkout", "--orphan", "unborn");
		const snapshot = collectGitSnapshot(root)!;
		expect(snapshot.stats.filesAdded).toBe(1);
		expect(snapshot.stats.linesAdded).toBe(1);
	});
});

test("watcher caches by cwd and invalidates on TTL, explicit invalidation and dispose", () => {
	let now = 0;
	let calls = 0;
	const seen: any[] = [];
	const watcher = new GitStatsWatcher((stats) => seen.push(stats), (cwd) => {
		calls++;
		return { repoRoot: cwd, branch: "main", isDirty: true, stats: { ...STATS, filesAdded: calls } };
	}, () => now);
	watcher.refresh("/a");
	watcher.refresh("/a");
	expect(calls).toBe(1);
	expect(seen).toHaveLength(1);
	now = GIT_STATS_CACHE_MS;
	watcher.refresh("/a");
	expect(calls).toBe(2);
	watcher.refresh("/b");
	expect(calls).toBe(3);
	watcher.invalidate();
	watcher.refresh("/b");
	expect(calls).toBe(4);
	watcher.dispose();
	watcher.refresh("/b");
	expect(calls).toBe(5);
	watcher.dispose();
});

test("cached no-repo results expire and scheduled changes are collected at expiry", async () => {
	let now = 0;
	let calls = 0;
	const watcher = new GitStatsWatcher(() => {}, () => { calls++; return undefined; }, () => now);
	watcher.refresh("/");
	now = GIT_STATS_CACHE_MS - 10;
	watcher.schedule("/");
	watcher.schedule("/");
	expect(calls).toBe(1);
	now = GIT_STATS_CACHE_MS;
	await new Promise((resolve) => setTimeout(resolve, 160));
	expect(calls).toBe(2);
	watcher.dispose();
});


test("tracked line totals are never subject to untracked content caps", () => {
	withRepo((root) => {
		const lines = UNTRACKED_SCAN_LIMITS.totalBytes + 1;
		writeFileSync(join(root, "tracked"), "\n".repeat(lines));
		const snapshot = collectGitSnapshot(root)!;
		expect(snapshot.stats.linesAdded).toBe(lines);
		expect(snapshot.stats.linesRemoved).toBe(1);
		expect(snapshot.untrackedLinesCapped).toBe(false);
	});
});
