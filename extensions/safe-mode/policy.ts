import { isAbsolute, relative, resolve, sep } from "node:path";

export const SAFE_MODES = ["paranoid", "reader", "smart", "yolo"] as const;
export type SafeMode = (typeof SAFE_MODES)[number];

export const DEFAULT_SAFE_MODE: SafeMode = "smart";

const READ_ONLY_TOOLS = new Set(["read", "ls", "grep"]);

const READ_ONLY_BASH_COMMANDS = new Set([
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
]);

const BASH_COMMANDS_REQUIRING_APPROVAL = new Set(["find"]);

const WRITE_BASH_COMMANDS = new Set([
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

const READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "rev-parse"]);
const WRITE_GIT_SUBCOMMANDS = new Set([
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

const PACKAGE_MANAGER_WRITE_SUBCOMMANDS: Record<string, Set<string>> = {
	npm: new Set(["install", "uninstall", "update", "ci", "publish"]),
	yarn: new Set(["add", "remove", "install", "upgrade"]),
	pnpm: new Set(["add", "remove", "install", "update"]),
	pip: new Set(["install", "uninstall"]),
};

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

export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command.trim() : "";
		return command.length > 0 ? `bash: ${command}` : "bash";
	}

	if (toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "ls") {
		const path = normalizeToolPath(input.path);
		if (path) return `${toolName}: ${path}`;
	}

	if (toolName === "find" || toolName === "grep") {
		const path = normalizeToolPath(input.path);
		if (path) return `${toolName}: ${path}`;
	}

	return toolName;
}

export function decideToolCall(args: {
	mode: SafeMode;
	toolName: string;
	input: Record<string, unknown>;
	projectRoot: string;
}): ToolDecision {
	const { mode, toolName, input, projectRoot } = args;
	const summary = describeToolCall(toolName, input);

	if (mode === "yolo") {
		return { action: "allow", summary };
	}

	if (mode === "paranoid") {
		return {
			action: "confirm",
			reason: "Paranoid mode requires approval for every tool call.",
			summary,
		};
	}

	if (isReaderAllowed(toolName, input)) {
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

		if (isPathInsideProject(normalizedPath, projectRoot)) {
			return { action: "allow", summary };
		}

		return {
			action: "confirm",
			reason: `Path is outside project root (${projectRoot}).`,
			summary,
		};
	}

	return {
		action: "confirm",
		reason: mode === "reader"
			? "Reader mode only auto-allows read-only operations."
			: "Smart mode requires approval for this operation.",
		summary,
	};
}

function isReaderAllowed(toolName: string, input: Record<string, unknown>): boolean {
	if (READ_ONLY_TOOLS.has(toolName)) return true;
	if (toolName !== "bash") return false;

	const command = typeof input.command === "string" ? input.command : "";
	return isReadOnlyBashCommand(command);
}

function isReadOnlyBashCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) return false;

	const syntax = inspectShellSyntax(trimmed);
	if (syntax.hasOtherControlFlow || syntax.hasRedirection || syntax.hasSubstitution) {
		return false;
	}

	if (syntax.hasPipe) {
		const stages = splitPipelineStages(trimmed);
		if (!stages || stages.length < 2) return false;
		return stages.every((stage) => isReadOnlyBashStage(stage));
	}

	const type = getBashCommandType(trimmed);
	if (!type.isPlainCommand || !type.hasReads || type.hasWrites) return false;

	const program = getBashProgram(trimmed);
	if (program && BASH_COMMANDS_REQUIRING_APPROVAL.has(program)) {
		return false;
	}

	return true;
}

export function getBashCommandType(command: string): BashCommandType {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		return { hasReads: false, hasWrites: false, isPlainCommand: false };
	}

	const syntax = inspectShellSyntax(trimmed);
	const isPlainCommand = !syntax.hasOtherControlFlow && !syntax.hasRedirection && !syntax.hasSubstitution && !syntax.hasPipe;

	let hasReads = syntax.hasInputRedirection;
	let hasWrites = syntax.hasOutputRedirection;

	const argv = tokenizeBashCommand(trimmed);
	if (!argv) {
		return { hasReads, hasWrites, isPlainCommand: false };
	}

	const parsed = extractProgram(argv);
	if (!parsed) {
		return { hasReads, hasWrites, isPlainCommand };
	}

	const classification = classifyCommand(parsed.program, parsed.args);
	hasReads = hasReads || classification.hasReads;
	hasWrites = hasWrites || classification.hasWrites;

	return { hasReads, hasWrites, isPlainCommand };
}

function getBashProgram(command: string): string | undefined {
	const argv = tokenizeBashCommand(command.trim());
	if (!argv) return undefined;
	return extractProgram(argv)?.program;
}

function isReadOnlyBashStage(command: string): boolean {
	const argv = tokenizeBashCommand(command.trim());
	if (!argv) return false;

	const parsed = extractProgram(argv);
	if (!parsed) return false;
	if (BASH_COMMANDS_REQUIRING_APPROVAL.has(parsed.program)) return false;

	const classification = classifyCommand(parsed.program, parsed.args);
	return classification.hasReads && !classification.hasWrites;
}

function splitPipelineStages(command: string): string[] | undefined {
	const stages: string[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	for (let i = 0; i < command.length; i += 1) {
		const char = command[i]!;

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (!inSingleQuote && char === "\\") {
			escaped = true;
			continue;
		}

		if (!inDoubleQuote && char === "'") {
			inSingleQuote = !inSingleQuote;
			current += char;
			continue;
		}

		if (!inSingleQuote && char === '"') {
			inDoubleQuote = !inDoubleQuote;
			current += char;
			continue;
		}

		if (!inSingleQuote && !inDoubleQuote && char === "|") {
			if (command[i + 1] === "|") {
				return undefined;
			}

			const stage = current.trim();
			if (stage.length === 0) return undefined;
			stages.push(stage);
			current = "";
			continue;
		}

		current += char;
	}

	if (escaped || inSingleQuote || inDoubleQuote) {
		return undefined;
	}

	const tail = current.trim();
	if (tail.length === 0) return undefined;
	stages.push(tail);
	return stages;
}

function inspectShellSyntax(command: string): {
	hasPipe: boolean;
	hasOtherControlFlow: boolean;
	hasRedirection: boolean;
	hasInputRedirection: boolean;
	hasOutputRedirection: boolean;
	hasSubstitution: boolean;
} {
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	let hasPipe = false;
	let hasOtherControlFlow = false;
	let hasInputRedirection = false;
	let hasOutputRedirection = false;
	let hasSubstitution = false;

	for (let i = 0; i < command.length; i += 1) {
		const char = command[i]!;

		if (escaped) {
			escaped = false;
			continue;
		}

		if (!inSingleQuote && char === "\\") {
			escaped = true;
			continue;
		}

		if (!inDoubleQuote && char === "'") {
			inSingleQuote = !inSingleQuote;
			continue;
		}

		if (!inSingleQuote && char === '"') {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}

		if (inSingleQuote || inDoubleQuote) {
			continue;
		}

		if (char === "\n" || char === ";") {
			hasOtherControlFlow = true;
			continue;
		}

		if (char === "&") {
			hasOtherControlFlow = true;
			if (command[i + 1] === "&") i += 1;
			continue;
		}

		if (char === "|") {
			if (command[i + 1] === "|") {
				hasOtherControlFlow = true;
				i += 1;
				continue;
			}

			hasPipe = true;
			continue;
		}

		if (char === ">") {
			hasOutputRedirection = true;
			continue;
		}

		if (char === "<") {
			hasInputRedirection = true;
			continue;
		}

		if (char === "`") {
			hasSubstitution = true;
			continue;
		}

		if (char === "$" && command[i + 1] === "(") {
			hasSubstitution = true;
			i += 1;
			continue;
		}
	}

	return {
		hasPipe,
		hasOtherControlFlow,
		hasRedirection: hasInputRedirection || hasOutputRedirection,
		hasInputRedirection,
		hasOutputRedirection,
		hasSubstitution,
	};
}

function tokenizeBashCommand(command: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	const pushCurrent = (): void => {
		if (current.length > 0) {
			tokens.push(current);
			current = "";
		}
	};

	for (let i = 0; i < command.length; i += 1) {
		const char = command[i]!;

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (!inSingleQuote && char === "\\") {
			escaped = true;
			continue;
		}

		if (!inDoubleQuote && char === "'") {
			inSingleQuote = !inSingleQuote;
			continue;
		}

		if (!inSingleQuote && char === '"') {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}

		if (!inSingleQuote && !inDoubleQuote && /\s/.test(char)) {
			pushCurrent();
			continue;
		}

		current += char;
	}

	if (escaped || inSingleQuote || inDoubleQuote) {
		return undefined;
	}

	pushCurrent();
	return tokens;
}

function extractProgram(argv: string[]): { program: string; args: string[] } | undefined {
	let index = 0;
	while (index < argv.length && isEnvAssignment(argv[index]!)) {
		index += 1;
	}

	if (index >= argv.length) return undefined;

	const rawProgram = argv[index]!;
	const program = normalizeExecutable(rawProgram);
	const args = argv.slice(index + 1);
	return { program, args };
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function normalizeExecutable(rawProgram: string): string {
	const segments = rawProgram.split("/");
	const last = segments[segments.length - 1] ?? rawProgram;
	return last.toLowerCase();
}

function classifyCommand(program: string, args: string[]): { hasReads: boolean; hasWrites: boolean } {
	if (READ_ONLY_BASH_COMMANDS.has(program)) {
		return { hasReads: true, hasWrites: false };
	}

	if (WRITE_BASH_COMMANDS.has(program)) {
		return { hasReads: false, hasWrites: true };
	}

	if (program === "git") {
		return classifyGitCommand(args);
	}

	if (program in PACKAGE_MANAGER_WRITE_SUBCOMMANDS) {
		const subcommand = normalizeSubcommand(args[0]);
		const writeSubcommands = PACKAGE_MANAGER_WRITE_SUBCOMMANDS[program]!;
		return {
			hasReads: false,
			hasWrites: Boolean(subcommand && writeSubcommands.has(subcommand)),
		};
	}

	return { hasReads: false, hasWrites: false };
}

function classifyGitCommand(args: string[]): { hasReads: boolean; hasWrites: boolean } {
	const subcommand = normalizeSubcommand(args[0]);
	if (!subcommand) {
		return { hasReads: false, hasWrites: false };
	}

	if (WRITE_GIT_SUBCOMMANDS.has(subcommand)) {
		return { hasReads: false, hasWrites: true };
	}

	if (subcommand === "branch") {
		if (hasGitBranchMutationArg(args.slice(1))) {
			return { hasReads: false, hasWrites: true };
		}
		return { hasReads: true, hasWrites: false };
	}

	if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
		return { hasReads: true, hasWrites: false };
	}

	return { hasReads: false, hasWrites: false };
}

function hasGitBranchMutationArg(args: string[]): boolean {
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

		if (lower.startsWith("-")) {
			const shortFlags = lower.slice(1);
			if (shortFlags.includes("d") || shortFlags.includes("m") || shortFlags.includes("c")) {
				return true;
			}
		}
	}

	return false;
}

function normalizeSubcommand(value: string | undefined): string | undefined {
	if (!value) return undefined;
	if (value.startsWith("-")) return undefined;
	return value.toLowerCase();
}

function normalizeToolPath(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.replace(/^@+/, "");
}

function isPathInsideProject(pathValue: string, projectRoot: string): boolean {
	const absoluteProjectRoot = resolve(projectRoot);
	const absolutePath = resolve(absoluteProjectRoot, pathValue);
	const rel = relative(absoluteProjectRoot, absolutePath);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
