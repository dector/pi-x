// Git dirty totals for the status bar. Collected internally by neo-bar (it is
// the only consumer), rendered either as the plain first-line label (`legacy`
// display mode) or as the editor-frame top-right label via
// `compose.decorateBorderGitStats`.
//
// No pi runtime or TUI imports: the watcher is driven by the host extension, so
// tests can collect and format without a session.

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
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
	/** Untracked line totals are a lower bound when content scanning hit a limit. */
	untrackedLinesCapped?: boolean;
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
		timeout: 5_000,
		maxBuffer: 16 * 1024 * 1024,
	});

	return {
		ok: result.status === 0 && !result.error,
		stdout: result.stdout ?? "",
	};
}

function getRepoRoot(cwd: string): string | undefined {
	const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!root.ok || !root.stdout) return undefined;
	return root.stdout.trim();
}

function getBranchName(cwd: string): string | undefined {
	const symbolic = runGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
	if (symbolic.ok && symbolic.stdout) return symbolic.stdout.trim();

	const detached = runGit(cwd, ["rev-parse", "--short", "HEAD"]);
	if (detached.ok && detached.stdout) return detached.stdout.trim();

	return undefined;
}

function parseNumstat(stdout: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;

	const records = stdout.split("\0");
	for (let index = 0; index < records.length; index++) {
		const line = records[index];
		if (!line) continue;
		const [addRaw, removeRaw, path] = line.split("\t");
		if (path === "") index += 2; // NUL-delimited rename source/destination
		if (!addRaw || !removeRaw) continue;

		const add = Number.parseInt(addRaw, 10);
		const remove = Number.parseInt(removeRaw, 10);
		if (Number.isFinite(add)) additions += add;
		if (Number.isFinite(remove)) removals += remove;
	}

	return { additions, removals };
}

/** Bound content I/O, not Git's enumeration (file counters remain exact). */
export const UNTRACKED_SCAN_LIMITS = { files: 100, fileBytes: 256 * 1024, totalBytes: 1024 * 1024 } as const;

function getUntrackedAdditions(repoRoot: string, paths: string[]): { additions: number; capped: boolean } {
	if (paths.length === 0) return { additions: 0, capped: false };
	let additions = 0;
	let bytesLeft: number = UNTRACKED_SCAN_LIMITS.totalBytes;
	let capped = paths.length > UNTRACKED_SCAN_LIMITS.files;
	const buffer = Buffer.alloc(UNTRACKED_SCAN_LIMITS.fileBytes);
	for (const relative of paths.slice(0, UNTRACKED_SCAN_LIMITS.files)) {
		if (bytesLeft <= 0) { capped = true; break; }
		let fd: number | undefined;
		try {
			// Never follow symlinks or block on special files such as FIFOs.
			fd = openSync(join(repoRoot, relative), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
			const stat = fstatSync(fd);
			if (!stat.isFile()) { capped = true; continue; }
			const limit = Math.min(stat.size, buffer.length, bytesLeft);
			let length = 0;
			while (length < limit) {
				const read = readSync(fd, buffer, length, limit - length, length);
				if (!read) break;
				length += read;
			}
			bytesLeft -= length;
			const complete = length === stat.size;
			if (!complete) capped = true;
			for (let i = 0; i < length; i++) if (buffer[i] === 10) additions++;
			if (complete && length > 0 && buffer[length - 1] !== 10) additions++;
		} catch {
			capped = true;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	return { additions, capped };
}

function parseFileCountersFromPorcelain(stdout: string): {
	filesAdded: number;
	filesRemoved: number;
	filesModified: number;
	untracked: string[];
} {
	const untracked: string[] = [];
	let filesAdded = 0;
	let filesRemoved = 0;
	let filesModified = 0;

	const records = stdout.split("\0");
	for (let index = 0; index < records.length; index++) {
		const line = records[index];
		if (!line) continue;
		const x = line[0] ?? " ";
		const y = line[1] ?? " ";
		// In -z mode rename/copy records have a second (source) path.
		if (x === "R" || y === "R" || x === "C" || y === "C") index++;

		if (x === "?" && y === "?") {
			untracked.push(line.slice(3));
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

	return { filesAdded, filesRemoved, filesModified, untracked };
}

/**
 * Read the dirty totals for the repo containing `cwd`. Returns `undefined` when
 * `cwd` is not inside a git repo (or has no resolvable branch).
 *
 * tracked changes: `git diff --numstat HEAD`
 * untracked files: reuse NUL-delimited status paths + bounded content reads.
 * Failed/timed-out Git commands return undefined, never false clean/zero totals.
 */
export function collectGitSnapshot(cwd: string): GitSnapshot | undefined {
	const repoRoot = getRepoRoot(cwd);
	if (!repoRoot) return undefined;

	const branch = getBranchName(repoRoot);
	if (!branch) return undefined;

	const status = runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (!status.ok) return undefined;
	const isDirty = status.stdout.length > 0;
	if (!isDirty) {
		return { repoRoot, branch, isDirty: false, stats: { ...CLEAN_STATS } };
	}

	let trackedNumstat = runGit(repoRoot, ["diff", "--numstat", "-z", "HEAD"]);
	if (!trackedNumstat.ok && !runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]).ok) {
		// An unborn branch compares against Git's empty tree instead of HEAD.
		trackedNumstat = runGit(repoRoot, ["diff", "--numstat", "-z", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"]);
	}
	if (!trackedNumstat.ok) return undefined;
	const tracked = parseNumstat(trackedNumstat.stdout);
	const counters = parseFileCountersFromPorcelain(status.stdout);
	const untracked = getUntrackedAdditions(repoRoot, counters.untracked);

	return {
		repoRoot,
		branch,
		isDirty,
		untrackedLinesCapped: untracked.capped,
		stats: {
			filesAdded: counters.filesAdded,
			filesRemoved: counters.filesRemoved,
			filesModified: counters.filesModified,
			linesAdded: tracked.additions + untracked.additions,
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
export const GIT_STATS_CACHE_MS = 1_000;

/**
 * Debounced dirty-counter refresh for the host extension. The host binds it to
 * the session events that can change the working tree and gets `undefined`
 * whenever the label should disappear (clean repo, no git repo).
 */
export class GitStatsWatcher {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private pendingCwd: string | undefined;
	private signature: string | undefined;
	private cached: { cwd: string; at: number; snapshot: GitSnapshot | undefined } | undefined;
	/** Live totals, or `undefined` while the repo is clean/absent. */
	current: GitStats | undefined;

	constructor(
		private readonly onChange: (stats: GitStats | undefined) => void,
		private readonly collect = collectGitSnapshot,
		private readonly now = Date.now,
	) {}

	/** Known mutations/session changes bypass TTL on the next refresh. */
	invalidate(): void {
		this.cached = undefined;
	}

	/** Debounce bursts; cached requests collect at TTL expiry rather than being lost. */
	schedule(cwd: string): void {
		this.pendingCwd = cwd;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const target = this.pendingCwd;
			this.pendingCwd = undefined;
			if (target !== undefined) this.refresh(target);
		}, Math.max(REFRESH_DEBOUNCE_MS, this.cached?.cwd === cwd
			? GIT_STATS_CACHE_MS - (this.now() - this.cached.at) : 0));
	}

	/** Reuse a one-second same-cwd snapshot; notify only when counters change. */
	refresh(cwd: string): void {
		const now = this.now();
		if (!this.cached || this.cached.cwd !== cwd || now - this.cached.at >= GIT_STATS_CACHE_MS) {
			this.cached = { cwd, at: now, snapshot: this.collect(cwd) };
		}
		const stats = dirtyStats(this.cached.snapshot);
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
		this.invalidate();
		this.signature = undefined;
		this.current = undefined;
	}
}
