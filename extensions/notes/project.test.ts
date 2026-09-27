import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metadataPath, noteMatchesProject, readProjectMetadata, writeProjectMetadata } from "./project";

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

test("project view is exact cwd; all-projects includes legacy notes", () => {
	expect(noteMatchesProject("/work/a", "/work/a", false)).toBe(true);
	expect(noteMatchesProject("/work/b", "/work/a", false)).toBe(false);
	expect(noteMatchesProject(undefined, "/work/a", false)).toBe(false);
	expect(noteMatchesProject(undefined, "/work/a", true)).toBe(true);
	expect(noteMatchesProject("/work/b", "/work/a", true)).toBe(true);
});
