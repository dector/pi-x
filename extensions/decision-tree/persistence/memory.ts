import type { IndexDoc, RawEntry, SessionDoc, TreeDoc } from "../core/types";
import { MissingIndexError, ProjectNotInitializedError, TreeNotFoundError } from "./errors";
import type { DecisionTreePersistence, InitResult } from "./types";
import { resolveStoragePaths } from "./types";

type ProjectState = {
	initialized: boolean;
	index?: IndexDoc;
	session?: SessionDoc;
	trees: Map<string, TreeDoc>;
	raw: Map<string, RawEntry[]>;
};

function clone<T>(value: T): T {
	return structuredClone(value);
}

function defaultIndex(): IndexDoc {
	return {
		version: 1,
		history: {
			capture_default: true,
		},
	};
}

export class MemoryDecisionTreePersistence implements DecisionTreePersistence {
	private readonly projects = new Map<string, ProjectState>();

	async isInitialized(projectRoot: string): Promise<boolean> {
		return this.projects.get(projectRoot)?.initialized === true;
	}

	async init(projectRoot: string): Promise<InitResult> {
		const existing = this.projects.get(projectRoot);
		if (existing?.initialized) {
			return { initialized: true, created: false, decisionsPath: resolveStoragePaths(projectRoot).decisionsDir };
		}

		this.projects.set(projectRoot, {
			initialized: true,
			index: existing?.index ?? defaultIndex(),
			session: existing?.session,
			trees: existing?.trees ?? new Map<string, TreeDoc>(),
			raw: existing?.raw ?? new Map<string, RawEntry[]>(),
		});
		return { initialized: true, created: true, decisionsPath: resolveStoragePaths(projectRoot).decisionsDir };
	}

	async loadIndex(projectRoot: string): Promise<IndexDoc> {
		const state = this.requireInitialized(projectRoot);
		if (!state.index) throw new MissingIndexError(projectRoot);
		return clone(state.index);
	}

	async saveIndex(projectRoot: string, index: IndexDoc): Promise<void> {
		const state = this.requireInitialized(projectRoot);
		state.index = clone(index);
	}

	async loadSession(projectRoot: string): Promise<SessionDoc | null> {
		const state = this.requireInitialized(projectRoot);
		return state.session ? clone(state.session) : null;
	}

	async saveSession(projectRoot: string, session: SessionDoc): Promise<void> {
		const state = this.requireInitialized(projectRoot);
		state.session = clone(session);
	}

	async listTreeIds(projectRoot: string): Promise<string[]> {
		const state = this.requireInitialized(projectRoot);
		return [...state.trees.keys()];
	}

	async loadTree(projectRoot: string, treeId: string): Promise<TreeDoc> {
		const state = this.requireInitialized(projectRoot);
		const tree = state.trees.get(treeId);
		if (!tree) throw new TreeNotFoundError(projectRoot, treeId);
		return clone(tree);
	}

	async saveTree(projectRoot: string, tree: TreeDoc): Promise<void> {
		const state = this.requireInitialized(projectRoot);
		state.trees.set(tree.id, clone(tree));
		if (!state.raw.has(tree.id)) state.raw.set(tree.id, []);
	}

	async appendRaw(projectRoot: string, treeId: string, entry: RawEntry): Promise<void> {
		const state = this.requireInitialized(projectRoot);
		this.requireTree(state, projectRoot, treeId);
		const entries = state.raw.get(treeId) ?? [];
		entries.push(clone(entry));
		state.raw.set(treeId, entries);
	}

	async readRaw(projectRoot: string, treeId: string, ids?: readonly string[]): Promise<RawEntry[]> {
		const state = this.requireInitialized(projectRoot);
		this.requireTree(state, projectRoot, treeId);
		const entries = state.raw.get(treeId) ?? [];
		if (!ids) return clone(entries);

		const requested = new Set(ids);
		return clone(entries.filter((entry) => requested.has(entry.id)));
	}

	private requireInitialized(projectRoot: string): ProjectState {
		const state = this.projects.get(projectRoot);
		if (!state?.initialized) throw new ProjectNotInitializedError(projectRoot);
		return state;
	}

	private requireTree(state: ProjectState, projectRoot: string, treeId: string): TreeDoc {
		const tree = state.trees.get(treeId);
		if (!tree) throw new TreeNotFoundError(projectRoot, treeId);
		return tree;
	}
}
