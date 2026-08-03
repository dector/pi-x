import { expect, test } from "bun:test";
import type { RawEntry, SessionDoc, TreeDoc } from "../core/types";
import { ProjectNotInitializedError, TreeNotFoundError } from "./errors";
import { MemoryDecisionTreePersistence } from "./memory";
import { resolveStoragePaths } from "./types";

const projectRoot = "/repo";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const now = "2026-01-02T03:04:05.000Z";

function validTree(treeId = id(1)): TreeDoc {
	return {
		version: 1,
		id: treeId,
		title: "Product decisions",
		status: "open",
		history: { capture: null },
		root: {
			id: id(2),
			type: "group",
			priority: "important",
			title: "",
			status: "open",
			notes: [],
			raw_refs: [],
			children: [],
			created_at: now,
			updated_at: now,
		},
		created_at: now,
		updated_at: now,
	};
}

function validSession(): SessionDoc {
	return {
		version: 1,
		active_tree_id: id(1),
		active_item_id: id(2),
		created_at: now,
		updated_at: now,
	};
}

function rawEntry(n: number): RawEntry {
	return {
		id: id(n),
		timestamp: now,
		role: "user",
		content: `raw ${n}`,
	};
}

test("resolveStoragePaths returns v1 project-local layout", () => {
	const paths = resolveStoragePaths("/repo");
	expect(paths.decisionsDir).toBe("/repo/docs/.decisions");
	expect(paths.indexFile).toBe("/repo/docs/.decisions/index.json");
	expect(paths.sessionFile).toBe("/repo/docs/.decisions/session.json");
	expect(paths.treesDir).toBe("/repo/docs/.decisions/trees");
	expect(paths.treeDir(id(1))).toBe(`/repo/docs/.decisions/trees/${id(1)}`);
	expect(paths.treeFile(id(1))).toBe(`/repo/docs/.decisions/trees/${id(1)}/tree.json`);
	expect(paths.rawFile(id(1))).toBe(`/repo/docs/.decisions/trees/${id(1)}/raw.jsonl`);
});

test("memory persistence initializes idempotently and creates default index", async () => {
	const persistence = new MemoryDecisionTreePersistence();
	expect(await persistence.isInitialized(projectRoot)).toBe(false);

	const first = await persistence.init(projectRoot);
	expect(first.created).toBe(true);
	expect(await persistence.isInitialized(projectRoot)).toBe(true);
	expect(await persistence.loadIndex(projectRoot)).toEqual({ version: 1, history: { capture_default: true } });

	const second = await persistence.init(projectRoot);
	expect(second.created).toBe(false);
});

test("memory persistence requires initialization", async () => {
	const persistence = new MemoryDecisionTreePersistence();
	await expect(persistence.loadIndex(projectRoot)).rejects.toBeInstanceOf(ProjectNotInitializedError);
	await expect(persistence.listTreeIds(projectRoot)).rejects.toHaveProperty("code", "project_not_initialized");
});

test("memory persistence stores session, index, and trees per project root", async () => {
	const persistence = new MemoryDecisionTreePersistence();
	await persistence.init(projectRoot);
	await persistence.init("/other");

	await persistence.saveIndex(projectRoot, { version: 1, history: { capture_default: false } });
	await persistence.saveSession(projectRoot, validSession());
	await persistence.saveTree(projectRoot, validTree(id(1)));
	await persistence.saveTree(projectRoot, validTree(id(3)));

	expect(await persistence.loadIndex(projectRoot)).toEqual({ version: 1, history: { capture_default: false } });
	expect(await persistence.loadSession(projectRoot)).toEqual(validSession());
	expect(await persistence.listTreeIds(projectRoot)).toEqual([id(1), id(3)]);
	expect(await persistence.listTreeIds("/other")).toEqual([]);
});

test("memory persistence clones docs on load and save", async () => {
	const persistence = new MemoryDecisionTreePersistence();
	await persistence.init(projectRoot);

	const tree = validTree();
	await persistence.saveTree(projectRoot, tree);
	tree.title = "mutated after save";
	expect((await persistence.loadTree(projectRoot, id(1))).title).toBe("Product decisions");

	const loaded = await persistence.loadTree(projectRoot, id(1));
	loaded.title = "mutated after load";
	expect((await persistence.loadTree(projectRoot, id(1))).title).toBe("Product decisions");
});

test("memory persistence reports missing trees", async () => {
	const persistence = new MemoryDecisionTreePersistence();
	await persistence.init(projectRoot);
	await expect(persistence.loadTree(projectRoot, id(99))).rejects.toBeInstanceOf(TreeNotFoundError);
	await expect(persistence.appendRaw(projectRoot, id(99), rawEntry(10))).rejects.toHaveProperty("code", "tree_not_found");
});

test("memory persistence appends and filters raw history", async () => {
	const persistence = new MemoryDecisionTreePersistence();
	await persistence.init(projectRoot);
	await persistence.saveTree(projectRoot, validTree());

	await persistence.appendRaw(projectRoot, id(1), rawEntry(10));
	await persistence.appendRaw(projectRoot, id(1), rawEntry(11));

	expect(await persistence.readRaw(projectRoot, id(1))).toEqual([rawEntry(10), rawEntry(11)]);
	expect(await persistence.readRaw(projectRoot, id(1), [id(11)])).toEqual([rawEntry(11)]);

	const loaded = await persistence.readRaw(projectRoot, id(1));
	loaded[0]!.content = "mutated";
	expect((await persistence.readRaw(projectRoot, id(1)))[0]!.content).toBe("raw 10");
});
