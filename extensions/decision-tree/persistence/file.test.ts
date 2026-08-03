import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RawEntry, SessionDoc, TreeDoc } from "../core/types";
import { FileDecisionTreePersistence } from "./file";
import { PersistenceValidationError, ProjectNotInitializedError, TreeNotFoundError } from "./errors";
import { resolveStoragePaths } from "./paths";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const now = "2026-01-02T03:04:05.000Z";

async function withProject(fn: (projectRoot: string) => Promise<void>): Promise<void> {
	const projectRoot = await mkdtemp(join(tmpdir(), "dt-file-"));
	try {
		await fn(projectRoot);
	} finally {
		await rm(projectRoot, { recursive: true, force: true });
	}
}

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

test("file persistence initializes scaffolding idempotently", async () => {
	await withProject(async (projectRoot) => {
		const persistence = new FileDecisionTreePersistence();
		const paths = resolveStoragePaths(projectRoot);

		expect(await persistence.isInitialized(projectRoot)).toBe(false);
		expect((await persistence.init(projectRoot)).created).toBe(true);
		expect(await persistence.isInitialized(projectRoot)).toBe(true);
		expect(await persistence.loadIndex(projectRoot)).toEqual({ version: 1, history: { capture_default: true } });
		expect(await readFile(`${paths.decisionsDir}/.gitignore`, "utf8")).toBe("session.json\n");
		expect(await persistence.loadSession(projectRoot)).toBeNull();

		expect((await persistence.init(projectRoot)).created).toBe(false);
	});
});

test("file persistence requires initialization", async () => {
	await withProject(async (projectRoot) => {
		const persistence = new FileDecisionTreePersistence();
		await expect(persistence.loadIndex(projectRoot)).rejects.toBeInstanceOf(ProjectNotInitializedError);
	});
});

test("file persistence stores index, session, trees, and raw history", async () => {
	await withProject(async (projectRoot) => {
		const persistence = new FileDecisionTreePersistence();
		await persistence.init(projectRoot);

		await persistence.saveIndex(projectRoot, { version: 1, history: { capture_default: false } });
		await persistence.saveSession(projectRoot, validSession());
		await persistence.saveTree(projectRoot, validTree(id(1)));
		await persistence.saveTree(projectRoot, validTree(id(3)));
		await persistence.appendRaw(projectRoot, id(1), rawEntry(10));
		await persistence.appendRaw(projectRoot, id(1), rawEntry(11));

		expect(await persistence.loadIndex(projectRoot)).toEqual({ version: 1, history: { capture_default: false } });
		expect(await persistence.loadSession(projectRoot)).toEqual(validSession());
		expect(await persistence.listTreeIds(projectRoot)).toEqual([id(1), id(3)]);
		expect(await persistence.loadTree(projectRoot, id(1))).toEqual(validTree(id(1)));
		expect(await persistence.readRaw(projectRoot, id(1))).toEqual([rawEntry(10), rawEntry(11)]);
		expect(await persistence.readRaw(projectRoot, id(1), [id(11)])).toEqual([rawEntry(11)]);
	});
});

test("file persistence reports missing trees and skips invalid tree candidates during discovery", async () => {
	await withProject(async (projectRoot) => {
		const persistence = new FileDecisionTreePersistence();
		await persistence.init(projectRoot);
		await expect(persistence.loadTree(projectRoot, id(99))).rejects.toBeInstanceOf(TreeNotFoundError);

		const paths = resolveStoragePaths(projectRoot);
		await persistence.saveTree(projectRoot, validTree(id(1)));
		await persistence.saveTree(projectRoot, validTree(id(9)));
		await writeFile(paths.treeFile(id(9)), "{ nope", "utf8");

		expect(await persistence.listTreeIds(projectRoot)).toEqual([id(1)]);
	});
});

test("file persistence validates persisted tree content on load", async () => {
	await withProject(async (projectRoot) => {
		const persistence = new FileDecisionTreePersistence();
		await persistence.init(projectRoot);
		await persistence.saveTree(projectRoot, validTree(id(1)));
		const paths = resolveStoragePaths(projectRoot);
		await writeFile(paths.treeFile(id(1)), JSON.stringify({ ...validTree(id(1)), version: 2 }), "utf8");

		await expect(persistence.loadTree(projectRoot, id(1))).rejects.toBeInstanceOf(PersistenceValidationError);
	});
});
