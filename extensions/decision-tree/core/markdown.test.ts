import { expect, test } from "bun:test";
import { MemoryDecisionTreePersistence } from "../persistence/memory";
import { DecisionTreeService } from "./service";

const projectRoot = "/repo";

test("service renders tree as structured markdown", async () => {
	const persistence = new MemoryDecisionTreePersistence();
	const service = new DecisionTreeService(persistence);
	await service.init(projectRoot);
	const created = await service.createTree(projectRoot, { title: "Foo", priority: "important" });
	const group = await service.createItem(projectRoot, { parent_id: created.tree.root.id, type: "group", priority: "major", title: "Bar" });
	const decision = await service.createItem(projectRoot, { parent_id: group.item.id, type: "decision", priority: "critical", question: "Use markdown?", answer: "Yes" });
	await service.updateItem(projectRoot, { item_id: decision.item.id, append_notes: [{ source: "user", content: "Simple format." }] });

	const result = await service.asMarkdown(projectRoot, { tree_id: created.tree.id });
	expect(result.markdown).toBe(`# Foo\n\n## Bar\n\n### Use markdown?\n\nQ: Use markdown?\nA: Yes\nNotes:\n- user: Simple format.\n`);
});
