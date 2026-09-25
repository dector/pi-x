import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
	/**
	 * Safe-mode's outside-project access flag (`yolo+` and friends). Missing or
	 * malformed values must fail closed to `false`, which keeps the project-root
	 * safeguard in place.
	 */
	outerAccess?: boolean;
};

export function isHttpPermissionTool(toolName: string): boolean {
	return HTTP_PERMISSION_TOOLS.has(toolName);
}

/**
 * A MemoryFS-only read never touches the network. The caller must skip the
 * `perm:net` request entirely for these calls.
 */
export function isMemoryFsReadToolCall(toolName: string, input: Record<string, unknown>): boolean {
	if (!HTTP_PERMISSION_TOOLS.has(toolName)) return false;
	if (!input.memfs || typeof input.memfs !== "object") return false;
	return Object.entries(input).every(([key, value]) => key === "memfs" || value === undefined);
}

/**
 * Classify the non-network (filesystem/output-file) concerns of an
 * `http`/`http_md`/`web_search` tool call.
 *
 * Returns `undefined` when the call has no filesystem opinion, meaning the
 * caller must rely on the `perm:net` decision alone. Network disposition
 * (read-only method trust, policy) is owned by permissions-core and is
 * deliberately not duplicated here.
 */
export function classifyHttpFilesystemCall(args: HttpPermissionInput): HttpPermissionDecision | undefined {
	const { toolName, input, mode, projectRoot, outerAccess } = args;
	if (!HTTP_PERMISSION_TOOLS.has(toolName)) return undefined;

	if (isMemoryFsReadToolCall(toolName, input)) return { action: "allow" };

	if (toolName === "http_md" && input.spillMode === "to_file") {
		return { action: "confirm", reason: "HTTP Markdown to-file output requires approval." };
	}

	if (toolName === "http") {
		const outputFile = getHttpOutputFile(input);
		if (outputFile) {
			// `yolo+` is `yolo` with outside-project access, so it allows output
			// anywhere. Plain `yolo` still keeps the project-root boundary.
			if (mode === "yolo" && (outerAccess === true || isPathInsideProject(outputFile, projectRoot))) {
				return { action: "allow" };
			}
			return {
				action: "confirm",
				reason:
					mode === "yolo"
						? `HTTP output file targets outside project root (${projectRoot}).`
						: "HTTP file output requires approval.",
			};
		}
	}

	return undefined;
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
