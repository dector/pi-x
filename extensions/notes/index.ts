import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	copyToClipboard,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const NOTES_DIR_NAME = "notes";
const NOTES_OPEN_EVENT = "notes:open";
const NOTES_LIST_EVENT = "notes:list";
const TITLE_MAX = 80;
const CLEAR_WINDOW_MS = 500;
const SCROLL_STEP = 5;

type NoteMeta = {
	path: string;
	fileName: string;
	title: string;
	mtimeMs: number;
};

function notesDir(): string {
	return join(getAgentDir(), NOTES_DIR_NAME);
}

async function ensureNotesDir(): Promise<string> {
	const dir = notesDir();
	await mkdir(dir, { recursive: true });
	return dir;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function ensureTrailingNewline(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}

function deriveTitle(text: string): string {
	const line = text
		.split(/\r?\n/)
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.length > 0);
	if (!line) return "";
	return line.replace(/\s+/g, " ").slice(0, TITLE_MAX);
}

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "note";
}

function formatFileTimestamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatDisplayDate(mtimeMs: number): string {
	const date = new Date(mtimeMs);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function createNoteFile(content: string): Promise<string> {
	const dir = await ensureNotesDir();
	const base = `${formatFileTimestamp(new Date())}-${slugify(deriveTitle(content))}`;
	for (let index = 1; ; index += 1) {
		const suffix = index === 1 ? "" : `-${index}`;
		const candidate = join(dir, `${base}${suffix}.md`);
		try {
			await stat(candidate);
		} catch {
			await writeFile(candidate, ensureTrailingNewline(content), "utf8");
			return candidate;
		}
	}
}

async function loadNotes(): Promise<NoteMeta[]> {
	const dir = await ensureNotesDir();
	const entries = await readdir(dir, { withFileTypes: true });
	const notes: NoteMeta[] = [];

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const path = join(dir, entry.name);
		try {
			const [info, content] = await Promise.all([stat(path), readFile(path, "utf8")]);
			const title = deriveTitle(content) || entry.name.replace(/\.md$/, "");
			notes.push({ path, fileName: entry.name, title, mtimeMs: info.mtimeMs });
		} catch {
			// Skip unreadable notes.
		}
	}

	notes.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return notes;
}

function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("dim", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

function isShiftLetter(data: string, letter: "j" | "k"): boolean {
	return matchesKey(data, Key.shift(letter)) || data === letter.toUpperCase();
}

/**
 * `/notes` dialog: multi-line note editor.
 * - ctrl+s saves (creates, then updates the same note while open)
 * - ctrl+x twice within 500ms clears the editor
 * - esc closes, asking for confirmation when there are unsaved changes
 */
class NoteEditorDialog implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly editor: Editor;
	private readonly done: (result: null) => void;

	private savedPath: string | null = null;
	private savedText = "";
	private clearArmedAt: number | null = null;
	private confirmingDiscard = false;
	private saving = false;
	private status = "ctrl+s save • ctrl+x ctrl+x clear • esc close";
	private _focused = false;

	constructor(tui: TUI, theme: Theme, done: (result: null) => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.editor = new Editor(tui, createEditorTheme(theme));
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	private isDirty(): boolean {
		return this.editor.getText() !== this.savedText;
	}

	handleInput(data: string): void {
		if (this.confirmingDiscard) {
			if (data === "y" || data === "Y") {
				this.done(null);
				return;
			}
			if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
				this.confirmingDiscard = false;
				this.status = "ctrl+s save • esc close";
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.ctrl("s"))) {
			void this.save();
			return;
		}

		if (matchesKey(data, Key.ctrl("x"))) {
			const now = Date.now();
			if (this.clearArmedAt !== null && now - this.clearArmedAt <= CLEAR_WINDOW_MS) {
				this.editor.setText("");
				this.clearArmedAt = null;
				this.status = "Cleared";
			} else {
				this.clearArmedAt = now;
				this.status = "Press ctrl+x again to clear";
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			if (this.isDirty()) {
				this.confirmingDiscard = true;
				this.status = this.savedPath ? "Discard changes? y/n" : "Discard unsaved note? y/n";
			} else {
				this.done(null);
				return;
			}
			this.tui.requestRender();
			return;
		}

		// Plain Enter inserts a newline instead of submitting.
		if (matchesKey(data, Key.enter)) {
			this.clearArmedAt = null;
			this.editor.insertTextAtCursor("\n");
			this.tui.requestRender();
			return;
		}

		// Any other key cancels a pending clear.
		this.clearArmedAt = null;
		this.editor.handleInput(data);
		this.tui.requestRender();
	}

	private async save(): Promise<void> {
		if (this.saving) return;
		const text = this.editor.getText();
		if (!text.trim()) {
			this.status = "Nothing to save";
			this.tui.requestRender();
			return;
		}

		this.saving = true;
		try {
			if (this.savedPath) {
				await writeFile(this.savedPath, ensureTrailingNewline(text), "utf8");
				this.savedText = text;
				this.status = `Updated ${basename(this.savedPath)}`;
			} else {
				this.savedPath = await createNoteFile(text);
				this.savedText = text;
				this.status = `Saved ${basename(this.savedPath)}`;
			}
		} catch (error) {
			this.status = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.saving = false;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const border = this.theme.fg("accent", "─".repeat(renderWidth));
		const title = this.theme.fg("accent", this.theme.bold(" Notes "));
		const unsaved = this.isDirty() ? this.theme.fg("dim", " (unsaved)") : "";

		const lines: string[] = [
			border,
			truncateToWidth(`${title}${unsaved}`, renderWidth),
		];

		for (const line of this.editor.render(renderWidth)) {
			lines.push(truncateToWidth(line, renderWidth));
		}

		lines.push(truncateToWidth(this.theme.fg("dim", this.status), renderWidth));
		lines.push(border);
		return lines;
	}
}

/**
 * `/notes:list` dialog: notes on the left, selected note content on the right.
 * - up/down or j/k selects a note
 * - shift+j / shift+k scrolls the content by 5 lines
 * - ctrl+c (or y) copies the raw note to the clipboard
 * - esc closes
 */
class NotesListDialog implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;

	private notes: NoteMeta[] = [];
	private selected = 0;
	private listOffset = 0;
	private scroll = 0;
	private rightLines: string[] = ["Loading…"];
	private wrappedContent: string[] = [];
	private contentRows = 6;
	private status = "";
	private loadToken = 0;
	private _focused = false;

	constructor(tui: TUI, theme: Theme, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	invalidate(): void {}

	async load(): Promise<void> {
		this.notes = await loadNotes();
		this.selected = 0;
		this.listOffset = 0;
		await this.loadSelectedContent();
		this.tui.requestRender();
	}

	private async loadSelectedContent(): Promise<void> {
		const token = ++this.loadToken;
		this.scroll = 0;
		const note = this.notes[this.selected];
		if (!note) {
			this.rightLines = ["No notes yet. Use /notes to create one."];
			return;
		}

		let content: string;
		try {
			content = await readFile(note.path, "utf8");
		} catch (error) {
			content = `Failed to read note: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (token !== this.loadToken) return;
		this.rightLines = content.replace(/\r\n/g, "\n").split("\n");
	}

	private select(index: number): void {
		if (index < 0 || index >= this.notes.length || index === this.selected) return;
		this.selected = index;
		void this.loadSelectedContent().then(() => this.tui.requestRender());
		this.tui.requestRender();
	}

	private scrollBy(delta: number): void {
		const visibleContentRows = Math.max(1, this.contentRows - 2);
		const maxScroll = Math.max(0, this.wrappedContent.length - visibleContentRows);
		this.scroll = clamp(this.scroll + delta, 0, maxScroll);
		this.tui.requestRender();
	}

	private async copySelected(): Promise<void> {
		const note = this.notes[this.selected];
		if (!note) return;
		try {
			const content = await readFile(note.path, "utf8");
			await copyToClipboard(content);
			this.status = `Copied ${note.title || note.fileName}`;
		} catch (error) {
			this.status = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done();
			return;
		}
		if (this.notes.length === 0) return;

		if (isShiftLetter(data, "j")) {
			this.scrollBy(SCROLL_STEP);
			return;
		}
		if (isShiftLetter(data, "k")) {
			this.scrollBy(-SCROLL_STEP);
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.select(this.selected - 1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.select(this.selected + 1);
			return;
		}
		if (matchesKey(data, Key.ctrl("c")) || data === "y") {
			void this.copySelected();
		}
	}

	private wrapContent(width: number): string[] {
		const out: string[] = [];
		for (const line of this.rightLines) {
			if (line.length === 0) {
				out.push("");
				continue;
			}
			const wrapped = wrapTextWithAnsi(line, Math.max(1, width));
			if (wrapped.length === 0) out.push("");
			else out.push(...wrapped);
		}
		return out;
	}

	private renderLeftCell(index: number, leftWidth: number): string {
		const note = this.notes[index];
		let text = "";
		if (note) {
			const selected = index === this.selected;
			const prefix = selected ? "> " : "  ";
			const title = truncateToWidth(note.title || note.fileName, Math.max(1, leftWidth - 2));
			text = selected ? this.theme.fg("accent", `${prefix}${title}`) : `${prefix}${title}`;
		}
		const width = visibleWidth(text);
		if (width >= leftWidth) return truncateToWidth(text, leftWidth);
		return text + " ".repeat(leftWidth - width);
	}

	private renderHeader(width: number): string {
		const count = `Notes (${this.notes.length})`;
		const hint = "/notes:list";
		const gap = Math.max(1, width - visibleWidth(count) - visibleWidth(hint) - 1);
		return truncateToWidth(this.theme.fg("accent", this.theme.bold(count)) + " ".repeat(gap) + this.theme.fg("dim", hint), width);
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const border = this.theme.fg("accent", "─".repeat(renderWidth));

		if (this.notes.length === 0) {
			return [
				border,
				this.renderHeader(renderWidth),
				truncateToWidth(this.theme.fg("muted", " No notes yet. Use /notes to create one."), renderWidth),
				border,
				truncateToWidth(this.theme.fg("dim", " esc close"), renderWidth),
			];
		}

		this.contentRows = clamp(Math.floor(this.tui.terminal.rows * 0.4), 5, 18);

		const leftWidth = clamp(Math.floor(renderWidth * 0.35), 16, 40);
		const separator = this.theme.fg("dim", " │ ");
		const rightWidth = Math.max(1, renderWidth - leftWidth - visibleWidth(separator));

		this.wrappedContent = this.wrapContent(rightWidth);
		const visibleContentRows = Math.max(1, this.contentRows - 2);
		const maxScroll = Math.max(0, this.wrappedContent.length - visibleContentRows);
		this.scroll = clamp(this.scroll, 0, maxScroll);

		if (this.selected < this.listOffset) this.listOffset = this.selected;
		if (this.selected >= this.listOffset + this.contentRows) {
			this.listOffset = this.selected - this.contentRows + 1;
		}

		const current = this.notes[this.selected];
		const lines: string[] = [border, this.renderHeader(renderWidth), this.theme.fg("dim", "─".repeat(renderWidth))];

		for (let row = 0; row < this.contentRows; row += 1) {
			const leftCell = this.renderLeftCell(this.listOffset + row, leftWidth);
			let rightCell = "";
			if (row === 0) {
				rightCell = this.theme.fg("accent", this.theme.bold(current?.title || "(untitled)"));
			} else if (row === 1) {
				rightCell = this.theme.fg("dim", current ? formatDisplayDate(current.mtimeMs) : "");
			} else {
				rightCell = this.wrappedContent[this.scroll + (row - 2)] ?? "";
			}
			lines.push(`${leftCell}${separator}${truncateToWidth(rightCell, rightWidth)}`);
		}

		lines.push(this.theme.fg("dim", "─".repeat(renderWidth)));
		const hint = " ↑↓/j k select • shift+j/k scroll • ctrl+c/y copy • esc close";
		lines.push(truncateToWidth(this.theme.fg("dim", hint), renderWidth));
		if (this.status) {
			lines.push(truncateToWidth(this.theme.fg("success", this.status), renderWidth));
		}

		return lines;
	}
}

async function openNoteEditor(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("notes: the editor dialog requires an interactive session", "warning");
		return;
	}
	await ctx.ui.custom<null>((tui, theme, _keybindings, done) => new NoteEditorDialog(tui, theme, done));
}

async function openNotesList(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("notes: the list dialog requires an interactive session", "warning");
		return;
	}
	await ctx.ui.custom<null>(async (tui, theme, _keybindings, done) => {
		const dialog = new NotesListDialog(tui, theme, () => done(null));
		await dialog.load();
		return dialog;
	});
}

export default function notesExtension(pi: ExtensionAPI): void {
	pi.registerCommand("notes", {
		description: "Compose a note; ctrl+s saves, esc closes",
		handler: async (_args, ctx) => {
			await openNoteEditor(ctx);
		},
	});

	pi.registerCommand("notes:list", {
		description: "Browse saved notes; ctrl+c copies the selected note",
		handler: async (_args, ctx) => {
			await openNotesList(ctx);
		},
	});

	// Allow other extensions (e.g. pi-ui's Ctrl+, dialog) to open the dialogs.
	const withCtx = async (
		payload: unknown,
		fn: (ctx: ExtensionContext) => Promise<unknown>,
	): Promise<void> => {
		if (!payload || typeof payload !== "object") return;
		const maybeCtx = (payload as { ctx?: ExtensionContext }).ctx;
		if (!maybeCtx) return;
		await fn(maybeCtx);
	};

	pi.events.on(NOTES_OPEN_EVENT, (payload) => void withCtx(payload, openNoteEditor));
	pi.events.on(NOTES_LIST_EVENT, (payload) => void withCtx(payload, openNotesList));
}
