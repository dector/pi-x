// Git dirty totals for the status bar. Collected internally by neo-bar (it is
// the only consumer), rendered either as the plain first-line label (`legacy`
// display mode) or as the editor-frame top-right label via
// `compose.decorateBorderGitStats`.
//
// No pi runtime or TUI imports: the watcher is driven by the host extension, so
// tests can collect and format without a session.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ANSI_RESET = "\u001b[0m";
const ANSI_GREEN = "\u001b[38;5;76m";
const ANSI_RED = "\u001b[38;5;203m";
const ANSI_ORANGE = "\u001b[38;5;209m";

/** Producer palette for the git counters (also used by the border decoration). */
export const GIT_STATS_COLORS = {
	added: ANSI_GREEN,
	removed: ANSI_RED,
	modified: ANSI_ORANGE,
} as const;

/** Dirty counters: changed files by state, then changed lines. */
export interface GitStats {
	filesAdded: number;
	filesRemoved: number;
	filesModified: number;
	linesAdded: number;
	linesRemoved: number;
}

/** One read of the current repo. `isDirty: false` still reports zeroed stats. */
export interface GitSnapshot {
	repoRoot: string;
	branch: string;
	isDirty: boolean;
	stats: GitStats;
}

const CLEAN_STATS: GitStats = {
	filesAdded: 0,
	filesRemoved: 0,
	filesModified: 0,
	linesAdded: 0,
	linesRemoved: 0,
};

interface GitResult {
	ok: boolean;
	stdout: string;
}

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});

	return {
		ok: result.status === 0,
		stdout: (result.stdout ?? "").trim(),
	};
}

function getRepoRoot(cwd: string): string | undefined {
	const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!root.ok || !root.stdout) return undefined;
	return root.stdout;
}

function getBranchName(cwd: string): string | undefined {
	const symbolic = runGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
	if (symbolic.ok && symbolic.stdout) return symbolic.stdout;

	const detached = runGit(cwd, ["rev-parse", "--short", "HEAD"]);
	if (detached.ok && detached.stdout) return detached.stdout;

	return undefined;
}

function parseNumstat(stdout: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;

	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const [addRaw, removeRaw] = line.split("\t");
		if (!addRaw || !removeRaw) continue;

		const add = Number.parseInt(addRaw, 10);
		const remove = Number.parseInt(removeRaw, 10);
		if (Number.isFinite(add)) additions += add;
		if (Number.isFinite(remove)) removals += remove;
	}

	return { additions, removals };
}

function countLines(filePath: string): number {
	let buffer: Buffer;
	try {
		buffer = readFileSync(filePath);
	} catch {
		return 0;
	}

	if (buffer.length === 0) return 0;

	let newlines = 0;
	for (const byte of buffer) {
		if (byte === 10) newlines += 1; // \n
	}

	if (newlines === 0) return 1;
	const endsWithNewline = buffer[buffer.length - 1] === 10;
	return endsWithNewline ? newlines : newlines + 1;
}

function getUntrackedAdditions(repoRoot: string): number {
	const untracked = runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (!untracked.ok || !untracked.stdout) return 0;

	let additions = 0;
	for (const relative of untracked.stdout.split("\0")) {
		if (!relative) continue;
		additions += countLines(join(repoRoot, relative));
	}
	return additions;
}

function parseFileCountersFromPorcelain(stdout: string): {
	filesAdded: number;
	filesRemoved: number;
	filesModified: number;
} {
	let filesAdded = 0;
	let filesRemoved = 0;
	let filesModified = 0;

	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const x = line[0] ?? " ";
		const y = line[1] ?? " ";

		if (x === "?" && y === "?") {
			filesAdded += 1;
			continue;
		}

		if (x === "D" || y === "D") {
			filesRemoved += 1;
			continue;
		}

		if (x === "A" || y === "A") {
			filesAdded += 1;
			continue;
		}

		if (x !== " " || y !== " ") {
			filesModified += 1;
		}
	}

	return { filesAdded, filesRemoved, filesModified };
}

/**
 * Read the dirty totals for the repo containing `cwd`. Returns `undefined` when
 * `cwd` is not inside a git repo (or has no resolvable branch).
 *
 * tracked changes: `git diff --numstat HEAD`
 * untracked files: `git ls-files --others --exclude-standard -z` + line counting
 */
export function collectGitSnapshot(cwd: string): GitSnapshot | undefined {
	const repoRoot = getRepoRoot(cwd);
	if (!repoRoot) return undefined;

	const branch = getBranchName(repoRoot);
	if (!branch) return undefined;

	const status = runGit(repoRoot, ["status", "--porcelain"]);
	const isDirty = status.ok && status.stdout.length > 0;
	if (!isDirty) {
		return { repoRoot, branch, isDirty: false, stats: { ...CLEAN_STATS } };
	}

	const trackedNumstat = runGit(repoRoot, ["diff", "--numstat", "HEAD"]);
	const tracked = trackedNumstat.ok ? parseNumstat(trackedNumstat.stdout) : { additions: 0, removals: 0 };
	const untrackedAdditions = getUntrackedAdditions(repoRoot);
	const counters = status.ok
		? parseFileCountersFromPorcelain(status.stdout)
		: { filesAdded: 0, filesRemoved: 0, filesModified: 0 };

	return {
		repoRoot,
		branch,
		isDirty,
		stats: {
			filesAdded: counters.filesAdded,
			filesRemoved: counters.filesRemoved,
			filesModified: counters.filesModified,
			linesAdded: tracked.additions + untrackedAdditions,
			linesRemoved: tracked.removals,
		},
	};
}

/** The counters shown in the status bar, or `undefined` for a clean repo. */
export function dirtyStats(snapshot: GitSnapshot | undefined): GitStats | undefined {
	return snapshot?.isDirty ? snapshot.stats : undefined;
}

function colorAnsi(code: string, text: string): string {
	return `${code}${text}${ANSI_RESET}`;
}

function count(value: number | undefined): number {
	return Number.isFinite(value) ? (value as number) : 0;
}

/**
 * Plain first-line label: files first, then changed lines, joined by ` · `.
 * Counters are always rendered, including zeros, so the label has a stable width.
 *
 *   `+1 -2 M4 · +150 -200`
 */
export function renderGitStatsLabel(stats: GitStats, hasUI: boolean): string {
	const files = `+${count(stats.filesAdded)} -${count(stats.filesRemoved)} M${count(stats.filesModified)}`;
	const lines = `+${count(stats.linesAdded)} -${count(stats.linesRemoved)}`;
	if (!hasUI) return `${files} · ${lines}`;
	return `${colorAnsi(GIT_STATS_COLORS.added, `+${count(stats.filesAdded)}`)} ${colorAnsi(
		GIT_STATS_COLORS.removed,
		`-${count(stats.filesRemoved)}`,
	)} ${colorAnsi(GIT_STATS_COLORS.modified, `M${count(stats.filesModified)}`)} · ${colorAnsi(
		GIT_STATS_COLORS.added,
		`+${count(stats.linesAdded)}`,
	)} ${colorAnsi(GIT_STATS_COLORS.removed, `-${count(stats.linesRemoved)}`)}`;
}

/** Same counters as `renderGitStatsLabel`, without color codes. */
export function formatGitStatsText(stats: GitStats): string {
	return renderGitStatsLabel(stats, false);
}

const REFRESH_DEBOUNCE_MS = 120;

/**
 * Debounced dirty-counter refresh for the host extension. The host binds it to
 * the session events that can change the working tree and gets `undefined`
 * whenever the label should disappear (clean repo, no git repo).
 */
export class GitStatsWatcher {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pendingCwd: string | undefined;
	private signature: string | undefined;
	/** Live totals, or `undefined` while the repo is clean/absent. */
	current: GitStats | undefined;

	constructor(private readonly onChange: (stats: GitStats | undefined) => void) {}

	/** Queue a refresh; repeated calls inside the debounce window collapse into one. */
	schedule(cwd: string): void {
		this.pendingCwd = cwd;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const target = this.pendingCwd;
			this.pendingCwd = undefined;
			if (target !== undefined) this.refresh(target);
		}, REFRESH_DEBOUNCE_MS);
	}

	/** Collect now; notifies only when the counters actually changed. */
	refresh(cwd: string): void {
		const stats = dirtyStats(collectGitSnapshot(cwd));
		const signature = stats ? JSON.stringify(stats) : "";
		if (signature === this.signature) return;
		this.signature = signature;
		this.current = stats;
		this.onChange(stats);
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.pendingCwd = undefined;
	}
}
