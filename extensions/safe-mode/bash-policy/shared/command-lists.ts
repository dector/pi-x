import { normalizeSubcommand } from "./normalization";

export const READ_ONLY_BASH_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"grep",
	"find",
	"rg",
	"fd",
	"ls",
	"pwd",
	"cd",
	"tree",
	"stat",
	"file",
	"wc",
	"whoami",
	"id",
	"date",
	"uname",
	"uptime",
	"hostname",
	"env",
	"printenv",
	"echo",
	"printf",
	"which",
	"type",
	"realpath",
	"readlink",
	"basename",
	"dirname",
	"sort",
	"uniq",
	"cut",
	"tr",
	"nl",
	"true",
]);

export const WRITE_BASH_COMMANDS = new Set([
	"rm",
	"mv",
	"cp",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"truncate",
	"sudo",
	"su",
]);

export const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"rev-parse",
	"ls-files",
	"ls-tree",
	"cat-file",
	"grep",
	"blame",
	"rev-list",
	"shortlog",
]);

export const WRITE_GIT_SUBCOMMANDS = new Set([
	"add",
	"commit",
	"push",
	"pull",
	"merge",
	"rebase",
	"reset",
	"checkout",
	"stash",
	"tag",
]);

export const PACKAGE_MANAGER_WRITE_SUBCOMMANDS: Record<string, Set<string>> = {
	npm: new Set(["install", "uninstall", "update", "ci", "publish"]),
	yarn: new Set(["add", "remove", "install", "upgrade"]),
	pnpm: new Set(["add", "remove", "install", "update"]),
	pip: new Set(["install", "uninstall"]),
	bun: new Set(["add", "install", "remove", "update"]),
};

export function hasFindWriteLikeArgs(args: readonly string[]): boolean {
	return args.some((arg) => {
		const lower = arg.toLowerCase();
		return (
			lower === "-exec" ||
			lower === "-execdir" ||
			lower === "-ok" ||
			lower === "-okdir" ||
			lower === "-delete" ||
			lower === "-fprint" ||
			lower === "-fprint0" ||
			lower === "-fprintf"
		);
	});
}

export function isReadOnlyCommandBuiltinArgs(args: readonly string[]): boolean {
	if (args.length < 2) return false;

	let seenLookupFlag = false;
	for (const arg of args) {
		if (!arg.startsWith("-")) {
			return seenLookupFlag;
		}

		if (arg === "--") {
			return false;
		}

		if (arg === "-v" || arg === "-V") {
			seenLookupFlag = true;
			continue;
		}

		if (arg === "-p") {
			continue;
		}

		return false;
	}

	return false;
}

export function hasGitBranchMutationArg(args: readonly string[]): boolean {
	for (const arg of args) {
		if (!arg.startsWith("-")) continue;
		if (arg === "--") break;

		const lower = arg.toLowerCase();
		if (
			lower === "-d" ||
			lower === "-m" ||
			lower === "-c" ||
			lower === "--delete" ||
			lower === "--move" ||
			lower === "--copy"
		) {
			return true;
		}

		const shortFlags = lower.slice(1);
		if (shortFlags.includes("d") || shortFlags.includes("m") || shortFlags.includes("c")) {
			return true;
		}
	}

	return false;
}

export function classifyGitArgs(args: readonly string[]): "read" | "write" | "unknown" {
	const subcommand = normalizeSubcommand(args[0]);
	if (!subcommand) return "unknown";
	if (WRITE_GIT_SUBCOMMANDS.has(subcommand)) return "write";
	if (subcommand === "branch") return hasGitBranchMutationArg(args.slice(1)) ? "write" : "read";
	if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return "read";
	return "unknown";
}
