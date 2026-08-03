import { expect, test } from "bun:test";
import { MemoryDecisionTreePersistence } from "../persistence/memory";
import { DecisionTreeService } from "./service";

const projectRoot = "/repo-overview";

async function ready() {
	const persistence = new MemoryDecisionTreePersistence();
	const service = new DecisionTreeService(persistence);
	await service.init(projectRoot);
	const created = await service.createTree(projectRoot, { title: "Product", priority: "important" });
	return { service, treeId: created.tree.id, rootId: created.tree.root.id };
}

test("getTree defaults to overview mode and omits content-heavy leaf decisions", async () => {
	const { service, rootId } = await ready();
	const branch = await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "major", title: "Auth", question: "How should auth work?" });
	await service.createItem(projectRoot, { parent_id: branch.item.id, type: "decision", priority: "minor", question: "Which cookie name?", answer: "sid" });
	await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "nitpick", question: "Leaf hidden?", answer: "yes" });
	await service.updateItem(projectRoot, { item_id: branch.item.id, append_notes: [{ source: "tool", content: "Do not include in overview" }] });

	const result = await service.getTree(projectRoot);

	expect(result.mode).toBe("overview");
	expect(result.tree.root.children).toHaveLength(1);
	expect(result.tree.root.omitted_leaf_decision_count).toBe(1);
	const branchOverview = result.tree.root.children[0]!;
	expect(branchOverview.id).toBe(branch.item.id);
	expect(branchOverview.question).toBe("How should auth work?");
	expect(branchOverview.omitted_leaf_decision_count).toBe(1);
	expect(branchOverview.children).toEqual([]);
	expect(branchOverview).not.toHaveProperty("answer");
	expect(branchOverview).not.toHaveProperty("notes");
	expect(branchOverview).not.toHaveProperty("created_at");
});

test("full mode includes structured content and hides deleted notes by default", async () => {
	const { service, rootId } = await ready();
	const decision = await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "critical", question: "Ship?", answer: "yes" });
	const withNote = await service.updateItem(projectRoot, { item_id: decision.item.id, append_notes: [{ source: "user", content: "Visible" }] });
	await service.updateItem(projectRoot, { item_id: decision.item.id, append_notes: [{ source: "tool", content: "Deleted" }] });
	const itemWithBoth = await service.getItem(projectRoot, { item_id: decision.item.id, include_deleted_notes: true });
	const deletedNoteId = itemWithBoth.item.notes.find((note) => note.content === "Deleted")!.id;
	await service.updateNote(projectRoot, { item_id: decision.item.id, note_id: deletedNoteId, deleted_at: null });

	const full = await service.getTree(projectRoot, { mode: "full" });
	const fullDecision = full.tree.root.children[0]!;
	expect(full.mode).toBe("full");
	expect(fullDecision).toMatchObject({ id: decision.item.id, answer: "yes", answer_stage: "accepted" });
	expect(fullDecision.notes.map((note) => note.id)).toEqual([withNote.item.notes[0]!.id]);

	const includingDeleted = await service.getTree(projectRoot, { mode: "full", include_deleted_notes: true });
	expect(includingDeleted.tree.root.children[0]!.notes).toHaveLength(2);
});
