import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { classifySqliteQuery, normalizeSqliteToolInput } from "./sql";

export type SqlitePermissionAction = "allow" | "confirm" | "block";

export type SqlitePermissionDecision = {
	action: SqlitePermissionAction;
	reason?: string;
};

export type SqlitePermissionInput = {
	toolName: string;
	input: Record<string, unknown>;
	mode: string;
	projectRoot: string;
	outerAccess?: boolean;
	trustedReadRoots?: string[];
};

export function isSqlitePermissionTool(toolName: string): boolean {
	return toolName === "sqlite";
}

/**
 * Classify a `sqlite` tool call for safe-mode.
 * Moved out of safe-mode so the sqlite extension owns its own risk rules.
 * `paranoid` is handled globally by safe-mode before this runs.
 */
export function classifySqliteToolCall(args: SqlitePermissionInput): SqlitePermissionDecision | undefined {
	const { toolName, input, mode, projectRoot, outerAccess, trustedReadRoots } = args;
	if (!isSqlitePermissionTool(toolName)) return undefined;

	const normalized = normalizeSqliteToolInput(input);
	if (!normalized.ok) {
		return { action: "confirm", reason: "Unrecognized sqlite call requires approval." };
	}

	const { target, sql } = normalized.value;
	const readOnly = classifySqliteQuery(sql).kind === "read-only";
	const insideProject = target.kind === "memory" || isPathInsideProject(target.database, projectRoot);

	if (mode === "yolo") {
		if (outerAccess || insideProject) return { action: "allow" };
		return { action: "confirm", reason: `SQLite database targets outside project root (${projectRoot}).` };
	}

	if (readOnly) {
		if (insideProject || outerAccess) return { action: "allow" };
		if (isTrustedOutsideRead(target, projectRoot, trustedReadRoots)) return { action: "allow" };
		return { action: "confirm", reason: `SQLite database targets outside project root (${projectRoot}).` };
	}

	return { action: "confirm", reason: "SQLite mutation requires approval." };
}

function isTrustedOutsideRead(
	target: { kind: "memory" } | { kind: "file"; database: string },
	projectRoot: string,
	trustedReadRoots: string[] | undefined,
): boolean {
	if (target.kind !== "file") return false;
	const roots = normalizeTrustedReadRoots(trustedReadRoots, projectRoot);
	if (roots.length === 0) return false;
	return isPathInsideAnyRoot(target.database, projectRoot, roots);
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

function resolvePathInput(pathValue: string, projectRoot: string): string {
	if (pathValue === "~") return homedir();
	if (pathValue.startsWith("~/")) return resolve(homedir(), pathValue.slice(2));
	return resolve(projectRoot, pathValue);
}

function isPathInsideProject(pathValue: string, projectRoot: string): boolean {
	return isPathInsideBase(resolvePathInput(pathValue, projectRoot), resolve(projectRoot));
}

function isPathInsideAnyRoot(pathValue: string, projectRoot: string, trustedRoots: string[]): boolean {
	const absolutePath = resolvePathInput(pathValue, projectRoot);
	return trustedRoots.some((root) => isPathInsideBase(absolutePath, root));
}

function isPathInsideBase(absolutePath: string, base: string): boolean {
	const rel = relative(base, absolutePath);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
