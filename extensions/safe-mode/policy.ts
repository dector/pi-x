import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { analyzeBash, classifyAnalyzedCommands, validateBashCommand } from "./bash-policy";
import type { AnalyzedCommand } from "./bash-policy/types";

export const SAFE_MODES = ["paranoid", "reader", "smart", "yolo"] as const;
export type SafeMode = (typeof SAFE_MODES)[number];

export const DEFAULT_SAFE_MODE: SafeMode = "smart";

const READ_ONLY_TOOLS = new Set(["read", "ls", "grep"]);
const PATH_SCOPED_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);
const READ_ONLY_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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

function getAnalyzedCommandText(command: AnalyzedCommand): string {
	return [command.programRaw, ...command.args].join(" ");
}

function isAnalyzedCommandSafeForAllowlist(command: AnalyzedCommand): boolean {
	if (command.sourceKind !== "top-level") return false;
	if (command.hasDynamicName || command.hasDynamicArgs || command.hasAnyExpansion) return false;
	return true;
}

function isAnalyzedCommandAllowedAnyArgs(command: AnalyzedCommand, allowedCommands: ReadonlySet<string>): boolean {
	if (!isAnalyzedCommandSafeForAllowlist(command)) return false;
	if (command.programRaw.includes("/")) return false;
	return allowedCommands.has(command.programRaw);
}

export function isBashCommandAllowedAnyArgs(command: string, allowedCommands: ReadonlySet<string>): boolean {
	return isBashCommandAllowedByAllowlist(command, new Set(), allowedCommands);
}

export function isBashCommandAllowedByAllowlist(
	command: string,
	exactCommands: ReadonlySet<string>,
	allowAnyCommands: ReadonlySet<string>,
): boolean {
	if (exactCommands.has(command)) return true;

	const analysis = analyzeBash(command);
	if (!analysis.parse.ok) return false;
	if (analysis.commandCount === 0) return false;
	if (analysis.structure.hasInputRedirection || analysis.structure.hasOutputRedirection) return false;
	if (analysis.structure.hasSubstitution) return false;

	for (const analyzedCommand of analysis.commands) {
		if (!isAnalyzedCommandSafeForAllowlist(analyzedCommand)) return false;
		const exactSegment = getAnalyzedCommandText(analyzedCommand);
		if (exactCommands.has(exactSegment)) continue;
		if (isAnalyzedCommandAllowedAnyArgs(analyzedCommand, allowAnyCommands)) continue;
		return false;
	}

	return true;
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

function normalizeSqliteInputForPolicy(input: Record<string, unknown>): {
	target: { kind: "memory" } | { kind: "file"; database: string };
	sql: string;
} | undefined {
	const rawSql = typeof input.sql === "string" ? input.sql.trim() : "";
	if (!rawSql) return undefined;

	const rawDatabase = normalizeToolPath(input.database);
	const memory = input.memory === true;
	if ((rawDatabase ? 1 : 0) + (memory ? 1 : 0) !== 1) return undefined;

	if (memory) return { target: { kind: "memory" }, sql: rawSql };
	return { target: { kind: "file", database: rawDatabase! }, sql: rawSql };
}

function splitSqlStatementsForPolicy(sql: string): string[] {
	const statements: string[] = [];
	let current = "";
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	let inBracket = false;
	let inLineComment = false;
	let inBlockComment = false;

	while (i < sql.length) {
		const char = sql[i]!;
		const next = sql[i + 1];

		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
				current += char;
			}
			i += 1;
			continue;
		}

		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				i += 2;
				continue;
			}
			i += 1;
			continue;
		}

		if (!inSingle && !inDouble && !inBracket && char === "-" && next === "-") {
			inLineComment = true;
			i += 2;
			continue;
		}

		if (!inSingle && !inDouble && !inBracket && char === "/" && next === "*") {
			inBlockComment = true;
			i += 2;
			continue;
		}

		if (!inDouble && !inBracket && char === "'") {
			if (inSingle && next === "'") {
				current += "''";
				i += 2;
				continue;
			}
			inSingle = !inSingle;
			current += char;
			i += 1;
			continue;
		}

		if (!inSingle && !inBracket && char === '"') {
			if (inDouble && next === '"') {
				current += '""';
				i += 2;
				continue;
			}
			inDouble = !inDouble;
			current += char;
			i += 1;
			continue;
		}

		if (!inSingle && !inDouble) {
			if (char === "[") inBracket = true;
			if (char === "]" && inBracket) inBracket = false;
		}

		if (!inSingle && !inDouble && !inBracket && char === ";") {
			const trimmed = current.trim();
			if (trimmed.length > 0) statements.push(trimmed);
			current = "";
			i += 1;
			continue;
		}

		current += char;
		i += 1;
	}

	const trailing = current.trim();
	if (trailing.length > 0) statements.push(trailing);
	return statements;
}

function classifySqliteStatementForPolicy(statement: string): "read-only" | "mutating" {
	const firstKeyword = statement.match(/^\s*([A-Za-z_]+)/)?.[1]?.toUpperCase();
	if (!firstKeyword) return "mutating";

	if (firstKeyword === "WITH") {
		if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|ATTACH|DETACH|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END)\b/i.test(statement)) {
			return "mutating";
		}
		if (/\b(SELECT|VALUES|EXPLAIN)\b/i.test(statement)) {
			return "read-only";
		}
		return "mutating";
	}

	if (firstKeyword === "PRAGMA") {
		return /^\s*PRAGMA\b[\s\S]*=/i.test(statement) ? "mutating" : "read-only";
	}

	if (firstKeyword === "SELECT" || firstKeyword === "EXPLAIN" || firstKeyword === "VALUES") {
		return "read-only";
	}

	if (["INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "ALTER", "DROP", "VACUUM", "ATTACH", "DETACH", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "END"].includes(firstKeyword)) {
		return "mutating";
	}

	return "mutating";
}

export function classifySqliteQueryForPolicy(sql: string): "read-only" | "mutating" {
	const statements = splitSqlStatementsForPolicy(sql);
	if (statements.length === 0) return "mutating";
	return statements.some((statement) => classifySqliteStatementForPolicy(statement) === "mutating")
		? "mutating"
		: "read-only";
}

function summarizeSqlSnippetForPolicy(sql: string, maxLength = 100): string {
	const collapsed = sql.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, Math.max(1, maxLength - 1))}…`;
}

function summarizeSqliteToolCallForPolicy(input: Record<string, unknown>): string {
	const normalized = normalizeSqliteInputForPolicy(input);
	if (!normalized) return "sqlite";
	const target = normalized.target.kind === "memory" ? "memory" : normalized.target.database;
	const kind = classifySqliteQueryForPolicy(normalized.sql);
	const sqlSnippet = summarizeSqlSnippetForPolicy(normalized.sql);
	return `sqlite: ${target} (${kind}) — ${sqlSnippet}`;
}

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

	if (toolName === "sqlite") {
		return summarizeSqliteToolCallForPolicy(input);
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

	const httpConfirmationReason = getHttpConfirmationReason(toolName, input, mode, projectRoot);
	if (httpConfirmationReason) {
		return { action: "confirm", reason: httpConfirmationReason, summary };
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
	if (isMemoryFsReadToolCall(toolName, input)) return true;
	if (isReadOnlyHttpToolCall(toolName, input)) return true;
	if (isReadOnlyWebSearchToolCall(toolName, input)) return true;
	if (toolName === "git") return classifyGitToolCall(input).readOnly;
	if (toolName === "sqlite") {
		const normalized = normalizeSqliteInputForPolicy(input);
		if (!normalized) return false;
		return classifySqliteQueryForPolicy(normalized.sql) === "read-only";
	}
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

function getHttpConfirmationReason(
	toolName: string,
	input: Record<string, unknown>,
	mode: SafeMode,
	projectRoot: string,
): string | undefined {
	if (isMemoryFsReadToolCall(toolName, input)) return undefined;

	if (toolName === "http_md" && input.spillMode === "to_file") {
		return "HTTP Markdown to-file output requires approval.";
	}

	if (toolName === "http") {
		const outputFile = getHttpOutputFile(input);
		if (outputFile) {
			if (mode === "yolo" && isPathInsideProject(outputFile, projectRoot)) return undefined;
			return mode === "yolo"
				? `HTTP output file targets outside project root (${projectRoot}).`
				: "HTTP file output requires approval.";
		}
	}

	if ((toolName === "http" || toolName === "http_md") && mode !== "yolo" && !isReadOnlyHttpMethod(input)) {
		return "HTTP auto-approval is limited to GET, HEAD, and OPTIONS.";
	}

	return undefined;
}

function isReadOnlyHttpToolCall(toolName: string, input: Record<string, unknown>): boolean {
	return (toolName === "http" || toolName === "http_md") && isReadOnlyHttpMethod(input);
}

function isReadOnlyWebSearchToolCall(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName !== "web_search") return false;
	if (input.query !== undefined && typeof input.query !== "string") return false;
	return true;
}

function isMemoryFsReadToolCall(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName !== "http" && toolName !== "http_md" && toolName !== "web_search") return false;
	if (!input.memfs || typeof input.memfs !== "object") return false;
	return Object.entries(input).every(([key, value]) => key === "memfs" || value === undefined);
}

function isReadOnlyHttpMethod(input: Record<string, unknown>): boolean {
	const method = getHttpMethod(input);
	return READ_ONLY_HTTP_METHODS.has(method);
}

function getHttpMethod(input: Record<string, unknown>): string {
	const structuredMethod = typeof input.method === "string" ? input.method.trim() : "";
	const curlMethod = getCurlRequestMethod(input);
	return (curlMethod || structuredMethod || "GET").toUpperCase();
}

function getCurlRequestMethod(input: Record<string, unknown>): string | undefined {
	const curlArgs = getCurlArgs(input);
	if (!curlArgs) return undefined;

	let hasDataBody = false;
	for (let i = 0; i < curlArgs.length; i += 1) {
		const arg = curlArgs[i]!;
		if (arg === "-X" || arg === "--request") return curlArgs[i + 1]?.trim();
		if (arg.startsWith("-X") && arg.length > 2) return arg.slice(2).trim();
		if (arg.startsWith("--request=")) return arg.slice("--request=".length).trim();
		if (arg === "-d" || arg === "--data" || arg === "--data-raw" || arg === "--data-binary") hasDataBody = true;
	}

	return hasDataBody ? "POST" : undefined;
}

function getHttpOutputFile(input: Record<string, unknown>): string | undefined {
	const outputFile = normalizeToolPath(input.outputFile);
	if (outputFile) return outputFile;
	return getCurlOutputFile(input);
}

function getCurlOutputFile(input: Record<string, unknown>): string | undefined {
	const curlArgs = getCurlArgs(input);
	if (!curlArgs) return undefined;

	for (let i = 0; i < curlArgs.length; i += 1) {
		const arg = curlArgs[i]!;
		if (arg === "-o" || arg === "--output") return normalizeToolPath(curlArgs[i + 1]);
		if (arg.startsWith("-o") && arg.length > 2) return normalizeToolPath(arg.slice(2));
		if (arg.startsWith("--output=")) return normalizeToolPath(arg.slice("--output=".length));
	}

	return undefined;
}

function getCurlArgs(input: Record<string, unknown>): string[] | undefined {
	const raw = input.curlArgs;
	if (!Array.isArray(raw)) return undefined;
	const args: string[] = [];
	for (const value of raw) {
		if (typeof value !== "string") return undefined;
		args.push(value.trim());
	}
	return args;
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

	if (toolName === "sqlite") {
		const normalized = normalizeSqliteInputForPolicy(input);
		if (!normalized || normalized.target.kind !== "file") return false;
		if (isPathInsideProject(normalized.target.database, projectRoot)) return false;
		return isPathInsideAnyRoot(normalized.target.database, projectRoot, trustedRoots);
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

	if (toolName === "sqlite") {
		const normalized = normalizeSqliteInputForPolicy(input);
		if (!normalized || normalized.target.kind !== "file") return false;
		return !isPathInsideProject(normalized.target.database, projectRoot);
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

