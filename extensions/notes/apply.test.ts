import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { NotesListDialog, openNotesList } from "./index";

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
	let closedWith: { path: string; content: string } | null | undefined;
	const notifications: string[] = [];
	const tui = { requestRender() {}, terminal: { rows: 30 } } as unknown as TUI;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const ctx = {
		hasUI: true,
		cwd: dir,
		ui: {
			getEditorText: () => editorText,
			setEditorText: (text: string) => { editorText = text; },
			notify: (message: string) => { notifications.push(message); },
		},
	} as ExtensionContext;
	const dialog = new NotesListDialog(tui, theme, (result) => { closedWith = result; }, dir, ctx);
	// Supply a note directly; loading the global notes directory is unrelated to applying it.
	(dialog as any).notes = [{ path, fileName: "note.md", title: "Example note", mtimeMs: Date.now(), metadataPath: "" }];
	return { dialog, ctx, content, path, notifications, getClosed: () => closedWith, getPrompt: () => editorText, setPrompt: (text: string) => { editorText = text; } };
}

async function settle(dialog: NotesListDialog): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (!(dialog as any).applying) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Apply did not finish");
}

test("N opens a new note prefilled with the current prompt", async () => {
	const prompt = "  Prompt text\nwith a second line  ";
	const { dialog } = await setup(prompt);
	expect(dialog.render(100).join("\n")).toContain("N from prompt");
	dialog.handleInput("N");
	expect((dialog as any).editor.editor.getText()).toBe(prompt);
});

test("N is hidden and does nothing when the prompt is blank", async () => {
	const { dialog } = await setup(" \n\t ");
	expect(dialog.render(100).join("\n")).not.toContain("N from prompt");
	dialog.handleInput("N");
	expect((dialog as any).editor).toBeNull();
});

test("A returns raw note to close the dialog, without filling editor while dialog is open", async () => {
	const { dialog, content, path, getClosed, getPrompt } = await setup();
	dialog.handleInput("A");
	await settle(dialog);
	expect(getClosed()).toEqual({ path, content });
	expect(getPrompt()).toBe("");
	expect(await readFile(path, "utf8")).toBe(content);
});

test("A refuses a non-empty prompt without closing or marking the note", async () => {
	const { dialog, getClosed, getPrompt } = await setup("existing text");
	dialog.handleInput("A");
	expect(getClosed()).toBeUndefined();
	expect(getPrompt()).toBe("existing text");
	expect(dialog.render(100).join("\n")).toContain("Prompt input is not empty; note was not applied");
	expect(dialog.render(100).join("\n")).not.toContain("[Applied]");
});

test("A rechecks the prompt after reading the note", async () => {
	const { dialog, getClosed, getPrompt, setPrompt } = await setup();
	dialog.handleInput("A");
	setPrompt("typed during read");
	await settle(dialog);
	expect(getClosed()).toBeUndefined();
	expect(getPrompt()).toBe("typed during read");
});

test("closing custom UI precedes editor update; reopening shows Applied marker", async () => {
	const { ctx, dialog, path, content, getPrompt } = await setup();
	let customOpen = true;
	(ctx.ui as any).custom = async () => {
		expect(getPrompt()).toBe("");
		customOpen = false;
		return { path, content };
	};
	const setEditorText = ctx.ui.setEditorText.bind(ctx.ui);
	(ctx.ui as any).setEditorText = (text: string) => {
		expect(customOpen).toBe(false);
		setEditorText(text);
	};
	await openNotesList(ctx);
	expect(getPrompt()).toBe(content);
	expect(dialog.render(100).join("\n")).toContain("[Applied] Example note");
});

test("a non-empty prompt after closing still refuses to overwrite it", async () => {
	const { ctx, path, content, getPrompt, setPrompt, notifications } = await setup();
	(ctx.ui as any).custom = async () => {
		setPrompt("typed after dialog opened");
		return { path, content };
	};
	await openNotesList(ctx);
	expect(getPrompt()).toBe("typed after dialog opened");
	expect(notifications).toContain("Prompt input is not empty; note was not applied");
});
