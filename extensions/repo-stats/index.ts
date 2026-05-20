import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_BAR_ID = "repo-stats";
const STATUS_BAR_FIRST_LINE_SET_EVENT = "status-bar:first-line:set";
const STATUS_BAR_FIRST_LINE_CLEAR_EVENT = "status-bar:first-line:clear";
const FIRST_LINE_PRIORITY = 100;

const ANSI_RESET = "\u001b[0m";
const ANSI_GREEN = "\u001b[38;5;34m";
const ANSI_BRIGHT_RED = "\u001b[38;5;196m";
const ANSI_ORANGE = "\u001b[38;5;208m";

interface GitResult {
	ok: boolean;
	stdout: string;
}

interface RepoStats {
	repoRoot: string;
	branch: string;
	isDirty: boolean;
	additions: number;
	removals: number;
	filesNew: number;
	filesRemoved: number;
	filesModified: number;
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
	filesNew: number;
	filesRemoved: number;
	filesModified: number;
} {
	let filesNew = 0;
	let filesRemoved = 0;
	let filesModified = 0;

	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const x = line[0] ?? " ";
		const y = line[1] ?? " ";

		if (x === "?" && y === "?") {
			filesNew += 1;
			continue;
		}

		if (x === "D" || y === "D") {
			filesRemoved += 1;
			continue;
		}

		if (x === "A" || y === "A") {
			filesNew += 1;
			continue;
		}

		if (x !== " " || y !== " ") {
			filesModified += 1;
		}
	}

	return { filesNew, filesRemoved, filesModified };
}

function collectRepoStats(cwd: string): RepoStats | undefined {
	const repoRoot = getRepoRoot(cwd);
	if (!repoRoot) return undefined;

	const branch = getBranchName(repoRoot);
	if (!branch) return undefined;

	const status = runGit(repoRoot, ["status", "--porcelain"]);
	const isDirty = status.ok && status.stdout.length > 0;
	if (!isDirty) {
		return {
			repoRoot,
			branch,
			isDirty: false,
			additions: 0,
			removals: 0,
			filesNew: 0,
			filesRemoved: 0,
			filesModified: 0,
		};
	}

	const trackedNumstat = runGit(repoRoot, ["diff", "--numstat", "HEAD"]);
	const tracked = trackedNumstat.ok ? parseNumstat(trackedNumstat.stdout) : { additions: 0, removals: 0 };
	const untrackedAdditions = getUntrackedAdditions(repoRoot);
	const counters = status.ok ? parseFileCountersFromPorcelain(status.stdout) : { filesNew: 0, filesRemoved: 0, filesModified: 0 };

	return {
		repoRoot,
		branch,
		isDirty,
		additions: tracked.additions + untrackedAdditions,
		removals: tracked.removals,
		filesNew: counters.filesNew,
		filesRemoved: counters.filesRemoved,
		filesModified: counters.filesModified,
	};
}

function colorAnsi(code: string, text: string): string {
	return `${code}${text}${ANSI_RESET}`;
}

function renderFileChangeSummary(stats: RepoStats, ctx: ExtensionContext): string {
	const filesNew = Number.isFinite(stats.filesNew) ? stats.filesNew : 0;
	const filesRemoved = Number.isFinite(stats.filesRemoved) ? stats.filesRemoved : 0;
	const filesModified = Number.isFinite(stats.filesModified) ? stats.filesModified : 0;
	if (!ctx.hasUI) return `+${filesNew} -${filesRemoved} M${filesModified}`;
	const plus = colorAnsi(ANSI_GREEN, `+${filesNew}`);
	const minus = colorAnsi(ANSI_BRIGHT_RED, `-${filesRemoved}`);
	const modified = colorAnsi(ANSI_ORANGE, `M${filesModified}`);
	return `${plus} ${minus} ${modified}`;
}

function renderLineChangeSummary(stats: RepoStats, ctx: ExtensionContext): string {
	const additions = Number.isFinite(stats.additions) ? stats.additions : 0;
	const removals = Number.isFinite(stats.removals) ? stats.removals : 0;
	if (!ctx.hasUI) return `+${additions} -${removals}`;
	const plus = colorAnsi(ANSI_GREEN, `+${additions}`);
	const minus = colorAnsi(ANSI_BRIGHT_RED, `-${removals}`);
	return `${plus} ${minus}`;
}

function renderGitStatsSummary(stats: RepoStats, ctx: ExtensionContext): string | undefined {
	if (!stats.isDirty) return undefined;
	const fileSummary = renderFileChangeSummary(stats, ctx);
	const lineSummary = renderLineChangeSummary(stats, ctx);
	return `[${fileSummary} | ${lineSummary}]`;
}

export default function repoStatsExtension(pi: ExtensionAPI): void {
	let lastSignature: string | undefined;
	let scheduledTimer: NodeJS.Timeout | undefined;
	let latestCtx: ExtensionContext | undefined;

	const clearStatus = (): void => {
		if (lastSignature === undefined) return;
		lastSignature = undefined;
		pi.events.emit(STATUS_BAR_FIRST_LINE_CLEAR_EVENT, { id: STATUS_BAR_ID });
	};

	const refresh = (ctx: ExtensionContext): void => {
		const stats = collectRepoStats(ctx.cwd);
		if (!stats) {
			clearStatus();
			return;
		}

		const content = renderGitStatsSummary(stats, ctx);
		if (!content) {
			clearStatus();
			return;
		}
		const signature = `${ctx.cwd}|${content}|${ctx.hasUI ? "ui" : "noui"}`;
		if (signature === lastSignature) return;
		lastSignature = signature;

		pi.events.emit(STATUS_BAR_FIRST_LINE_SET_EVENT, {
			id: STATUS_BAR_ID,
			content,
			priority: FIRST_LINE_PRIORITY,
		});
	};

	const scheduleRefresh = (ctx: ExtensionContext): void => {
		latestCtx = ctx;
		if (scheduledTimer) return;
		scheduledTimer = setTimeout(() => {
			scheduledTimer = undefined;
			if (!latestCtx) return;
			refresh(latestCtx);
		}, 120);
	};

	const bindRefresh = (
		eventName:
			| "session_start"
			| "session_tree"
			| "turn_start"
			| "turn_end"
			| "input"
			| "user_bash",
	) => {
		pi.on(eventName, async (_event, ctx) => {
			scheduleRefresh(ctx);
		});
	};

	bindRefresh("session_start");
	bindRefresh("session_tree");
	bindRefresh("turn_start");
	bindRefresh("turn_end");
	bindRefresh("input");
	bindRefresh("user_bash");

	pi.on("session_shutdown", async () => {
		if (scheduledTimer) {
			clearTimeout(scheduledTimer);
			scheduledTimer = undefined;
		}
		latestCtx = undefined;
		clearStatus();
	});

	pi.registerCommand("repo-stats-debug", {
		description: "Show computed repo-stats payload",
		handler: async (_args, ctx) => {
			const stats = collectRepoStats(ctx.cwd);
			if (!ctx.hasUI) return;
			if (!stats) {
				ctx.ui.notify("repo-stats: current cwd is not a git repo", "warning");
				return;
			}
			const summary = renderGitStatsSummary(stats, ctx) ?? "(clean)";
			ctx.ui.notify(`repo-stats: ${summary} (repo=${stats.repoRoot}, dirty=${stats.isDirty})`, "info");
		},
	});
}
