import { DECISIONS_DIR, INDEX_FILE, RAW_FILE, SESSION_FILE, TREE_FILE, TREES_DIR } from "../core/constants";

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
