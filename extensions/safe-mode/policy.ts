import { isAbsolute, relative, resolve, sep } from "node:path";

export const SAFE_MODES = ["paranoid", "reader", "smart", "yolo"] as const;
export type SafeMode = (typeof SAFE_MODES)[number];

export const DEFAULT_SAFE_MODE: SafeMode = "yolo";

const READ_ONLY_TOOLS = new Set(["read", "ls", "find", "grep"]);

const READ_ONLY_BASH_PATTERNS: RegExp[] = [
	/^\s*cat\b/i,
	/^\s*head\b/i,
	/^\s*tail\b/i,
	/^\s*less\b/i,
	/^\s*more\b/i,
	/^\s*grep\b/i,
	/^\s*find\b/i,
	/^\s*rg\b/i,
	/^\s*fd\b/i,
	/^\s*ls\b/i,
	/^\s*pwd\b/i,
	/^\s*tree\b/i,
	/^\s*whoami\b/i,
	/^\s*id\b/i,
	/^\s*date\b/i,
	/^\s*uname\b/i,
	/^\s*uptime\b/i,
	/^\s*env\b/i,
	/^\s*printenv\b/i,
	/^\s*git\s+(status|log|diff|branch|show)\b/i,
];

const BASH_AMBIGUOUS_OR_WRITE_PATTERNS: RegExp[] = [
	/&&/,
	/\|\|/,
	/;/,
	/\|/,
	/\n/,
	/`/,
	/\$\(/,
	/(^|[^<])>(?!>)/,
	/>>/,
];

const BASH_DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bnpm\s+(install|uninstall|update|ci|publish)\b/i,
	/\byarn\s+(add|remove|install|upgrade)\b/i,
	/\bpnpm\s+(add|remove|install|update)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|tag)\b/i,
	/\bsudo\b/i,
];

export type ToolCallLike = {
	toolName: string;
	input: Record<string, unknown>;
};

export interface ToolDecision {
	action: "allow" | "confirm" | "block";
	reason?: string;
	summary: string;
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

	if (BASH_AMBIGUOUS_OR_WRITE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
		return false;
	}

	if (BASH_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
		return false;
	}

	return READ_ONLY_BASH_PATTERNS.some((pattern) => pattern.test(trimmed));
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
