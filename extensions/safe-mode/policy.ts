import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { analyzeBash, classifyAnalyzedCommands, validateBashCommand } from "./bash-policy";

export const SAFE_MODES = ["paranoid", "reader", "smart", "yolo"] as const;
export type SafeMode = (typeof SAFE_MODES)[number];

export const DEFAULT_SAFE_MODE: SafeMode = "smart";

const READ_ONLY_TOOLS = new Set(["read", "ls", "grep"]);
const PATH_SCOPED_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);

export type ToolCallLike = {
	toolName: string;
	input: Record<string, unknown>;
};

export interface ToolDecision {
	action: "allow" | "confirm" | "block";
	reason?: string;
	summary: string;
}

export interface BashCommandType {
	hasReads: boolean;
	hasWrites: boolean;
	isPlainCommand: boolean;
}

export interface GitToolClassification {
	recognized: boolean;
	readOnly: boolean;
	subtool?: string;
	summary: string;
}

type GitSubtoolValidator = (argv: string[]) => boolean;

const GIT_READ_ONLY_SUBTOOLS: ReadonlySet<string> = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"grep",
	"shortlog",
	"rev-parse",
	"rev-list",
	"merge-base",
	"describe",
	"name-rev",
	"symbolic-ref",
	"show-ref",
	"for-each-ref",
	"ls-files",
	"ls-tree",
	"cat-file",
	"check-ignore",
	"branch",
	"tag",
	"remote",
	"reflog",
	"config",
	"count-objects",
	"fsck",
	"verify-commit",
	"verify-tag",
]);

const GIT_READ_ONLY_VALIDATORS: Record<string, GitSubtoolValidator> = {
	branch: isReadOnlyGitBranchArgs,
	tag: isReadOnlyGitTagArgs,
	remote: isReadOnlyGitRemoteArgs,
	config: isReadOnlyGitConfigArgs,
	diff: isReadOnlyGitDiffArgs,
	reflog: isReadOnlyGitReflogArgs,
};

export function isSafeMode(value: unknown): value is SafeMode {
	return typeof value === "string" && (SAFE_MODES as readonly string[]).includes(value);
}

export function parseSafeMode(value: unknown): SafeMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return isSafeMode(normalized) ? normalized : undefined;
}

export function cycleSafeMode(current: SafeMode): SafeMode {
	const index = SAFE_MODES.indexOf(current);
	return SAFE_MODES[(index + 1) % SAFE_MODES.length]!;
}

export function normalizeGitToolArgs(input: Record<string, unknown>): string[] | undefined {
	const rawArgs = input.args;
	if (rawArgs == null) return [];
	if (!Array.isArray(rawArgs)) return undefined;

	const normalized: string[] = [];
	for (const arg of rawArgs) {
		if (typeof arg !== "string") return undefined;
		const trimmed = arg.trim();
		if (trimmed.length === 0) return undefined;
		if (trimmed.includes("\0") || trimmed.includes("\n") || trimmed.includes("\r")) return undefined;
		normalized.push(trimmed);
	}

	return normalized;
}

export function classifyGitToolCall(input: Record<string, unknown>): GitToolClassification {
	const argv = normalizeGitToolArgs(input);
	if (!argv) {
		return {
			recognized: false,
			readOnly: false,
			summary: "git",
		};
	}

	if (argv.length === 0) {
		return {
			recognized: false,
			readOnly: false,
			summary: "git",
		};
	}

	const subtool = argv[0]!;
	const summary = formatGitToolSummary(argv);
	if (subtool.startsWith("-")) {
		return {
			recognized: false,
			readOnly: false,
			subtool,
			summary,
		};
	}

	if (!GIT_READ_ONLY_SUBTOOLS.has(subtool)) {
		return {
			recognized: false,
			readOnly: false,
			subtool,
			summary,
		};
	}

	const validator = GIT_READ_ONLY_VALIDATORS[subtool] ?? (() => true);
	const readOnly = validator(argv);
	return {
		recognized: true,
		readOnly,
		subtool,
		summary: readOnly ? `${summary} (read-only)` : summary,
	};
}

function formatGitToolSummary(argv: string[]): string {
	if (argv.length === 0) return "git";
	return `git: ${argv.join(" ")}`;
}

function isReadOnlyGitDiffArgs(argv: string[]): boolean {
	for (let i = 1; i < argv.length; i += 1) {
		const token = argv[i]!;
		if (token === "-o" || token === "--output" || token.startsWith("--output=")) return false;
	}
	return true;
}

function isReadOnlyGitBranchArgs(argv: string[]): boolean {
	if (argv.length === 1) return true;
	const disallowed = new Set([
		"-d",
		"-D",
		"--delete",
		"-m",
		"-M",
		"--move",
		"-c",
		"-C",
		"--copy",
		"--set-upstream-to",
		"--unset-upstream",
		"--edit-description",
		"--create-reflog",
		"--track",
		"--no-track",
		"-u",
	]);
	const allowedFlags = new Set([
		"--list",
		"-l",
		"--all",
		"-a",
		"--remotes",
		"-r",
		"--verbose",
		"-v",
		"--column",
		"--ignore-case",
	]);
	const valueFlags = new Set(["--sort", "--contains", "--no-contains", "--merged", "--no-merged", "--format"]);
	let hasListMode = false;
	let hasPatternArg = false;

	for (let i = 1; i < argv.length; i += 1) {
		const token = argv[i]!;
		if (disallowed.has(token)) return false;
		if (token === "--list" || token === "-l") hasListMode = true;

		if (valueFlags.has(token)) {
			const next = argv[i + 1];
			if (!next || next.startsWith("-")) return false;
			i += 1;
			continue;
		}

		if ([...valueFlags].some((flag) => token.startsWith(`${flag}=`))) continue;
		if (allowedFlags.has(token)) continue;
		if (token === "--") {
			hasPatternArg = i < argv.length - 1;
			break;
		}
		if (token.startsWith("-")) return false;
		hasPatternArg = true;
	}

	if (hasPatternArg && !hasListMode) return false;
	return true;
}

function isReadOnlyGitTagArgs(argv: string[]): boolean {
	if (argv.length === 1) return true;
	const disallowed = new Set([
		"-d",
		"--delete",
		"-a",
		"--annotate",
		"-s",
		"--sign",
		"-u",
		"--local-user",
		"-m",
		"--message",
		"-F",
		"--file",
		"-f",
		"--force",
		"--create-reflog",
		"--edit",
	]);
	const allowedFlags = new Set(["-l", "--list", "-n", "--column", "--ignore-case", "--contains", "--no-contains"]);
	let hasListMode = false;
	let hasPatternArg = false;

	for (let i = 1; i < argv.length; i += 1) {
		const token = argv[i]!;
		if (disallowed.has(token)) return false;
		if (token === "-l" || token === "--list") hasListMode = true;
		if (token === "--") {
			hasPatternArg = i < argv.length - 1;
			break;
		}
		if (allowedFlags.has(token)) continue;
		if (token.startsWith("--contains=") || token.startsWith("--no-contains=")) continue;
		if (token === "-n") {
			const next = argv[i + 1];
			if (!next || next.startsWith("-")) return false;
			i += 1;
			continue;
		}
		if (token.startsWith("-n")) continue;
		if (token.startsWith("-")) return false;
		hasPatternArg = true;
	}

	if (hasPatternArg && !hasListMode) return false;
	return true;
}

function isReadOnlyGitRemoteArgs(argv: string[]): boolean {
	if (argv.length === 1) return true;
	if (argv.length === 2 && (argv[1] === "-v" || argv[1] === "--verbose")) return true;
	return false;
}

function isReadOnlyGitReflogArgs(argv: string[]): boolean {
	if (argv.length === 1) return true;
	const disallowedSubtools = new Set(["expire", "delete", "drop", "write"]);
	for (let i = 1; i < argv.length; i += 1) {
		const token = argv[i]!;
		if (disallowedSubtools.has(token)) return false;
		if (token === "--") break;
	}
	return true;
}

function isReadOnlyGitConfigArgs(argv: string[]): boolean {
	if (argv.length === 1) return false;
	const readFlags = new Set(["--get", "--get-all", "--list"]);
	const optionalFlags = new Set([
		"--show-origin",
		"--show-scope",
		"--name-only",
		"-z",
		"--null",
		"--includes",
		"--no-includes",
		"--fixed-value",
	]);
	const disallowed = new Set([
		"--add",
		"--replace-all",
		"--unset",
		"--unset-all",
		"--remove-section",
		"--rename-section",
		"--global",
		"--system",
		"--local",
		"--worktree",
		"--blob",
		"--file",
		"-f",
		"--edit",
		"-e",
	]);

	let hasReadSelector = false;
	for (let i = 1; i < argv.length; i += 1) {
		const token = argv[i]!;
		if (disallowed.has(token)) return false;
		if (token.startsWith("--blob=") || token.startsWith("--file=")) return false;
		if (readFlags.has(token)) {
			hasReadSelector = true;
			continue;
		}
		if (optionalFlags.has(token)) continue;
		if (token === "--type") {
			const next = argv[i + 1];
			if (!next || next.startsWith("-")) return false;
			i += 1;
			continue;
		}
		if (token.startsWith("--type=")) continue;
		if (token.startsWith("-")) return false;
	}

	return hasReadSelector;
}

export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command.trim() : "";
		return command.length > 0 ? `bash: ${command}` : "bash";
	}

	if (toolName === "git") {
		const argv = normalizeGitToolArgs(input);
		if (!argv || argv.length === 0) return "git";
		return formatGitToolSummary(argv);
	}

	if (toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "ls") {
		const path = normalizeToolPath(input.path);
		if (path) return `${toolName}: ${path}`;
	}

	if (toolName === "find" || toolName === "grep") {
		const path = normalizeToolPath(input.path);
		if (path) return `${toolName}: ${path}`;
	}

	if (toolName === "commit") {
		const summary = summarizeCommitToolCall(input);
		if (summary) return summary;
	}

	return toolName;
}

export function decideToolCall(args: {
	mode: SafeMode;
	toolName: string;
	input: Record<string, unknown>;
	projectRoot: string;
	outerAccess: boolean;
	trustedReadRoots?: string[];
}): ToolDecision {
	const { mode, toolName, input, projectRoot, outerAccess, trustedReadRoots } = args;
	const gitClassification = toolName === "git" ? classifyGitToolCall(input) : undefined;
	const summary = gitClassification?.summary ?? describeToolCall(toolName, input);

	if (mode === "paranoid") {
		return {
			action: "confirm",
			reason: "Paranoid mode requires approval for every tool call.",
			summary,
		};
	}

	if (!outerAccess && targetsOutsideProject(toolName, input, projectRoot)) {
		if (!isTrustedOutsideReadAllowed({ mode, toolName, input, projectRoot, trustedReadRoots })) {
			return {
				action: "confirm",
				reason: `Operation targets outside project root (${projectRoot}).`,
				summary,
			};
		}
	}

	if (toolName === "git" && gitClassification?.readOnly) {
		return { action: "allow", summary };
	}

	if (mode === "yolo") {
		return { action: "allow", summary };
	}

	if (isReaderAllowed(toolName, input, mode)) {
		return { action: "allow", summary };
	}

	if (mode === "smart" && (toolName === "write" || toolName === "edit")) {
		const normalizedPath = normalizeToolPath(input.path);
		if (!normalizedPath) {
			return {
				action: "confirm",
				reason: "Smart mode requires a valid path to auto-allow file modifications.",
				summary,
			};
		}

		if (!isPathInsideProject(normalizedPath, projectRoot)) {
			return {
				action: "confirm",
				reason: `Smart mode only auto-allows file modifications inside project root (${projectRoot}).`,
				summary,
			};
		}

		return { action: "allow", summary };
	}

	const bashReason = (toolName === "bash" && (mode === "reader" || mode === "smart"))
		? validateBashCommand({
			command: typeof input.command === "string" ? input.command : "",
			profile: mode === "smart" ? "smart" : "reader",
		}).reasons[0]?.message
		: undefined;

	return {
		action: "confirm",
		reason: bashReason ?? (mode === "reader"
			? "Reader mode only auto-allows read-only operations."
			: "Smart mode requires approval for this operation."),
		summary,
	};
}

function isReaderAllowed(toolName: string, input: Record<string, unknown>, mode: SafeMode): boolean {
	if (READ_ONLY_TOOLS.has(toolName)) return true;
	if (toolName === "git") return classifyGitToolCall(input).readOnly;
	if (toolName !== "bash") return false;

	const command = typeof input.command === "string" ? input.command : "";
	const profile = mode === "smart" ? "smart" : "reader";
	const decision = validateBashCommand({ command, profile });
	return decision.action === "allow";
}

export function getBashCommandType(command: string): BashCommandType {
	const analysis = analyzeBash(command);
	if (!analysis.parse.ok) {
		return { hasReads: false, hasWrites: false, isPlainCommand: false };
	}

	const classification = classifyAnalyzedCommands(analysis.commands);
	return {
		hasReads: classification.anyReadLike || analysis.structure.hasInputRedirection,
		hasWrites: classification.anyWriteLike || analysis.structure.hasOutputRedirection,
		isPlainCommand: analysis.structure.isPlainCommand,
	};
}

function isTrustedOutsideReadAllowed(args: {
	mode: SafeMode;
	toolName: string;
	input: Record<string, unknown>;
	projectRoot: string;
	trustedReadRoots?: string[];
}): boolean {
	const { mode, toolName, input, projectRoot, trustedReadRoots } = args;
	if (mode !== "reader" && mode !== "smart") return false;
	if (!isReaderAllowed(toolName, input, mode)) return false;

	const roots = normalizeTrustedReadRoots(trustedReadRoots, projectRoot);
	if (roots.length === 0) return false;

	return hasOnlyTrustedOutsideTargets(toolName, input, projectRoot, roots);
}

function normalizeTrustedReadRoots(trustedReadRoots: string[] | undefined, projectRoot: string): string[] {
	if (!Array.isArray(trustedReadRoots)) return [];
	const normalized = new Set<string>();
	for (const root of trustedReadRoots) {
		if (typeof root !== "string") continue;
		const trimmed = root.trim();
		if (trimmed.length === 0) continue;
		normalized.add(resolvePathInput(trimmed, projectRoot));
	}
	return [...normalized];
}

function hasOnlyTrustedOutsideTargets(
	toolName: string,
	input: Record<string, unknown>,
	projectRoot: string,
	trustedRoots: string[],
): boolean {
	if (PATH_SCOPED_TOOLS.has(toolName)) {
		const pathValue = normalizeToolPath(input.path);
		if (!pathValue) return false;
		if (isPathInsideProject(pathValue, projectRoot)) return false;
		return isPathInsideAnyRoot(pathValue, projectRoot, trustedRoots);
	}

	if (toolName === "commit") {
		const files = normalizeCommitToolFiles(input);
		if (!files || files.length === 0) return false;
		let hasOutside = false;
		for (const file of files) {
			if (isPathInsideProject(file, projectRoot)) continue;
			hasOutside = true;
			if (!isPathInsideAnyRoot(file, projectRoot, trustedRoots)) return false;
		}
		return hasOutside;
	}

	if (toolName !== "bash") return false;
	const command = typeof input.command === "string" ? input.command : "";
	return bashHasOnlyTrustedOutsideTargets(command, projectRoot, trustedRoots);
}

function bashHasOnlyTrustedOutsideTargets(command: string, projectRoot: string, trustedRoots: string[]): boolean {
	const analysis = analyzeBash(command);
	if (!analysis.parse.ok) return false;

	let hasOutsideTarget = false;
	for (const candidate of analysis.paths) {
		if (!isPathLikeArg(candidate)) continue;
		if (isPathInsideProject(candidate, projectRoot)) continue;
		hasOutsideTarget = true;
		if (!isPathInsideAnyRoot(candidate, projectRoot, trustedRoots)) return false;
	}

	return hasOutsideTarget;
}

function isPathInsideAnyRoot(pathValue: string, projectRoot: string, trustedRoots: string[]): boolean {
	const absolutePath = resolvePathInput(pathValue, projectRoot);
	for (const trustedRoot of trustedRoots) {
		if (isPathInsideBase(absolutePath, trustedRoot)) return true;
	}
	return false;
}

function targetsOutsideProject(toolName: string, input: Record<string, unknown>, projectRoot: string): boolean {
	if (PATH_SCOPED_TOOLS.has(toolName)) {
		const pathValue = normalizeToolPath(input.path);
		if (!pathValue) return false;
		return !isPathInsideProject(pathValue, projectRoot);
	}

	if (toolName === "commit") {
		const files = normalizeCommitToolFiles(input);
		if (!files || files.length === 0) return false;
		return files.some((file) => !isPathInsideProject(file, projectRoot));
	}

	if (toolName !== "bash") return false;
	const command = typeof input.command === "string" ? input.command : "";
	return bashTargetsOutsideProject(command, projectRoot);
}

function bashTargetsOutsideProject(command: string, projectRoot: string): boolean {
	const analysis = analyzeBash(command);
	if (!analysis.parse.ok) return false;

	for (const candidate of analysis.paths) {
		if (!isPathLikeArg(candidate)) continue;
		if (!isPathInsideProject(candidate, projectRoot)) return true;
	}

	return false;
}

function isPathLikeArg(value: string): boolean {
	if (value.length === 0) return false;
	if (value === "~" || value.startsWith("~/")) return true;
	if (value.startsWith("/")) return true;
	if (value === "." || value === "..") return true;
	if (value.startsWith("./") || value.startsWith("../")) return true;
	if (value.includes("/")) return true;
	return false;
}

function normalizeToolPath(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.replace(/^@+/, "");
}

function normalizeCommitToolFiles(input: Record<string, unknown>): string[] | undefined {
	const raw = input.files;
	if (!Array.isArray(raw)) return undefined;
	const deduped = new Set<string>();
	for (const value of raw) {
		const normalized = normalizeToolPath(value);
		if (!normalized) return undefined;
		deduped.add(normalized);
	}
	return [...deduped];
}

function summarizeCommitToolCall(input: Record<string, unknown>): string | undefined {
	const files = normalizeCommitToolFiles(input);
	if (!files) return undefined;
	const rawMessage = typeof input.message === "string" ? input.message.trim() : "";
	const message = rawMessage.length > 0 ? rawMessage : "(empty message)";
	const escapedMessage = message.replace(/"/g, '\\"');
	return `commit: ${files.length} files "${escapedMessage}"`;
}

function resolvePathInput(pathValue: string, projectRoot: string): string {
	if (pathValue === "~") return homedir();
	if (pathValue.startsWith("~/")) return resolve(homedir(), pathValue.slice(2));
	const absoluteProjectRoot = resolve(projectRoot);
	return resolve(absoluteProjectRoot, pathValue);
}

function isPathInsideBase(pathValue: string, basePath: string): boolean {
	const absoluteBasePath = resolve(basePath);
	const absolutePath = resolve(pathValue);
	const rel = relative(absoluteBasePath, absolutePath);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isPathInsideProject(pathValue: string, projectRoot: string): boolean {
	const absoluteProjectRoot = resolve(projectRoot);
	const absolutePath = resolvePathInput(pathValue, absoluteProjectRoot);
	return isPathInsideBase(absolutePath, absoluteProjectRoot);
}

