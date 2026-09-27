import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreNote, softDeleteNote } from "./trash";
import { metadataPath, writeProjectMetadata } from "./project";

async function withNotesDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-notes-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("soft delete keeps note content recoverable and restore returns it", async () => {
	await withNotesDir(async (dir) => {
		const path = join(dir, "legacy.md");
		const content = "# Legacy note\nKeep this content.\n";
		await writeFile(path, content);
		const note = { path, fileName: "legacy.md" };

		const deleted = await softDeleteNote(dir, note);
		expect(await readFile(deleted.trashPath, "utf8")).toBe(content);
		expect(await readdir(dir)).toContain(".trash");
		await restoreNote(deleted);
		expect(await readFile(path, "utf8")).toBe(content);
		expect(await readdir(join(dir, ".trash"))).toEqual([]);
	});
});

test("soft delete and undo preserve project metadata beside plain Markdown", async () => {
	await withNotesDir(async (dir) => {
		const fileName = "project-note.md";
		const path = join(dir, fileName);
		const metaPath = metadataPath(dir, fileName);
		const content = "# Plain note\nNo frontmatter.\n";
		await writeFile(path, content);
		await writeProjectMetadata(dir, fileName, "/work/project");

		const deleted = await softDeleteNote(dir, { path, fileName, metadataPath: metaPath });
		expect(deleted.metadataTrashPath).toBeDefined();
		expect(await readFile(deleted.metadataTrashPath!, "utf8")).toContain("/work/project");
		await restoreNote(deleted);
		expect(await readFile(path, "utf8")).toBe(content);
		expect(await readFile(metaPath, "utf8")).toContain("/work/project");
		expect(await readdir(join(dir, ".trash"))).toEqual([]);
	});
});

test("failed delete rolls metadata back when note move fails", async () => {
	await withNotesDir(async (dir) => {
		const fileName = "missing-note.md";
		const path = join(dir, fileName);
		const metaPath = metadataPath(dir, fileName);
		await writeProjectMetadata(dir, fileName, "/work/project");

		await expect(softDeleteNote(dir, { path, fileName, metadataPath: metaPath })).rejects.toThrow();
		expect(await readFile(metaPath, "utf8")).toContain("/work/project");
		expect(await readdir(join(dir, ".trash"))).toEqual([]);
	});
});

test("failed undo leaves metadata and note recoverable", async () => {
	await withNotesDir(async (dir) => {
		const fileName = "note.md";
		const path = join(dir, fileName);
		const metaPath = metadataPath(dir, fileName);
		await writeFile(path, "deleted version");
		await writeProjectMetadata(dir, fileName, "/work/project");
		const deleted = await softDeleteNote(dir, { path, fileName, metadataPath: metaPath });
		await writeFile(path, "new version");

		await expect(restoreNote(deleted)).rejects.toThrow();
		expect(await readFile(path, "utf8")).toBe("new version");
		expect(await readFile(deleted.trashPath, "utf8")).toBe("deleted version");
		expect(await readFile(deleted.metadataTrashPath!, "utf8")).toContain("/work/project");
		expect(await readdir(join(dir, ".metadata"))).toEqual([]);
	});
});

test("undo does not overwrite a note recreated at the original path", async () => {
	await withNotesDir(async (dir) => {
		const path = join(dir, "note.md");
		await writeFile(path, "deleted version");
		const deleted = await softDeleteNote(dir, { path, fileName: "note.md" });
		await writeFile(path, "new version");

		await expect(restoreNote(deleted)).rejects.toThrow();
		expect(await readFile(path, "utf8")).toBe("new version");
		expect(await readFile(deleted.trashPath, "utf8")).toBe("deleted version");
	});
});
