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
	trustedReadRoots?: string[];
}): ToolDecision {
	const { mode, toolName, input, projectRoot, outerAccess, trustedReadRoots } = args;
	const summary = describeToolCall(toolName, input);

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

