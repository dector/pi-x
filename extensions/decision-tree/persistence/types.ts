import type { IndexDoc, RawEntry, SessionDoc, TreeDoc } from "../core/types";
export { resolveStoragePaths, type StoragePaths } from "./paths";

export type InitResult = {
	initialized: true;
	created: boolean;
	decisionsPath: string;
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
