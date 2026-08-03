import { DECISIONS_DIR, INDEX_FILE, RAW_FILE, SESSION_FILE, TREE_FILE, TREES_DIR } from "../core/constants";
import type { IndexDoc, RawEntry, SessionDoc, TreeDoc } from "../core/types";

export type InitResult = {
	initialized: true;
	created: boolean;
	decisionsPath: string;
};

export type StoragePaths = {
	projectRoot: string;
	decisionsDir: string;
	indexFile: string;
	sessionFile: string;
	treesDir: string;
	treeDir: (treeId: string) => string;
	treeFile: (treeId: string) => string;
	rawFile: (treeId: string) => string;
};

export interface DecisionTreePersistence {
	/** Returns whether project-local decision tree storage has been initialized. */
	isInitialized(projectRoot: string): Promise<boolean>;

	/** Idempotently creates storage scaffolding. Persistence does not own business validation. */
	init(projectRoot: string): Promise<InitResult>;

	loadIndex(projectRoot: string): Promise<IndexDoc>;
	saveIndex(projectRoot: string, index: IndexDoc): Promise<void>;

	/** Returns null when no local session exists. */
	loadSession(projectRoot: string): Promise<SessionDoc | null>;
	saveSession(projectRoot: string, session: SessionDoc): Promise<void>;

	/** Discovers trees from storage and returns tree IDs. */
	listTreeIds(projectRoot: string): Promise<string[]>;
	loadTree(projectRoot: string, treeId: string): Promise<TreeDoc>;
	saveTree(projectRoot: string, tree: TreeDoc): Promise<void>;

	appendRaw(projectRoot: string, treeId: string, entry: RawEntry): Promise<void>;
	readRaw(projectRoot: string, treeId: string, ids?: readonly string[]): Promise<RawEntry[]>;
}

export function resolveStoragePaths(projectRoot: string): StoragePaths {
	const decisionsDir = joinPath(projectRoot, DECISIONS_DIR);
	const treesDir = joinPath(decisionsDir, TREES_DIR);
	return {
		projectRoot,
		decisionsDir,
		indexFile: joinPath(decisionsDir, INDEX_FILE),
		sessionFile: joinPath(decisionsDir, SESSION_FILE),
		treesDir,
		treeDir: (treeId) => joinPath(treesDir, treeId),
		treeFile: (treeId) => joinPath(treesDir, treeId, TREE_FILE),
		rawFile: (treeId) => joinPath(treesDir, treeId, RAW_FILE),
	};
}

function joinPath(...parts: string[]): string {
	return parts
		.filter((part) => part.length > 0)
		.map((part, index) => {
			if (index === 0) return part.replace(/\/+$/g, "");
			return part.replace(/^\/+|\/+$/g, "");
		})
		.join("/");
}
