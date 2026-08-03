import { expect, test } from "bun:test";
import { MemoryDecisionTreePersistence } from "../persistence/memory";
import { DecisionTreeService } from "./service";

const projectRoot = "/repo-unresolved";

async function ready() {
	const persistence = new MemoryDecisionTreePersistence();
	const service = new DecisionTreeService(persistence);
	await service.init(projectRoot);
	const created = await service.createTree(projectRoot, { title: "Product", priority: "important" });
	return { service, rootId: created.tree.root.id };
}

test("default unresolved view includes open items and need_approval but excludes polishing", async () => {
	const { service, rootId } = await ready();
	const openGroup = await service.createItem(projectRoot, { parent_id: rootId, type: "group", priority: "minor", title: "Open group" });
	const approval = await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "critical", question: "Approve?", answer: "maybe", answer_stage: "need_approval" });
	const polishing = await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "important", question: "Polish?", answer: "rough", answer_stage: "need_polishing" });
	const resolved = await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "critical", question: "Resolved?", status: "resolved" });

	const result = await service.nextUnresolved(projectRoot);
	const ids = result.items.map((entry) => entry.item_id);

	expect(ids).toContain(openGroup.item.id);
	expect(ids).toContain(approval.item.id);
	expect(ids).not.toContain(polishing.item.id);
	expect(ids).not.toContain(resolved.item.id);
	expect(result.items[0]!.item_id).toBe(approval.item.id);
});

test("unresolved filters, priority ordering, strategy one, and limit are honored", async () => {
	const { service, rootId } = await ready();
	const minor = await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "minor", question: "Minor?" });
	const critical = await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "critical", question: "Critical?" });
	const majorPolish = await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "major", question: "Polish?", answer: "rough", answer_stage: "need_polishing" });
	await service.createItem(projectRoot, { parent_id: rootId, type: "decision", priority: "nitpick", question: "Nit?" });

	const polishing = await service.nextUnresolved(projectRoot, { answer_stages: ["need_polishing"] });
	expect(polishing.items.map((entry) => entry.item_id)).toEqual([majorPolish.item.id]);

	const ranked = await service.nextUnresolved(projectRoot, { statuses: ["open"], priorities: ["critical", "minor"], limit: 2 });
	expect(ranked.items.map((entry) => entry.item_id)).toEqual([critical.item.id, minor.item.id]);

	const one = await service.nextUnresolved(projectRoot, { statuses: ["open"], priorities: ["critical", "minor"], strategy: "one" });
	expect(one.items).toHaveLength(1);
	expect(one.items[0]!.item_id).toBe(critical.item.id);
});

test("tree order breaks priority ties and subtree filter limits results", async () => {
	const persistence = new MemoryDecisionTreePersistence();
	const service = new DecisionTreeService(persistence);
	await service.init(projectRoot);
	const firstTree = await service.createTree(projectRoot, { title: "First", priority: "important" });
	const firstItem = await service.createItem(projectRoot, { parent_id: firstTree.tree.root.id, type: "decision", priority: "major", question: "First?" });
	const secondTree = await service.createTree(projectRoot, { title: "Second", priority: "important" });
	const secondItem = await service.createItem(projectRoot, { parent_id: secondTree.tree.root.id, type: "decision", priority: "major", question: "Second?" });
	const subgroup = await service.createItem(projectRoot, { parent_id: secondTree.tree.root.id, type: "group", priority: "minor", title: "Subtree" });
	const inside = await service.createItem(projectRoot, { parent_id: subgroup.item.id, type: "decision", priority: "critical", question: "Inside?" });
	await service.createItem(projectRoot, { parent_id: secondTree.tree.root.id, type: "decision", priority: "critical", question: "Outside?" });

	const tied = await service.nextUnresolved(projectRoot, { priorities: ["major"] });
	expect(tied.items.map((entry) => entry.item_id)).toEqual([firstItem.item.id, secondItem.item.id]);

	const subtree = await service.nextUnresolved(projectRoot, { tree_id: secondTree.tree.id, subtree_root_id: subgroup.item.id });
	expect(subtree.items.map((entry) => entry.item_id)).toEqual([inside.item.id, subgroup.item.id]);
});
