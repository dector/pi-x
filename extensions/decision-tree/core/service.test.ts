import { expect, test } from "bun:test";
import { MemoryDecisionTreePersistence } from "../persistence/memory";
import { DecisionTreeService } from "./service";

const projectRoot = "/repo";

async function ready() {
	const persistence = new MemoryDecisionTreePersistence();
	const service = new DecisionTreeService(persistence);
	await service.init(projectRoot);
	const created = await service.createTree(projectRoot, { title: "Product", priority: "important" });
	return { persistence, service, treeId: created.tree.id, rootId: created.tree.root.id };
}

test("service creates trees and active session", async () => {
	const { service, treeId, rootId } = await ready();
	const session = await service.getSession(projectRoot);
	expect(session.initialized).toBe(true);
	expect(session.session?.active_tree_id).toBe(treeId);
	expect(session.session?.active_item_id).toBe(rootId);

	const list = await service.listTrees(projectRoot);
	expect(list).toHaveLength(1);
	expect(list[0]).toMatchObject({ id: treeId, title: "Product", active: true });
});

test("service creates items using active parent and reads focused projections", async () => {
	const { service, treeId, rootId } = await ready();
	const group = await service.createItem(projectRoot, { type: "group", priority: "major", title: "UX" });
	const decision = await service.createItem(projectRoot, { parent_id: group.item.id, type: "decision", priority: "critical", question: "Use wizard?" });

	expect(group.resolved.used_active_item).toBe(true);
	expect(group.resolved.path).toBe("Product / UX");
	expect(decision.item.status).toBe("open");

	const root = await service.getItem(projectRoot, { tree_id: treeId, item_id: rootId, children_depth: 2 });
	expect(root.item.children[0]?.children[0]?.id).toBe(decision.item.id);
});

test("service updates decisions, notes, and hides deleted notes by default", async () => {
	const { service } = await ready();
	const decision = await service.createItem(projectRoot, { type: "decision", priority: "important", question: "Ship?", answer: "yes" });
	expect(decision.item.status).toBe("answered");
	expect(decision.item.answer_stage).toBe("accepted");

	const updated = await service.updateItem(projectRoot, {
		item_id: decision.item.id,
		answer: "yes, behind a flag",
		answer_stage: "need_approval",
		append_notes: [{ source: "user", content: "Needs PM approval" }],
	});
	const noteId = updated.item.notes[0]!.id;
	await service.updateNote(projectRoot, { item_id: decision.item.id, note_id: noteId, deleted_at: null });

	const hidden = await service.getItem(projectRoot, { item_id: decision.item.id });
	expect(hidden.item.notes).toHaveLength(0);
	const shown = await service.getItem(projectRoot, { item_id: decision.item.id, include_deleted_notes: true });
	expect(shown.item.notes).toHaveLength(1);
});

test("service overview omits leaf decisions and nextUnresolved ranks user attention", async () => {
	const { service, rootId } = await ready();
	await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "minor", question: "Minor open?" });
	const approval = await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "critical", question: "Critical approval?", answer: "maybe", answer_stage: "need_approval" });
	await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "important", question: "Polish?", answer: "rough", answer_stage: "need_polishing" });

	const overview = await service.getTree(projectRoot);
	expect(overview.tree.root.omitted_leaf_decision_count).toBe(3);

	const unresolved = await service.nextUnresolved(projectRoot);
	expect(unresolved.items[0]?.item_id).toBe(approval.item.id);
	expect(unresolved.items.some((entry) => entry.item.type === "decision" && entry.item.answer_stage === "need_polishing")).toBe(false);
});

test("service appendRaw skips when capture is disabled", async () => {
	const { service, persistence, treeId } = await ready();
	const tree = await persistence.loadTree(projectRoot, treeId);
	tree.history.capture = false;
	await persistence.saveTree(projectRoot, tree);

	const result = await service.appendRaw(projectRoot, { role: "user", content: "raw" });
	expect(result).toEqual({ appended: false, skipped: true, raw_id: null });
	expect(await persistence.readRaw(projectRoot, treeId)).toEqual([]);
});
