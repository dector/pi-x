import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createNoteFile } from "./index";
import { metadataPath, moveNoteScope, noteMatchesProject, noteMatchesScope, readProjectMetadata, writeProjectMetadata } from "./project";

test("metadata round-trips exact cwd without changing Markdown", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-notes-project-"));
	try {
		const name = "note.md";
		const markdown = "# Note\nBody\n";
		await writeFile(join(dir, name), markdown);
		await writeProjectMetadata(dir, name, "/work/project/../project");
		expect(await readProjectMetadata(metadataPath(dir, name))).toEqual({ cwd: "/work/project/../project" });
		expect(await readFile(join(dir, name), "utf8")).toBe(markdown);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("scope views separate current, global (including legacy), and all notes", () => {
	expect(noteMatchesScope("/work/a", "/work/a", "current")).toBe(true);
	expect(noteMatchesScope("/work/b", "/work/a", "current")).toBe(false);
	expect(noteMatchesScope(undefined, "/work/a", "current")).toBe(false);
	expect(noteMatchesScope(undefined, "/work/a", "global")).toBe(true);
	expect(noteMatchesScope("/work/a", "/work/a", "global")).toBe(false);
	expect(noteMatchesScope("/work/b", "/work/a", "global")).toBe(false);
	for (const cwd of [undefined, "/work/a", "/work/b"]) expect(noteMatchesScope(cwd, "/work/a", "all")).toBe(true);
	expect(noteMatchesProject(undefined, "/work/a", true)).toBe(true);
});

test("global note creation leaves out the project metadata sidecar", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-notes-global-"));
	try {
		const markdown = "# Global note\nBody";
		const path = await createNoteFile(markdown, undefined, dir);
		expect(await readFile(path, "utf8")).toBe(`${markdown}\n`);
		expect(await readProjectMetadata(metadataPath(dir, basename(path)))).toBeUndefined();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("scope moves only update sidecar metadata and preserve Markdown", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-notes-scope-"));
	try {
		const name = "note.md";
		const markdown = "# Note\nBody\n";
		await writeFile(join(dir, name), markdown);
		await moveNoteScope(dir, name, "/work/a");
		expect(await readProjectMetadata(metadataPath(dir, name))).toEqual({ cwd: "/work/a" });
		await moveNoteScope(dir, name, undefined);
		expect(await readProjectMetadata(metadataPath(dir, name))).toBeUndefined();
		expect(await readFile(join(dir, name), "utf8")).toBe(markdown);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
