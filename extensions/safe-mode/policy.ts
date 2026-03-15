import parseBash from "bash-parser";
import { homedir } from "node:os";
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
]);

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

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
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
	bun: new Set(["add", "install", "remove", "update"]),
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

interface BashPolicyAnalysis {
	hasReads: boolean;
	hasWrites: boolean;
	hasPipe: boolean;
	hasOtherControlFlow: boolean;
	hasInputRedirection: boolean;
	hasOutputRedirection: boolean;
	hasSubstitution: boolean;
	hasUnknownCommand: boolean;
	requiresApproval: boolean;
	parseError: boolean;
	commandCount: number;
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
	outerAccess: boolean;
}): ToolDecision {
	const { mode, toolName, input, projectRoot, outerAccess } = args;
	const summary = describeToolCall(toolName, input);

	if (mode === "paranoid") {
		return {
			action: "confirm",
			reason: "Paranoid mode requires approval for every tool call.",
			summary,
		};
	}

	if (!outerAccess && targetsOutsideProject(toolName, input, projectRoot)) {
		return {
			action: "confirm",
			reason: `Operation targets outside project root (${projectRoot}).`,
			summary,
		};
	}

	if (mode === "yolo") {
		return { action: "allow", summary };
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

		if (!isPathInsideProject(normalizedPath, projectRoot)) {
			return {
				action: "confirm",
				reason: `Smart mode only auto-allows file modifications inside project root (${projectRoot}).`,
				summary,
			};
		}

		return { action: "allow", summary };
	}

	return {
		action: "confirm",
		reason: mode === "reader"
			? "Reader mode only auto-allows read-only operations."
			: "Smart mode requires approval for this operation.",
		summary,
	};
}

const PATH_SCOPED_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);

function targetsOutsideProject(toolName: string, input: Record<string, unknown>, projectRoot: string): boolean {
	if (PATH_SCOPED_TOOLS.has(toolName)) {
		const pathValue = normalizeToolPath(input.path);
		if (!pathValue) return false;
		return !isPathInsideProject(pathValue, projectRoot);
	}

	if (toolName !== "bash") return false;
	const command = typeof input.command === "string" ? input.command : "";
	return bashTargetsOutsideProject(command, projectRoot);
}

function bashTargetsOutsideProject(command: string, projectRoot: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) return false;

	let ast: any;
	try {
		ast = parseBash(trimmed);
	} catch {
		return false;
	}

	const pathCandidates: string[] = [];
	collectPathCandidatesFromAst(ast, pathCandidates);

	for (const candidate of pathCandidates) {
		if (!isPathLikeArg(candidate)) continue;
		if (!isPathInsideProject(candidate, projectRoot)) return true;
	}

	return false;
}

function collectPathCandidatesFromAst(node: any, paths: string[]): void {
	if (!node || typeof node !== "object") return;

	switch (node.type) {
		case "Script":
			for (const command of asArray(node.commands)) collectPathCandidatesFromAst(command, paths);
			return;
		case "LogicalExpression":
			collectPathCandidatesFromAst(node.left, paths);
			collectPathCandidatesFromAst(node.right, paths);
			return;
		case "Pipeline":
			for (const command of asArray(node.commands)) collectPathCandidatesFromAst(command, paths);
			return;
		case "Command": {
			const command = extractAstCommand(node);
			if (command) {
				if (command.program === "cd") {
					if (command.args[0]) paths.push(command.args[0]);
				} else {
					for (const arg of command.args) paths.push(arg);
				}
			}

			for (const redirect of collectRedirectNodes(node)) {
				const filePath = extractWordText(redirect?.file);
				if (filePath) paths.push(filePath);
			}
			return;
		}
		case "Subshell":
			collectPathCandidatesFromAst(node.list, paths);
			return;
		case "CompoundList":
			for (const command of asArray(node.commands)) collectPathCandidatesFromAst(command, paths);
			return;
		case "If":
			collectPathCandidatesFromAst(node.clause, paths);
			collectPathCandidatesFromAst(node.then, paths);
			collectPathCandidatesFromAst(node.else, paths);
			return;
		case "For":
		case "While":
		case "Until":
			collectPathCandidatesFromAst(node.clause, paths);
			collectPathCandidatesFromAst(node.do, paths);
			return;
		case "Case":
			collectPathCandidatesFromAst(node.clause, paths);
			for (const item of asArray(node.cases)) collectPathCandidatesFromAst(item, paths);
			return;
		case "Function":
			collectPathCandidatesFromAst(node.body, paths);
			return;
		default:
			return;
	}
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

function isReaderAllowed(toolName: string, input: Record<string, unknown>): boolean {
	if (READ_ONLY_TOOLS.has(toolName)) return true;
	if (toolName !== "bash") return false;

	const command = typeof input.command === "string" ? input.command : "";
	return isReadOnlyBashCommand(command);
}

function isReadOnlyBashCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) return false;

	const analysis = analyzeBashCommand(trimmed);
	if (analysis.parseError) return false;
	if (analysis.hasInputRedirection || analysis.hasOutputRedirection || analysis.hasSubstitution) return false;
	if (analysis.commandCount === 0) return false;
	if (analysis.requiresApproval) return false;
	if (analysis.hasUnknownCommand) return false;

	return analysis.hasReads && !analysis.hasWrites;
}

export function getBashCommandType(command: string): BashCommandType {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		return { hasReads: false, hasWrites: false, isPlainCommand: false };
	}

	const analysis = analyzeBashCommand(trimmed);
	if (analysis.parseError) {
		return { hasReads: false, hasWrites: false, isPlainCommand: false };
	}

	return {
		hasReads: analysis.hasReads || analysis.hasInputRedirection,
		hasWrites: analysis.hasWrites || analysis.hasOutputRedirection,
		isPlainCommand: analysis.isPlainCommand,
	};
}

function analyzeBashCommand(command: string): BashPolicyAnalysis {
	const analysis: BashPolicyAnalysis = {
		hasReads: false,
		hasWrites: false,
		hasPipe: false,
		hasOtherControlFlow: false,
		hasInputRedirection: false,
		hasOutputRedirection: false,
		hasSubstitution: false,
		hasUnknownCommand: false,
		requiresApproval: false,
		parseError: false,
		commandCount: 0,
		isPlainCommand: false,
	};

	if (command.endsWith("\\")) {
		analysis.parseError = true;
		return analysis;
	}

	let ast: any;
	try {
		ast = parseBash(command);
	} catch {
		analysis.parseError = true;
		return analysis;
	}

	evaluateAstNode(ast, analysis);

	analysis.isPlainCommand = isSinglePlainCommand(ast, analysis);
	return analysis;
}

function evaluateAstNode(node: any, analysis: BashPolicyAnalysis): void {
	if (!node || typeof node !== "object") return;

	switch (node.type) {
		case "Script": {
			const commands = asArray(node.commands);
			if (commands.length > 1) analysis.hasOtherControlFlow = true;
			for (const command of commands) evaluateAstNode(command, analysis);
			return;
		}
		case "LogicalExpression":
			analysis.hasOtherControlFlow = true;
			evaluateAstNode(node.left, analysis);
			evaluateAstNode(node.right, analysis);
			return;
		case "Pipeline": {
			analysis.hasPipe = true;
			for (const command of asArray(node.commands)) evaluateAstNode(command, analysis);
			return;
		}
		case "Command":
			evaluateCommandNode(node, analysis);
			return;
		case "Subshell":
			analysis.hasOtherControlFlow = true;
			evaluateAstNode(node.list, analysis);
			return;
		case "CompoundList":
			for (const command of asArray(node.commands)) evaluateAstNode(command, analysis);
			return;
		case "If":
			analysis.hasOtherControlFlow = true;
			evaluateAstNode(node.clause, analysis);
			evaluateAstNode(node.then, analysis);
			evaluateAstNode(node.else, analysis);
			return;
		case "For":
		case "While":
		case "Until":
			analysis.hasOtherControlFlow = true;
			evaluateAstNode(node.clause, analysis);
			evaluateAstNode(node.do, analysis);
			return;
		case "Case":
			analysis.hasOtherControlFlow = true;
			evaluateAstNode(node.clause, analysis);
			for (const item of asArray(node.cases)) {
				evaluateAstNode(item, analysis);
			}
			return;
		case "Function":
			analysis.hasOtherControlFlow = true;
			evaluateAstNode(node.body, analysis);
			return;
		default:
			return;
	}
}

function evaluateCommandNode(node: any, analysis: BashPolicyAnalysis): void {
	analysis.commandCount += 1;
	if (node.async) analysis.hasOtherControlFlow = true;

	const words = collectCommandWords(node);
	for (const word of words) {
		evaluateWordExpansions(word, analysis);
	}

	const redirects = collectRedirectNodes(node);
	for (const redirect of redirects) {
		const op = getRedirectOperator(redirect);
		if (op.includes(">")) analysis.hasOutputRedirection = true;
		if (op.includes("<")) analysis.hasInputRedirection = true;
		evaluateWordExpansions(redirect?.file, analysis);
	}

	const command = extractAstCommand(node);
	if (!command) {
		analysis.hasUnknownCommand = true;
		return;
	}

	const classification = classifyCommand(command.program, command.args, command.hasDynamicArgs);
	analysis.hasReads = analysis.hasReads || classification.hasReads;
	analysis.hasWrites = analysis.hasWrites || classification.hasWrites;
	analysis.requiresApproval = analysis.requiresApproval || needsCommandApproval(command.program, command.args, command.hasDynamicArgs);

	if (!classification.hasReads && !classification.hasWrites) {
		analysis.hasUnknownCommand = true;
	}
}

function extractAstCommand(node: any): { program: string; args: string[]; hasDynamicArgs: boolean } | undefined {
	const name = extractWordText(node?.name);
	if (!name) return undefined;

	const program = normalizeExecutable(name);
	const args: string[] = [];
	let hasDynamicArgs = hasWordExpansion(node?.name);

	for (const item of asArray(node?.suffix)) {
		if (!item || item.type !== "Word") continue;
		const text = extractWordText(item);
		if (text.length === 0) continue;
		args.push(text);
		if (hasWordExpansion(item)) hasDynamicArgs = true;
	}

	return { program, args, hasDynamicArgs };
}

function collectCommandWords(node: any): any[] {
	const words: any[] = [];
	for (const item of [...asArray(node?.prefix), ...asArray(node?.suffix)]) {
		if (!item) continue;
		if (item.type === "Word" || item.type === "AssignmentWord") words.push(item);
	}
	if (node?.name) words.push(node.name);
	return words;
}

function collectRedirectNodes(node: any): any[] {
	const redirects: any[] = [];
	for (const item of [...asArray(node?.prefix), ...asArray(node?.suffix)]) {
		if (!item) continue;
		if (item.type === "Redirect" || isStandaloneRedirectToken(item)) redirects.push(item);
	}
	return redirects;
}

function getRedirectOperator(node: any): string {
	if (!node || typeof node !== "object") return "";
	if (typeof node?.op?.text === "string") return node.op.text;
	if (typeof node?.text === "string") return node.text;
	return "";
}

function isStandaloneRedirectToken(node: any): boolean {
	if (!node || typeof node?.type !== "string") return false;
	return REDIRECT_TOKEN_TYPES.has(node.type);
}

const REDIRECT_TOKEN_TYPES = new Set([
	"less",
	"great",
	"dgreat",
	"clobber",
	"lessand",
	"greatand",
	"lessgreat",
	"dless",
	"dlessdash",
]);

function evaluateWordExpansions(word: any, analysis: BashPolicyAnalysis): void {
	if (!word || typeof word !== "object") return;
	const expansions = asArray(word.expansion);
	if (expansions.length === 0) return;

	analysis.hasSubstitution = true;
	for (const expansion of expansions) {
		if (expansion?.type === "CommandExpansion" && expansion.commandAST) {
			evaluateAstNode(expansion.commandAST, analysis);
		}
	}
}

function hasWordExpansion(word: any): boolean {
	return asArray(word?.expansion).length > 0;
}

function extractWordText(word: any): string {
	if (!word || typeof word.text !== "string") return "";
	return word.text;
}

function isSinglePlainCommand(ast: any, analysis: BashPolicyAnalysis): boolean {
	if (!ast || ast.type !== "Script") return false;
	const commands = asArray(ast.commands);
	if (commands.length !== 1) return false;
	const only = commands[0];
	if (!only || only.type !== "Command") return false;
	if (only.async) return false;
	if (analysis.hasPipe || analysis.hasOtherControlFlow || analysis.hasSubstitution) return false;
	if (analysis.hasInputRedirection || analysis.hasOutputRedirection) return false;
	return true;
}

function asArray<T>(value: T | T[] | undefined): T[] {
	if (Array.isArray(value)) return value;
	if (value === undefined || value === null) return [];
	return [value];
}

function needsCommandApproval(program: string, args: string[], hasDynamicArgs: boolean): boolean {
	if (program !== "find") return false;
	return hasFindWriteLikeArgs(args) || hasDynamicArgs;
}

function classifyCommand(program: string, args: string[], hasDynamicArgs: boolean): { hasReads: boolean; hasWrites: boolean } {
	if (program === "find") {
		if (hasFindWriteLikeArgs(args) || hasDynamicArgs) {
			return { hasReads: false, hasWrites: true };
		}
		return { hasReads: true, hasWrites: false };
	}

	if (program === "command") {
		if (isReadOnlyCommandBuiltinArgs(args)) {
			return { hasReads: true, hasWrites: false };
		}
		return { hasReads: false, hasWrites: false };
	}

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

function hasFindWriteLikeArgs(args: string[]): boolean {
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

function isReadOnlyCommandBuiltinArgs(args: string[]): boolean {
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

function normalizeExecutable(rawProgram: string): string {
	const segments = rawProgram.split("/");
	const last = segments[segments.length - 1] ?? rawProgram;
	return last.toLowerCase();
}

function normalizeToolPath(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.replace(/^@+/, "");
}

function resolvePathInput(pathValue: string, projectRoot: string): string {
	if (pathValue === "~") return homedir();
	if (pathValue.startsWith("~/")) return resolve(homedir(), pathValue.slice(2));
	const absoluteProjectRoot = resolve(projectRoot);
	return resolve(absoluteProjectRoot, pathValue);
}

function isPathInsideProject(pathValue: string, projectRoot: string): boolean {
	const absoluteProjectRoot = resolve(projectRoot);
	const absolutePath = resolvePathInput(pathValue, absoluteProjectRoot);
	const rel = relative(absoluteProjectRoot, absolutePath);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
