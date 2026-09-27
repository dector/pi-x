import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { NotesListDialog } from "./index";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(prompt = "") {
	const dir = await mkdtemp(join(tmpdir(), "pi-notes-apply-"));
	dirs.push(dir);
	const path = join(dir, "note.md");
	const content = "Example note\nsecond line\n";
	await writeFile(path, content);
	let editorText = prompt;
	const tui = { requestRender() {}, terminal: { rows: 30 } } as unknown as TUI;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const ctx = {
		ui: {
			getEditorText: () => editorText,
			setEditorText: (text: string) => { editorText = text; },
		},
	} as ExtensionContext;
	const dialog = new NotesListDialog(tui, theme, () => {}, dir, ctx);
	// Supply a note directly; loading the global notes directory is unrelated to applying it.
	(dialog as any).notes = [{ path, fileName: "note.md", title: "Example note", mtimeMs: Date.now(), metadataPath: "" }];
	return { dialog, content, path, getPrompt: () => editorText, setPrompt: (text: string) => { editorText = text; } };
}

async function settle(dialog: NotesListDialog): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (!(dialog as any).applying) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Apply did not finish");
}

test("A applies raw note only to an empty prompt and marks its displayed title", async () => {
	const { dialog, content, path, getPrompt } = await setup();
	dialog.handleInput("A");
	await settle(dialog);
	expect(getPrompt()).toBe(content);
	expect(dialog.render(100).join("\n")).toContain("[Applied] Example note");
	expect(await readFile(path, "utf8")).toBe(content);
});

test("A refuses a non-empty prompt without marking the note", async () => {
	const { dialog, getPrompt } = await setup("existing text");
	dialog.handleInput("A");
	expect(getPrompt()).toBe("existing text");
	expect(dialog.render(100).join("\n")).toContain("Prompt input is not empty; note was not applied");
	expect(dialog.render(100).join("\n")).not.toContain("[Applied]");
});

test("A rechecks the prompt after reading the note", async () => {
	const { dialog, getPrompt, setPrompt } = await setup();
	dialog.handleInput("A");
	setPrompt("typed during read");
	await settle(dialog);
	expect(getPrompt()).toBe("typed during read");
	expect(dialog.render(100).join("\n")).not.toContain("[Applied]");
});
