import { isItemType, isNoteSource, isPriority, isRawRole, isStatus, priorityRank, SCHEMA_VERSION } from "./constants";
import { newId } from "./ids";
import { nowIso } from "./time";
import type { AnswerStage, DecisionItem, GroupItem, Note, NoteSource, Priority, RawEntry, RawRole, SessionDoc, Status, TreeDoc, TreeItem } from "./types";
import { assertValidTreeDoc, cloneTree, withoutDeletedNotes } from "./validation";
import { findItem, itemPath, walkItems } from "./traversal";
import { treeOverview } from "./overview";
import { treeAsMarkdown } from "./markdown";
import type { DecisionTreePersistence } from "../persistence/types";

export class DecisionTreeServiceError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = new.target.name;
		this.code = code;
	}
}

export type ResolvedContext = { tree_id: string; item_id?: string; path?: string; used_active_tree: boolean; used_active_item: boolean };
export type TreeMode = "overview" | "full";

export class DecisionTreeService {
	constructor(private readonly persistence: DecisionTreePersistence) {}

	async init(projectRoot: string) {
		return this.persistence.init(projectRoot);
	}

	async getSession(projectRoot: string): Promise<{ initialized: boolean; session: SessionDoc | null }> {
		const initialized = await this.persistence.isInitialized(projectRoot);
		return { initialized, session: initialized ? await this.persistence.loadSession(projectRoot) : null };
	}

	async createTree(projectRoot: string, input: { title: string; priority: Priority }) {
		if (!input.title?.trim()) throw new DecisionTreeServiceError("invalid_title", "tree title is required");
		assertPriority(input.priority);
		const timestamp = nowIso();
		const treeId = newId();
		const rootId = newId();
		const root: GroupItem = baseItem({ id: rootId, type: "group", priority: input.priority, title: "", status: "open", timestamp });
		const tree: TreeDoc = {
			version: SCHEMA_VERSION,
			id: treeId,
			title: input.title.trim(),
			status: "open",
			history: { capture: null },
			root,
			created_at: timestamp,
			updated_at: timestamp,
		};
		assertValidTreeDoc(tree);
		await this.persistence.saveTree(projectRoot, tree);
		await this.saveSession(projectRoot, treeId, rootId);
		return { tree, resolved: { tree_id: treeId, item_id: rootId, path: tree.title, used_active_tree: false, used_active_item: false } satisfies ResolvedContext };
	}

	async listTrees(projectRoot: string) {
		const session = await this.persistence.loadSession(projectRoot);
		const ids = await this.persistence.listTreeIds(projectRoot);
		const trees = await Promise.all(ids.map((id) => this.persistence.loadTree(projectRoot, id)));
		return trees.map((tree) => ({ id: tree.id, title: tree.title, status: tree.status, updated_at: tree.updated_at, active: tree.id === session?.active_tree_id }));
	}

	async selectTree(projectRoot: string, treeIdOrPrefix: string) {
		const tree = await this.resolveTreeByPrefix(projectRoot, treeIdOrPrefix);
		const session = await this.persistence.loadSession(projectRoot);
		let itemId = session?.active_tree_id === tree.id ? session.active_item_id : null;
		if (!itemId || !findItem(tree, itemId)) itemId = tree.root.id;
		await this.saveSession(projectRoot, tree.id, itemId);
		const loc = findItem(tree, itemId)!;
		return { tree: summaryTree(tree), active_item_id: itemId, path: itemPath(tree, loc.path) };
	}

	async getTree(projectRoot: string, options: { tree_id?: string; mode?: TreeMode; include_deleted_notes?: boolean } = {}) {
		const { tree, usedActive } = await this.resolveTree(projectRoot, options.tree_id);
		if (options.mode === "full") {
			const full = options.include_deleted_notes ? cloneTree(tree) : { ...tree, root: withoutDeletedNotes(tree.root) };
			return { mode: "full" as const, tree: full, resolved: { tree_id: tree.id, used_active_tree: usedActive, used_active_item: false } satisfies ResolvedContext };
		}
		return { mode: "overview" as const, tree: treeOverview(tree), resolved: { tree_id: tree.id, used_active_tree: usedActive, used_active_item: false } satisfies ResolvedContext };
	}

	async asMarkdown(projectRoot: string, options: { tree_id?: string; include_deleted_notes?: boolean } = {}) {
		const { tree, usedActive } = await this.resolveTree(projectRoot, options.tree_id);
		return { markdown: treeAsMarkdown(tree, { include_deleted_notes: options.include_deleted_notes }), resolved: { tree_id: tree.id, used_active_tree: usedActive, used_active_item: false } satisfies ResolvedContext };
	}

	async getItem(projectRoot: string, options: { tree_id?: string; item_id?: string; include_path?: boolean; children_depth?: number; include_deleted_notes?: boolean } = {}) {
		const { tree, usedActive: usedTree } = await this.resolveTree(projectRoot, options.tree_id);
		const { itemId, usedActive: usedItem } = await this.resolveItemId(projectRoot, tree, options.item_id);
		const loc = requireItem(tree, itemId);
		const item = projectItem(loc.item, options.children_depth ?? 0, options.include_deleted_notes === true);
		return {
			item,
			path: options.include_path === false ? undefined : itemPath(tree, loc.path),
			ancestors: options.include_path === false ? undefined : loc.path.slice(0, -1).map((ancestor) => ({ id: ancestor.id, type: ancestor.type, title: ancestor.title })),
			resolved: { tree_id: tree.id, item_id: itemId, path: itemPath(tree, loc.path), used_active_tree: usedTree, used_active_item: usedItem } satisfies ResolvedContext,
		};
	}

	async createItem(projectRoot: string, input: { tree_id?: string; parent_id?: string; type: "group" | "decision"; priority: Priority; title?: string | null; question?: string; answer?: string | null; answer_stage?: AnswerStage | null; status?: Status }) {
		assertItemType(input.type);
		assertPriority(input.priority);
		const { tree, usedActive: usedTree } = await this.resolveTree(projectRoot, input.tree_id);
		const { itemId: parentId, usedActive: usedParent } = await this.resolveItemId(projectRoot, tree, input.parent_id);
		const parent = requireItem(tree, parentId).item;
		const timestamp = nowIso();
		const item = input.type === "group" ? createGroup(input, timestamp) : createDecision(input, timestamp);
		parent.children.push(item);
		touchItem(parent, timestamp);
		touchTree(tree, timestamp);
		assertValidTreeDoc(tree);
		await this.persistence.saveTree(projectRoot, tree);
		await this.saveSession(projectRoot, tree.id, item.id);
		const loc = requireItem(tree, item.id);
		return { item, resolved: { tree_id: tree.id, item_id: item.id, path: itemPath(tree, loc.path), used_active_tree: usedTree, used_active_item: usedParent } satisfies ResolvedContext };
	}

	async updateItem(projectRoot: string, input: { tree_id?: string; item_id?: string; priority?: Priority; title?: string | null; question?: string; answer?: string | null; answer_stage?: AnswerStage | null; status?: Status; append_notes?: { source: NoteSource; content: string }[]; append_raw_refs?: string[] }) {
		const { tree, usedActive: usedTree } = await this.resolveTree(projectRoot, input.tree_id);
		const { itemId, usedActive: usedItem } = await this.resolveItemId(projectRoot, tree, input.item_id);
		const loc = requireItem(tree, itemId);
		const item = loc.item;
		if (input.priority !== undefined) { assertPriority(input.priority); item.priority = input.priority; }
		if (input.status !== undefined) { assertStatus(input.status); item.status = input.status; }
		if (input.title !== undefined) item.title = item.type === "group" ? required(input.title, "group title") : normalizeNullable(input.title);
		if (item.type === "decision") {
			if (input.question !== undefined) item.question = required(input.question, "question");
			if (input.answer !== undefined) {
				item.answer = normalizeNullable(input.answer);
				item.answer_stage = item.answer ? (input.answer_stage ?? "accepted") : null;
				if (!input.status) item.status = item.answer ? "answered" : "open";
			} else if (input.answer_stage !== undefined) {
				item.answer_stage = input.answer_stage;
			}
		} else if (input.question !== undefined || input.answer !== undefined || input.answer_stage !== undefined) {
			throw new DecisionTreeServiceError("invalid_patch", "question/answer fields apply only to decisions");
		}
		if (input.append_notes) item.notes.push(...input.append_notes.map(makeNote));
		if (input.append_raw_refs) item.raw_refs.push(...input.append_raw_refs);
		const timestamp = nowIso();
		touchItem(item, timestamp);
		touchTree(tree, timestamp);
		assertValidTreeDoc(tree);
		await this.persistence.saveTree(projectRoot, tree);
		return { item, resolved: { tree_id: tree.id, item_id: itemId, path: itemPath(tree, loc.path), used_active_tree: usedTree, used_active_item: usedItem } satisfies ResolvedContext };
	}

	async updateNote(projectRoot: string, input: { tree_id?: string; item_id?: string; note_id: string; content?: string; source?: NoteSource; deleted_at?: string | null }) {
		const { tree, usedActive: usedTree } = await this.resolveTree(projectRoot, input.tree_id);
		const { itemId, usedActive: usedItem } = await this.resolveItemId(projectRoot, tree, input.item_id);
		const loc = requireItem(tree, itemId);
		const note = loc.item.notes.find((candidate) => candidate.id === input.note_id);
		if (!note) throw new DecisionTreeServiceError("note_not_found", `note not found: ${input.note_id}`);
		if (input.content !== undefined) note.content = required(input.content, "note content");
		if (input.source !== undefined) { assertNoteSource(input.source); note.source = input.source; }
		if (input.deleted_at !== undefined) note.deleted_at = input.deleted_at ?? nowIso();
		const timestamp = nowIso();
		touchItem(loc.item, timestamp);
		touchTree(tree, timestamp);
		assertValidTreeDoc(tree);
		await this.persistence.saveTree(projectRoot, tree);
		return { note, resolved: { tree_id: tree.id, item_id: itemId, path: itemPath(tree, loc.path), used_active_tree: usedTree, used_active_item: usedItem } satisfies ResolvedContext };
	}

	async setActiveItem(projectRoot: string, input: { tree_id?: string; item_id: string }) {
		const { tree, usedActive: usedTree } = await this.resolveTree(projectRoot, input.tree_id);
		const loc = requireItem(tree, input.item_id);
		await this.saveSession(projectRoot, tree.id, input.item_id);
		return { resolved: { tree_id: tree.id, item_id: input.item_id, path: itemPath(tree, loc.path), used_active_tree: usedTree, used_active_item: false } satisfies ResolvedContext };
	}

	async nextUnresolved(projectRoot: string, filters: { tree_id?: string; strategy?: "ranked" | "one"; priorities?: Priority[]; statuses?: Status[]; answer_stages?: (AnswerStage | null)[]; subtree_root_id?: string; limit?: number } = {}) {
		const trees = filters.tree_id ? [(await this.resolveTree(projectRoot, filters.tree_id)).tree] : await Promise.all((await this.persistence.listTreeIds(projectRoot)).map((id) => this.persistence.loadTree(projectRoot, id)));
		const matches: Array<{ tree_id: string; item_id: string; path: string; item: TreeItem }> = [];
		for (const tree of trees) {
			const start = filters.subtree_root_id ? requireItem(tree, filters.subtree_root_id).item : tree.root;
			walkItems(start, (item, path) => {
				if (!matchesUnresolved(item, filters)) return;
				matches.push({ tree_id: tree.id, item_id: item.id, path: itemPath(tree, filters.subtree_root_id ? requireItem(tree, filters.subtree_root_id!).path.slice(0, -1).concat(path) : path), item: shallowItem(item) });
			});
		}
		matches.sort((a, b) => priorityRank(a.item.priority) - priorityRank(b.item.priority));
		const limit = filters.strategy === "one" ? 1 : filters.limit;
		return { items: limit ? matches.slice(0, limit) : matches };
	}

	async appendRaw(projectRoot: string, input: { tree_id?: string; item_id?: string; role: RawRole; content: string }) {
		const { tree } = await this.resolveTree(projectRoot, input.tree_id);
		const index = await this.persistence.loadIndex(projectRoot);
		const capture = tree.history.capture ?? index.history.capture_default;
		if (!capture) return { appended: false, skipped: true, raw_id: null };
		assertRawRole(input.role);
		const entry: RawEntry = { id: newId(), timestamp: nowIso(), role: input.role, content: required(input.content, "raw content") };
		await this.persistence.appendRaw(projectRoot, tree.id, entry);
		if (input.item_id) await this.updateItem(projectRoot, { tree_id: tree.id, item_id: input.item_id, append_raw_refs: [entry.id] });
		return { appended: true, skipped: false, raw_id: entry.id };
	}

	private async resolveTree(projectRoot: string, treeId?: string): Promise<{ tree: TreeDoc; usedActive: boolean }> {
		if (treeId) return { tree: await this.resolveTreeByPrefix(projectRoot, treeId), usedActive: false };
		const session = await this.persistence.loadSession(projectRoot);
		if (!session?.active_tree_id) throw new DecisionTreeServiceError("missing_active_tree", "tree_id is required because no active tree is set");
		return { tree: await this.persistence.loadTree(projectRoot, session.active_tree_id), usedActive: true };
	}

	private async resolveTreeByPrefix(projectRoot: string, treeIdOrPrefix: string): Promise<TreeDoc> {
		const ids = await this.persistence.listTreeIds(projectRoot);
		const matches = ids.filter((id) => id === treeIdOrPrefix || id.startsWith(treeIdOrPrefix));
		if (matches.length === 0) throw new DecisionTreeServiceError("tree_not_found", `tree not found: ${treeIdOrPrefix}`);
		if (matches.length > 1) throw new DecisionTreeServiceError("ambiguous_tree_id", `tree id prefix is ambiguous: ${treeIdOrPrefix}`);
		return this.persistence.loadTree(projectRoot, matches[0]!);
	}

	private async resolveItemId(projectRoot: string, tree: TreeDoc, itemId?: string): Promise<{ itemId: string; usedActive: boolean }> {
		if (itemId) return { itemId, usedActive: false };
		const session = await this.persistence.loadSession(projectRoot);
		if (session?.active_tree_id === tree.id && session.active_item_id && findItem(tree, session.active_item_id)) return { itemId: session.active_item_id, usedActive: true };
		return { itemId: tree.root.id, usedActive: true };
	}

	private async saveSession(projectRoot: string, treeId: string | null, itemId: string | null): Promise<void> {
		const existing = await this.persistence.loadSession(projectRoot);
		const timestamp = nowIso();
		await this.persistence.saveSession(projectRoot, { version: 1, active_tree_id: treeId, active_item_id: itemId, created_at: existing?.created_at ?? timestamp, updated_at: timestamp });
	}
}

function baseItem<T extends "group" | "decision">(input: { id: string; type: T; priority: Priority; title: T extends "group" ? string : string | null; status: Status; timestamp: string }): T extends "group" ? GroupItem : DecisionItem {
	return { id: input.id, type: input.type, priority: input.priority, title: input.title, status: input.status, notes: [], raw_refs: [], children: [], created_at: input.timestamp, updated_at: input.timestamp } as T extends "group" ? GroupItem : DecisionItem;
}

function createGroup(input: { priority: Priority; title?: string | null; status?: Status }, timestamp: string): GroupItem {
	return baseItem({ id: newId(), type: "group", priority: input.priority, title: required(input.title, "group title"), status: input.status ?? "open", timestamp });
}

function createDecision(input: { priority: Priority; title?: string | null; question?: string; answer?: string | null; answer_stage?: AnswerStage | null; status?: Status }, timestamp: string): DecisionItem {
	const answer = normalizeNullable(input.answer);
	const item = baseItem({ id: newId(), type: "decision", priority: input.priority, title: normalizeNullable(input.title), status: input.status ?? (answer ? "answered" : "open"), timestamp }) as DecisionItem;
	item.question = required(input.question, "question");
	item.answer = answer;
	item.answer_stage = answer ? (input.answer_stage ?? "accepted") : null;
	return item;
}

function projectItem(item: TreeItem, depth: number, includeDeletedNotes: boolean): TreeItem {
	const projected = structuredClone(item);
	if (!includeDeletedNotes) projected.notes = projected.notes.filter((note) => note.deleted_at === null);
	if (depth <= 0) projected.children = [];
	else projected.children = item.children.map((child) => projectItem(child, depth - 1, includeDeletedNotes));
	return projected;
}

function shallowItem(item: TreeItem): TreeItem {
	return { ...structuredClone(item), children: [], notes: item.notes.filter((note) => note.deleted_at === null), raw_refs: [] };
}

function summaryTree(tree: TreeDoc) { return { id: tree.id, title: tree.title, status: tree.status, updated_at: tree.updated_at }; }
function touchTree(tree: TreeDoc, timestamp: string): void { tree.updated_at = timestamp; }
function touchItem(item: TreeItem, timestamp: string): void { item.updated_at = timestamp; }
function makeNote(input: { source: NoteSource; content: string }): Note { assertNoteSource(input.source); return { id: newId(), timestamp: nowIso(), source: input.source, content: required(input.content, "note content"), deleted_at: null }; }
function required(value: string | null | undefined, name: string): string { const normalized = normalizeNullable(value); if (!normalized) throw new DecisionTreeServiceError("invalid_input", `${name} is required`); return normalized; }
function normalizeNullable(value: string | null | undefined): string | null { if (value === undefined || value === null) return null; const trimmed = value.trim(); return trimmed.length ? trimmed : null; }
function requireItem(tree: TreeDoc, itemId: string) { const loc = findItem(tree, itemId); if (!loc) throw new DecisionTreeServiceError("item_not_found", `item not found: ${itemId}`); return loc; }
function assertPriority(value: unknown): asserts value is Priority { if (!isPriority(value)) throw new DecisionTreeServiceError("invalid_priority", "invalid priority"); }
function assertStatus(value: unknown): asserts value is Status { if (!isStatus(value)) throw new DecisionTreeServiceError("invalid_status", "invalid status"); }
function assertItemType(value: unknown): asserts value is "group" | "decision" { if (!isItemType(value)) throw new DecisionTreeServiceError("invalid_item_type", "invalid item type"); }
function assertNoteSource(value: unknown): asserts value is NoteSource { if (!isNoteSource(value)) throw new DecisionTreeServiceError("invalid_note_source", "invalid note source"); }
function assertRawRole(value: unknown): asserts value is RawRole { if (!isRawRole(value)) throw new DecisionTreeServiceError("invalid_raw_role", "invalid raw role"); }
function matchesUnresolved(item: TreeItem, filters: { priorities?: Priority[]; statuses?: Status[]; answer_stages?: (AnswerStage | null)[] }): boolean {
	if (filters.priorities && !filters.priorities.includes(item.priority)) return false;
	if (filters.statuses && !filters.statuses.includes(item.status)) return false;
	if (item.type === "decision" && filters.answer_stages && !filters.answer_stages.includes(item.answer_stage)) return false;
	if (filters.statuses || filters.answer_stages) return filters.statuses?.includes(item.status) || (item.type === "decision" && filters.answer_stages?.includes(item.answer_stage));
	return item.status === "open" || (item.type === "decision" && item.answer_stage === "need_approval");
}
