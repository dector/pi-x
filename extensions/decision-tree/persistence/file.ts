/// <reference path="./node-shims.d.ts" />

import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IndexDoc, RawEntry, SessionDoc, TreeDoc } from "../core/types";
import { assertValidIndexDoc, assertValidRawEntry, assertValidSessionDoc, assertValidTreeDoc } from "../core/validation";
import { MalformedJsonError, MissingIndexError, PersistenceValidationError, ProjectNotInitializedError, TreeNotFoundError } from "./errors";
import { resolveStoragePaths } from "./paths";
import type { DecisionTreePersistence, InitResult } from "./types";

const GITIGNORE_CONTENT = "session.json\n";

function defaultIndex(): IndexDoc {
	return {
		version: 1,
		history: {
			capture_default: true,
		},
	};
}

export class FileDecisionTreePersistence implements DecisionTreePersistence {
	async isInitialized(projectRoot: string): Promise<boolean> {
		const paths = resolveStoragePaths(projectRoot);
		return (await exists(paths.decisionsDir)) && (await exists(paths.treesDir));
	}

	async init(projectRoot: string): Promise<InitResult> {
		const paths = resolveStoragePaths(projectRoot);
		let created = false;

		created = (await ensureDir(paths.decisionsDir)) || created;
		created = (await ensureDir(paths.treesDir)) || created;
		created = (await writeIfMissing(paths.indexFile, stableJson(defaultIndex()))) || created;
		created = (await writeIfMissing(`${paths.decisionsDir}/.gitignore`, GITIGNORE_CONTENT)) || created;

		return { initialized: true, created, decisionsPath: paths.decisionsDir };
	}

	async loadIndex(projectRoot: string): Promise<IndexDoc> {
		await this.requireInitialized(projectRoot);
		const paths = resolveStoragePaths(projectRoot);
		if (!(await exists(paths.indexFile))) throw new MissingIndexError(projectRoot);
		const value = await readJson(paths.indexFile);
		try {
			assertValidIndexDoc(value);
			return value;
		} catch (error) {
			throw new PersistenceValidationError(paths.indexFile, error);
		}
	}

	async saveIndex(projectRoot: string, index: IndexDoc): Promise<void> {
		await this.requireInitialized(projectRoot);
		await atomicWrite(resolveStoragePaths(projectRoot).indexFile, stableJson(index));
	}

	async loadSession(projectRoot: string): Promise<SessionDoc | null> {
		await this.requireInitialized(projectRoot);
		const paths = resolveStoragePaths(projectRoot);
		if (!(await exists(paths.sessionFile))) return null;
		const value = await readJson(paths.sessionFile);
		try {
			assertValidSessionDoc(value);
			return value;
		} catch (error) {
			throw new PersistenceValidationError(paths.sessionFile, error);
		}
	}

	async saveSession(projectRoot: string, session: SessionDoc): Promise<void> {
		await this.requireInitialized(projectRoot);
		await atomicWrite(resolveStoragePaths(projectRoot).sessionFile, stableJson(session));
	}

	async listTreeIds(projectRoot: string): Promise<string[]> {
		await this.requireInitialized(projectRoot);
		const paths = resolveStoragePaths(projectRoot);
		const entries = await readdir(paths.treesDir, { withFileTypes: true });
		const ids: string[] = [];

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			try {
				const tree = await this.loadTree(projectRoot, entry.name);
				ids.push(tree.id);
			} catch {
				// Discovery should be best-effort: one bad candidate must not hide all trees.
			}
		}

		return ids.sort();
	}

	async loadTree(projectRoot: string, treeId: string): Promise<TreeDoc> {
		await this.requireInitialized(projectRoot);
		const path = resolveStoragePaths(projectRoot).treeFile(treeId);
		if (!(await exists(path))) throw new TreeNotFoundError(projectRoot, treeId);
		const value = await readJson(path);
		try {
			assertValidTreeDoc(value);
			if (value.id !== treeId) throw new Error(`tree id ${value.id} does not match folder ${treeId}`);
			return value;
		} catch (error) {
			throw new PersistenceValidationError(path, error);
		}
	}

	async saveTree(projectRoot: string, tree: TreeDoc): Promise<void> {
		await this.requireInitialized(projectRoot);
		const paths = resolveStoragePaths(projectRoot);
		await mkdir(paths.treeDir(tree.id), { recursive: true });
		await atomicWrite(paths.treeFile(tree.id), stableJson(tree));
		await writeIfMissing(paths.rawFile(tree.id), "");
	}

	async appendRaw(projectRoot: string, treeId: string, entry: RawEntry): Promise<void> {
		await this.loadTree(projectRoot, treeId);
		const path = resolveStoragePaths(projectRoot).rawFile(treeId);
		await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
	}

	async readRaw(projectRoot: string, treeId: string, ids?: readonly string[]): Promise<RawEntry[]> {
		await this.loadTree(projectRoot, treeId);
		const path = resolveStoragePaths(projectRoot).rawFile(treeId);
		if (!(await exists(path))) return [];
		const content = await readFile(path, "utf8");
		const requested = ids ? new Set(ids) : null;
		const entries: RawEntry[] = [];

		for (const [index, line] of content.split(/\r?\n/).entries()) {
			if (line.trim().length === 0) continue;
			const value = parseJsonLine(path, line, index + 1);
			try {
				assertValidRawEntry(value);
			} catch (error) {
				throw new PersistenceValidationError(`${path}:${index + 1}`, error);
			}
			if (!requested || requested.has(value.id)) entries.push(value);
		}

		return entries;
	}

	private async requireInitialized(projectRoot: string): Promise<void> {
		if (!(await this.isInitialized(projectRoot))) throw new ProjectNotInitializedError(projectRoot);
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function ensureDir(path: string): Promise<boolean> {
	if (await exists(path)) return false;
	await mkdir(path, { recursive: true });
	return true;
}

async function writeIfMissing(path: string, content: string): Promise<boolean> {
	if (await exists(path)) return false;
	await atomicWrite(path, content);
	return true;
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
	await writeFile(tempPath, content, "utf8");
	await rename(tempPath, path);
}

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new MalformedJsonError(path, error);
	}
}

function parseJsonLine(path: string, line: string, lineNumber: number): unknown {
	try {
		return JSON.parse(line);
	} catch (error) {
		throw new MalformedJsonError(`${path}:${lineNumber}`, error);
	}
}

function stableJson(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}
