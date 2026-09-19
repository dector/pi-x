import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const READ_ONLY_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HTTP_PERMISSION_TOOLS = new Set(["http", "http_md", "web_search"]);

export type HttpPermissionAction = "allow" | "confirm" | "block";

export type HttpPermissionDecision = {
	action: HttpPermissionAction;
	reason?: string;
};

export type HttpPermissionInput = {
	toolName: string;
	input: Record<string, unknown>;
	mode: string;
	projectRoot: string;
};

export function isHttpPermissionTool(toolName: string): boolean {
	return HTTP_PERMISSION_TOOLS.has(toolName);
}

/**
 * Classify an `http`/`http_md`/`web_search` tool call for safe-mode.
 * Moved out of safe-mode so the http extension owns its own risk rules.
 * `paranoid` is handled globally by safe-mode before this runs.
 */
export function classifyHttpToolCall(args: HttpPermissionInput): HttpPermissionDecision | undefined {
	const { toolName, input, mode, projectRoot } = args;
	if (!HTTP_PERMISSION_TOOLS.has(toolName)) return undefined;

	if (isMemoryFsReadToolCall(toolName, input)) return { action: "allow" };

	if (toolName === "http_md" && input.spillMode === "to_file") {
		return { action: "confirm", reason: "HTTP Markdown to-file output requires approval." };
	}

	if (toolName === "http") {
		const outputFile = getHttpOutputFile(input);
		if (outputFile) {
			if (mode === "yolo" && isPathInsideProject(outputFile, projectRoot)) return { action: "allow" };
			return {
				action: "confirm",
				reason:
					mode === "yolo"
						? `HTTP output file targets outside project root (${projectRoot}).`
						: "HTTP file output requires approval.",
			};
		}
	}

	if (mode === "yolo") return { action: "allow" };

	if ((toolName === "http" || toolName === "http_md") && !isReadOnlyHttpMethod(input)) {
		return { action: "confirm", reason: "HTTP auto-approval is limited to GET, HEAD, and OPTIONS." };
	}

	if (isReadOnlyHttpToolCall(toolName, input)) return { action: "allow" };
	if (isReadOnlyWebSearchToolCall(toolName, input)) return { action: "allow" };

	return { action: "confirm", reason: "HTTP operation requires approval." };
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
	return READ_ONLY_HTTP_METHODS.has(getHttpMethod(input));
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

function normalizeToolPath(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.replace(/^@+/, "");
}

function resolvePathInput(pathValue: string, projectRoot: string): string {
	if (pathValue === "~") return homedir();
	if (pathValue.startsWith("~/")) return resolve(homedir(), pathValue.slice(2));
	return resolve(projectRoot, pathValue);
}

function isPathInsideProject(pathValue: string, projectRoot: string): boolean {
	const absoluteProjectRoot = resolve(projectRoot);
	const absolutePath = resolvePathInput(pathValue, absoluteProjectRoot);
	const rel = relative(absoluteProjectRoot, absolutePath);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
