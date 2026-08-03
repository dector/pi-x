import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createDecisionTreePiContext } from "./context";
import { errorResult, okResult, shortId } from "./format";
import {
	DtCreateItemParams,
	DtCreateTreeParams,
	DtGetItemParams,
	DtGetSessionParams,
	DtGetTreeParams,
	DtInitParams,
	DtListTreesParams,
	DtNextUnresolvedParams,
	DtSelectTreeParams,
	DtSetActiveItemParams,
	DtUpdateItemParams,
	DtUpdateNoteParams,
} from "./schemas";
import type { AnswerStage, ItemType, NoteSource, Priority, Status } from "../core/types";

export function registerDecisionTreeTools(pi: ExtensionAPI): void {
	register(pi, {
		name: "dt_init",
		label: "Decision Tree Init",
		description: "Initialize project-local decision tree storage scaffolding.",
		promptSnippet: "Initialize decision tree storage before creating decision trees.",
		parameters: DtInitParams,
		execute: async (_params, cwd) => {
			const ctx = await createDecisionTreePiContext(cwd);
			try {
				const result = await ctx.service.init(ctx.projectRoot);
				return okResult(result.created ? "Decision tree storage initialized." : "Decision tree storage already initialized.", base(ctx, { ok: true, created: result.created }), responseOptions(_params));
			} catch (error) { return errorResult(error, base(ctx)); }
		},
	});

	register(pi, {
		name: "dt_get_session",
		label: "Decision Tree Session",
		description: "Return decision tree initialization and active context for this project.",
		promptSnippet: "Inspect active decision tree context.",
		parameters: DtGetSessionParams,
		execute: async (_params, cwd) => {
			const ctx = await createDecisionTreePiContext(cwd);
			try {
				const session = await ctx.service.getSession(ctx.projectRoot);
				let activePath: string | undefined;
				if (session.session?.active_tree_id) {
					try { activePath = (await ctx.service.getItem(ctx.projectRoot, { tree_id: session.session.active_tree_id, item_id: session.session.active_item_id ?? undefined })).path; } catch {}
				}
				return okResult("Decision tree session.", base(ctx, { ok: true, ...session, active_path: activePath }), responseOptions(_params));
			} catch (error) { return errorResult(error, base(ctx)); }
		},
	});

	register(pi, {
		name: "dt_create_tree",
		label: "Decision Tree Create Tree",
		description: "Create a decision tree and make its root active.",
		promptSnippet: "Create a new decision tree.",
		parameters: DtCreateTreeParams,
		execute: async (params, cwd) => {
			const ctx = await createDecisionTreePiContext(cwd);
			try {
				const result = await ctx.service.createTree(ctx.projectRoot, params as { title: string; priority: Priority });
				return okResult("Decision tree created.", base(ctx, { ok: true, tree: summarizeTree(result.tree), root_id: result.tree.root.id, resolved: resolvedWithTitle(result.resolved, result.tree.title) }), responseOptions(params));
			} catch (error) { return errorResult(error, base(ctx)); }
		},
	});

	register(pi, {
		name: "dt_list_trees",
		label: "Decision Tree List Trees",
		description: "List discovered decision trees for this project.",
		promptSnippet: "List project decision trees.",
		parameters: DtListTreesParams,
		execute: async (_params, cwd) => {
			const ctx = await createDecisionTreePiContext(cwd);
			try {
				const trees = await ctx.service.listTrees(ctx.projectRoot);
				return okResult("Decision trees listed.", base(ctx, { ok: true, count: trees.length, trees: trees.map((tree) => ({ ...tree, short_id: shortId(tree.id) })) }), responseOptions(_params));
			} catch (error) { return errorResult(error, base(ctx)); }
		},
	});

	register(pi, {
		name: "dt_select_tree",
		label: "Decision Tree Select Tree",
		description: "Select the active decision tree by UUID or unique prefix.",
		promptSnippet: "Select an active decision tree.",
		parameters: DtSelectTreeParams,
		execute: async (params, cwd) => {
			const ctx = await createDecisionTreePiContext(cwd);
			try {
				const result = await ctx.service.selectTree(ctx.projectRoot, (params as { tree_id: string }).tree_id);
				return okResult("Decision tree selected.", base(ctx, { ok: true, active_tree: result.tree, active_item_id: result.active_item_id, path: result.path }), responseOptions(params));
			} catch (error) { return errorResult(error, base(ctx)); }
		},
	});

	register(pi, {
		name: "dt_get_tree",
		label: "Decision Tree Get Tree",
		description: "Read a decision tree. Defaults to overview mode.",
		promptSnippet: "Read a decision tree overview or explicit full tree.",
		parameters: DtGetTreeParams,
		execute: async (params, cwd) => {
			const ctx = await createDecisionTreePiContext(cwd);
			try {
				const result = await ctx.service.getTree(ctx.projectRoot, params as { tree_id?: string; mode?: "overview" | "full"; include_deleted_notes?: boolean });
				const title = "title" in result.tree ? result.tree.title : undefined;
				return okResult(`Decision tree ${result.mode}.`, base(ctx, { ok: true, mode: result.mode, resolved: resolvedWithTitle(result.resolved, title), tree: result.tree }), responseOptions(params));
			} catch (error) { return errorResult(error, base(ctx)); }
		},
	});

	register(pi, {
		name: "dt_get_item",
		label: "Decision Tree Get Item",
		description: "Read one decision tree item with optional path and children depth.",
		promptSnippet: "Read a focused decision tree item.",
		parameters: DtGetItemParams,
		execute: async (params, cwd) => {
			const ctx = await createDecisionTreePiContext(cwd);
			try {
				const result = await ctx.service.getItem(ctx.projectRoot, params as { tree_id?: string; item_id?: string; include_path?: boolean; children_depth?: number; include_deleted_notes?: boolean });
				return okResult("Decision tree item.", base(ctx, { ok: true, ...result, resolved: await withTreeTitle(ctx, result.resolved) }), responseOptions(params));
			} catch (error) { return errorResult(error, base(ctx)); }
		},
	});

	register(pi, {
		name: "dt_create_item",
		label: "Decision Tree Create Item",
		description: "Create a group or decision item under a parent. New item becomes active.",
		promptSnippet: "Create a decision tree item.",
		parameters: DtCreateItemParams,
		execute: async (params, cwd) => {
			const ctx = await createDecisionTreePiContext(cwd);
			try {
				const result = await ctx.service.createItem(ctx.projectRoot, params as { tree_id?: string; parent_id?: string; type: ItemType; priority: Priority; title?: string | null; question?: string; answer?: string | null; answer_stage?: AnswerStage | null; status?: Status });
				return okResult("Decision tree item created.", base(ctx, { ok: true, ...result, resolved: await withTreeTitle(ctx, result.resolved) }), responseOptions(params));
			} catch (error) { return errorResult(error, base(ctx)); }
		},
	});

	register(pi, {
		name: "dt_update_item",
		label: "Decision Tree Update Item",
		description: "Patch scalar item fields and append notes/raw refs.",
		promptSnippet: "Update a decision tree item.",
		parameters: DtUpdateItemParams,
		execute: async (params, cwd) => {
			const ctx = await createDecisionTreePiContext(cwd);
			try {
				const result = await ctx.service.updateItem(ctx.projectRoot, params as { tree_id?: string; item_id?: string; priority?: Priority; title?: string | null; question?: string; answer?: string | null; answer_stage?: AnswerStage | null; status?: Status; append_notes?: { source: NoteSource; content: string }[]; append_raw_refs?: string[] });
				return okResult("Decision tree item updated.", base(ctx, { ok: true, ...result, resolved: await withTreeTitle(ctx, result.resolved) }), responseOptions(params));
			} catch (error) { return errorResult(error, base(ctx)); }
		},
	});

	register(pi, {
		name: "dt_update_note",
		label: "Decision Tree Update Note",
		description: "Edit or mark a note deleted on an item.",
		promptSnippet: "Update a decision tree note.",
		parameters: DtUpdateNoteParams,
		execute: async (params, cwd) => {
			const ctx = await createDecisionTreePiContext(cwd);
			try {
				const result = await ctx.service.updateNote(ctx.projectRoot, params as { tree_id?: string; item_id?: string; note_id: string; content?: string; source?: NoteSource; deleted_at?: string | null });
				return okResult("Decision tree note updated.", base(ctx, { ok: true, ...result, resolved: await withTreeTitle(ctx, result.resolved) }), responseOptions(params));
			} catch (error) { return errorResult(error, base(ctx)); }
		},
	});

	register(pi, {
		name: "dt_set_active_item",
		label: "Decision Tree Set Active Item",
		description: "Set the active item and return its computed path.",
		promptSnippet: "Set the active decision tree item.",
		parameters: DtSetActiveItemParams,
		execute: async (params, cwd) => {
			const ctx = await createDecisionTreePiContext(cwd);
			try {
				const result = await ctx.service.setActiveItem(ctx.projectRoot, params as { tree_id?: string; item_id: string });
				return okResult("Decision tree active item set.", base(ctx, { ok: true, ...result, resolved: await withTreeTitle(ctx, result.resolved) }), responseOptions(params));
			} catch (error) { return errorResult(error, base(ctx)); }
		},
	});

	register(pi, {
		name: "dt_next_unresolved",
		label: "Decision Tree Next Unresolved",
		description: "Return unresolved/user-attention decision tree items, ranked by priority and tree order.",
		promptSnippet: "Find the next unresolved decision tree items.",
		parameters: DtNextUnresolvedParams,
		execute: async (params, cwd) => {
			const ctx = await createDecisionTreePiContext(cwd);
			try {
				const result = await ctx.service.nextUnresolved(ctx.projectRoot, params as { tree_id?: string; strategy?: "ranked" | "one"; priorities?: Priority[]; statuses?: Status[]; answer_stages?: (AnswerStage | null)[]; subtree_root_id?: string; limit?: number });
				return okResult("Decision tree unresolved items.", base(ctx, { ok: true, count: result.items.length, ...result }), responseOptions(params));
			} catch (error) { return errorResult(error, base(ctx)); }
		},
	});
}

type Registration = {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	parameters: unknown;
	execute: (params: unknown, cwd: string) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>;
};

function register(pi: ExtensionAPI, tool: Registration): void {
	pi.registerTool({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		parameters: tool.parameters,
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(tool.name)), 0, 0);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await tool.execute(params, ctx.cwd);
		},
	});
}

function responseOptions(params: unknown): { returnJson: boolean } {
	return { returnJson: typeof params === "object" && params !== null && (params as { return_json?: unknown }).return_json === true };
}

function base(ctx: { projectRoot: string; decisionsPath: string }, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { project_root: ctx.projectRoot, decisions_path: ctx.decisionsPath, ...extra };
}

function summarizeTree(tree: { id: string; title: string; status: string; updated_at: string }) {
	return { id: tree.id, short_id: shortId(tree.id), title: tree.title, status: tree.status, updated_at: tree.updated_at };
}

function resolvedWithTitle(resolved: Record<string, unknown>, treeTitle: string | undefined) {
	return treeTitle ? { ...resolved, tree_title: treeTitle } : resolved;
}

async function withTreeTitle(ctx: { projectRoot: string; service: { getTree: (projectRoot: string, options: { tree_id?: string }) => Promise<{ tree: { title?: string } }> } }, resolved: Record<string, unknown>) {
	if (typeof resolved.tree_id !== "string") return resolved;
	try {
		const result = await ctx.service.getTree(ctx.projectRoot, { tree_id: resolved.tree_id });
		return resolvedWithTitle(resolved, result.tree.title);
	} catch {
		return resolved;
	}
}
