import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreNote, softDeleteNote } from "./trash";

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
