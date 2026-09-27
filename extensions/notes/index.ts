import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { restoreNote, softDeleteNote, type DeletedNote } from "./trash";
import { metadataPath, moveNoteScope, noteMatchesScope, readProjectMetadata, writeProjectMetadata } from "./project";
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
const NOTES_OPEN_EVENT = "px:notes:open";
const NOTES_LIST_EVENT = "px:notes:list";
const TITLE_MAX = 80;
const CLEAR_WINDOW_MS = 500;
const SCROLL_STEP = 5;

type NoteMeta = {
	path: string;
	fileName: string;
	title: string;
	mtimeMs: number;
	cwd?: string;
	metadataPath: string;
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

export async function createNoteFile(content: string, cwd: string | undefined, directory?: string): Promise<string> {
	const dir = directory ?? await ensureNotesDir();
	await mkdir(dir, { recursive: true });
	const base = `${formatFileTimestamp(new Date())}-${slugify(deriveTitle(content))}`;
	for (let index = 1; ; index += 1) {
		const suffix = index === 1 ? "" : `-${index}`;
		const candidate = join(dir, `${base}${suffix}.md`);
		try {
			await writeFile(candidate, ensureTrailingNewline(content), { encoding: "utf8", flag: "wx" });
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") continue;
			throw error;
		}
		try {
			if (cwd !== undefined) await writeProjectMetadata(dir, basename(candidate), cwd);
			return candidate;
		} catch (error) {
			try {
				await unlink(candidate);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Could not save project metadata or remove incomplete note");
			}
			throw error;
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
			const [info, content, metadata] = await Promise.all([
				stat(path),
				readFile(path, "utf8"),
				readProjectMetadata(metadataPath(dir, entry.name)),
			]);
			const title = deriveTitle(content) || entry.name.replace(/\.md$/, "");
			notes.push({ path, fileName: entry.name, title, mtimeMs: info.mtimeMs, cwd: metadata?.cwd, metadataPath: metadataPath(dir, entry.name) });
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
 * `/px:notes` dialog: multi-line note editor.
 * - ctrl+s saves (creates, then updates the same note while open)
 * - ctrl+g toggles Global/current-project scope
 * - ctrl+x twice within 500ms clears the editor
 * - esc closes, asking for confirmation when there are unsaved changes
 */
class NoteEditorDialog implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly editor: Editor;
	private readonly done: (result: null) => void;
	private readonly cwd: string;

	private savedPath: string | null = null;
	private savedText = "";
	private scope: "current" | "global" = "current";
	private savedScope: "current" | "global" = "current";
	private readonly otherProject: boolean;
	private scopeRevision = 0;
	private scopeUpdates: Promise<void> = Promise.resolve();
	private pendingScopeChanges = 0;
	private saveQueued = false;
	private clearArmedAt: number | null = null;
	private confirmingDiscard = false;
	private saving = false;
	private status = "ctrl+s save • ctrl+x ctrl+x clear • esc close";
	private _focused = false;

	constructor(tui: TUI, theme: Theme, done: (result: null) => void, cwd: string, existing?: { note: NoteMeta; text: string }) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.cwd = cwd;
		this.otherProject = existing?.note.cwd !== undefined && existing.note.cwd !== cwd;
		this.editor = new Editor(tui, createEditorTheme(theme));
		if (existing) {
			this.savedPath = existing.note.path;
			this.savedText = existing.text;
			this.scope = existing.note.cwd === undefined ? "global" : "current";
			this.savedScope = this.scope;
			this.editor.setText(existing.text);
		}
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

		if (matchesKey(data, Key.ctrl("g"))) {
			if (this.otherProject) {
				this.status = "Cannot change another project's scope";
				this.tui.requestRender();
				return;
			}
			this.scope = this.scope === "current" ? "global" : "current";
			const revision = ++this.scopeRevision;
			this.status = `Scope set to ${this.scope === "global" ? "Global" : "current project"}`;
			if (this.savedPath) void this.updateSavedScope(revision);
			this.tui.requestRender();
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
			if (this.saving || this.pendingScopeChanges > 0) {
				this.status = this.saving ? "Saving… wait before closing" : "Changing scope… wait before closing";
				this.tui.requestRender();
				return;
			}
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

	private async updateSavedScope(revision: number): Promise<void> {
		const path = this.savedPath;
		if (!path) return;
		this.pendingScopeChanges += 1;
		this.scopeUpdates = this.scopeUpdates.then(async () => {
			while (this.savedPath === path && this.savedScope !== this.scope) {
				const target = this.scope;
				try {
					await moveNoteScope(notesDir(), basename(path), target === "current" ? this.cwd : undefined);
					this.savedScope = target;
				} catch (error) {
					if (revision === this.scopeRevision && this.scope === target) {
						this.scope = this.savedScope;
						this.scopeRevision += 1;
					}
					this.status = `Scope change failed: ${error instanceof Error ? error.message : String(error)}`;
					return;
				}
			}
			if (revision === this.scopeRevision) this.status = `Scope: ${this.scope === "global" ? "Global" : "current project"}`;
		}).catch((error) => {
			this.status = `Scope change failed: ${error instanceof Error ? error.message : String(error)}`;
		}).finally(() => this.tui.requestRender());
		try {
			await this.scopeUpdates;
		} finally {
			this.pendingScopeChanges -= 1;
			this.tui.requestRender();
		}
	}

	private async save(): Promise<void> {
		if (this.saving) {
			this.saveQueued = true;
			return;
		}
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
				await this.updateSavedScope(this.scopeRevision);
			} else {
				const initialScope = this.scope;
				const path = await createNoteFile(text, initialScope === "current" ? this.cwd : undefined);
				this.savedPath = path;
				this.savedScope = initialScope;
				this.savedText = text;
				this.status = `Saved ${basename(path)}`;
				await this.updateSavedScope(this.scopeRevision);
			}
		} catch (error) {
			this.status = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.saving = false;
			this.tui.requestRender();
			if (this.saveQueued) {
				this.saveQueued = false;
				void this.save();
			}
		}
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const border = this.theme.fg("accent", "─".repeat(renderWidth));
		const title = this.theme.fg("accent", this.theme.bold(" Notes "));
		const unsaved = this.isDirty() ? this.theme.fg("dim", " (unsaved)") : "";
		const scope = this.theme.fg("muted", ` [${this.otherProject ? "Other project" : this.scope === "global" ? "Global" : "Current project"}]`);

		const lines: string[] = [
			border,
			truncateToWidth(`${title}${scope}${unsaved}`, renderWidth),
		];

		for (const line of this.editor.render(renderWidth)) {
			lines.push(truncateToWidth(line, renderWidth));
		}

		lines.push(truncateToWidth(this.theme.fg("dim", `ctrl+g scope • ${this.status}`), renderWidth));
		lines.push(border);
		return lines;
	}
}

/**
 * `/px:notes:list` dialog: notes on the left, selected note content on the right.
 * - up/down or j/k selects a note
 * - shift+j / shift+k scrolls the content by 5 lines
 * - ctrl+c (or y) copies the raw note to the clipboard
 * - shift+a (A) applies the selected note to an empty prompt
 * - esc closes
 */
export class NotesListDialog implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly cwd: string;
	private readonly ctx: ExtensionContext;

	private notes: NoteMeta[] = [];
	private readonly appliedPaths = new Set<string>();
	private applying = false;
	private selected = 0;
	private listOffset = 0;
	private scroll = 0;
	private rightLines: string[] = ["Loading…"];
	private wrappedContent: string[] = [];
	private contentRows = 6;
	private status = "";
	private loadToken = 0;
	private pendingDelete: NoteMeta | null = null;
	private pendingMove: NoteMeta | null = null;
	private deletedNotes: DeletedNote[] = [];
	private mutating = false;
	private scope: "current" | "global" | "all" = "current";
	private listLoadToken = 0;
	private scopeLoading = false;
	private preview = false;
	private previewRows = 6;
	private editor: NoteEditorDialog | null = null;
	private openingEditor = false;
	private _focused = false;

	constructor(tui: TUI, theme: Theme, done: () => void, cwd: string, ctx: ExtensionContext) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.cwd = cwd;
		this.ctx = ctx;
	}

	private displayTitle(note: NoteMeta): string {
		return `${this.appliedPaths.has(note.path) ? "[Applied] " : ""}${note.title || note.fileName}`;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.editor) this.editor.focused = value;
	}

	invalidate(): void {
		this.editor?.invalidate();
	}

	async load(): Promise<void> {
		const token = ++this.listLoadToken;
		const selectedPath = this.notes[this.selected]?.path;
		this.scopeLoading = true;
		this.tui.requestRender();
		try {
			const notes = (await loadNotes()).filter((note) => noteMatchesScope(note.cwd, this.cwd, this.scope));
			if (token !== this.listLoadToken) return;
			this.notes = notes;
			if (this.preview && selectedPath && !notes.some((note) => note.path === selectedPath)) this.preview = false;
			const retainedIndex = selectedPath ? notes.findIndex((note) => note.path === selectedPath) : -1;
			this.selected = retainedIndex >= 0 ? retainedIndex : 0;
			this.listOffset = Math.min(this.listOffset, this.selected);
			await this.loadSelectedContent();
		} catch (error) {
			if (token !== this.listLoadToken) return;
			this.notes = [];
			this.selected = 0;
			this.rightLines = ["Failed to load notes."];
			this.status = `Load failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			if (token === this.listLoadToken) {
				this.scopeLoading = false;
				this.tui.requestRender();
			}
		}
	}

	private async loadSelectedContent(): Promise<void> {
		const token = ++this.loadToken;
		this.scroll = 0;
		const note = this.notes[this.selected];
		if (!note) {
			this.rightLines = ["No notes yet. Press n to create one."];
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
		const visibleContentRows = Math.max(1, this.preview ? this.previewRows : this.contentRows - 2);
		const maxScroll = Math.max(0, this.wrappedContent.length - visibleContentRows);
		this.scroll = clamp(this.scroll + delta, 0, maxScroll);
		this.tui.requestRender();
	}

	private async editPreview(): Promise<void> {
		const note = this.notes[this.selected];
		if (!note || this.openingEditor) return;
		this.openingEditor = true;
		try {
			const text = await readFile(note.path, "utf8");
			if (!this.preview || this.notes[this.selected]?.path !== note.path) return;
			this.editor = new NoteEditorDialog(this.tui, this.theme, () => {
				this.editor = null;
				void this.load();
			}, this.cwd, { note, text });
			this.editor.focused = this.focused;
		} catch (error) {
			this.status = `Open failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.openingEditor = false;
			this.tui.requestRender();
		}
	}

	private async copySelected(): Promise<void> {
		const note = this.notes[this.selected];
		if (!note) return;
		const token = this.loadToken;
		try {
			const content = await readFile(note.path, "utf8");
			await copyToClipboard(content);
			if (token !== this.loadToken || this.notes[this.selected]?.path !== note.path) return;
			this.status = `Copied ${note.title || note.fileName}`;
		} catch (error) {
			if (token !== this.loadToken || this.notes[this.selected]?.path !== note.path) return;
			this.status = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.tui.requestRender();
	}

	private async applySelected(): Promise<void> {
		const note = this.notes[this.selected];
		if (!note || this.applying) return;
		if (this.ctx.ui.getEditorText().length > 0) {
			this.status = "Prompt input is not empty; note was not applied";
			this.tui.requestRender();
			return;
		}
		this.applying = true;
		try {
			const content = await readFile(note.path, "utf8");
			// The prompt may have changed while the note was being read.
			if (this.ctx.ui.getEditorText().length > 0) {
				this.status = "Prompt input is not empty; note was not applied";
			} else {
				this.ctx.ui.setEditorText(content);
				this.appliedPaths.add(note.path);
				this.status = `Applied ${note.title || note.fileName} to prompt`;
			}
		} catch (error) {
			this.status = `Apply failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.applying = false;
			this.tui.requestRender();
		}
	}

	private async deleteSelected(): Promise<void> {
		const note = this.pendingDelete;
		this.pendingDelete = null;
		if (!note || this.mutating) return;
		this.mutating = true;
		try {
			const deleted = await softDeleteNote(notesDir(), note);
			this.deletedNotes.push(deleted);
			const index = this.notes.findIndex((item) => item.path === note.path);
			if (index >= 0) {
				this.notes.splice(index, 1);
				this.selected = this.notes.length ? Math.min(index, this.notes.length - 1) : 0;
				this.listOffset = Math.min(this.listOffset, this.selected);
			}
			this.status = `Deleted ${note.title || note.fileName} • press u to undo`;
			await this.loadSelectedContent();
		} catch (error) {
			this.status = `Delete failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.mutating = false;
			this.tui.requestRender();
		}
	}

	private async moveSelected(): Promise<void> {
		const note = this.pendingMove;
		this.pendingMove = null;
		if (!note || this.mutating) return;
		if (note.cwd !== undefined && note.cwd !== this.cwd) {
			this.status = "Cannot move another project's note";
			this.tui.requestRender();
			return;
		}
		const targetCwd = note.cwd === undefined ? this.cwd : undefined;
		this.mutating = true;
		try {
			await moveNoteScope(notesDir(), note.fileName, targetCwd);
			note.cwd = targetCwd;
			if (!noteMatchesScope(note.cwd, this.cwd, this.scope)) {
				const index = this.notes.findIndex((item) => item.path === note.path);
				if (index >= 0) {
					this.notes.splice(index, 1);
					this.selected = this.notes.length ? Math.min(index, this.notes.length - 1) : 0;
					this.listOffset = Math.min(this.listOffset, this.selected);
				}
			}
			this.status = `${note.title || note.fileName} moved to ${targetCwd === undefined ? "Global" : "current project"}`;
			await this.loadSelectedContent();
		} catch (error) {
			this.status = `Move failed: ${error instanceof Error ? error.message : String(error)}`;
			await this.loadSelectedContent();
		} finally {
			this.mutating = false;
			this.tui.requestRender();
		}
	}

	private async undoDelete(): Promise<void> {
		if (this.mutating) return;
		const deleted = this.deletedNotes[this.deletedNotes.length - 1];
		if (!deleted) {
			this.status = "Nothing to undo";
			this.tui.requestRender();
			return;
		}
		this.mutating = true;
		try {
			await restoreNote(deleted);
			this.deletedNotes.pop();
			if (noteMatchesScope(deleted.note.cwd, this.cwd, this.scope)) {
				this.notes.push(deleted.note);
				this.notes.sort((a, b) => b.mtimeMs - a.mtimeMs);
				this.selected = this.notes.findIndex((note) => note.path === deleted.note.path);
				this.status = `Restored ${deleted.note.title || deleted.note.fileName}`;
			} else {
				this.status = "Restored note outside this project view";
			}
			await this.loadSelectedContent();
		} catch (error) {
			this.status = `Undo failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.mutating = false;
			this.tui.requestRender();
		}
	}

	handleInput(data: string): void {
		if (this.editor) {
			this.editor.handleInput(data);
			return;
		}
		if (this.preview) {
			if (matchesKey(data, Key.escape)) {
				this.preview = false;
				this.status = "";
				this.tui.requestRender();
			} else if (data === "e" || data === "E") {
				void this.editPreview();
			} else if (isShiftLetter(data, "j") || matchesKey(data, Key.down) || data === "j") {
				this.scrollBy(SCROLL_STEP);
			} else if (isShiftLetter(data, "k") || matchesKey(data, Key.up) || data === "k") {
				this.scrollBy(-SCROLL_STEP);
			}
			return;
		}
		if (this.pendingMove) {
			if (data === "y" || data === "Y") void this.moveSelected();
			else if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
				this.pendingMove = null;
				this.status = "Move cancelled";
				this.tui.requestRender();
			}
			return;
		}
		if (this.pendingDelete) {
			if (data === "y" || data === "Y") void this.deleteSelected();
			else if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
				this.pendingDelete = null;
				this.status = "Deletion cancelled";
				this.tui.requestRender();
			}
			return;
		}
		if (this.mutating) return;
		if (matchesKey(data, Key.escape)) {
			this.done();
			return;
		}
		if (data === "n" || data === "N") {
			this.editor = new NoteEditorDialog(this.tui, this.theme, () => {
				this.editor = null;
				void this.load();
			}, this.cwd);
			this.editor.focused = this.focused;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.tab) || data === "}" || data === "{") {
			this.scope = data === "{"
				? this.scope === "current" ? "all" : this.scope === "all" ? "global" : "current"
				: this.scope === "current" ? "global" : this.scope === "global" ? "all" : "current";
			this.status = `Showing ${this.scope === "all" ? "all projects" : this.scope === "global" ? "Global" : "current project"}`;
			void this.load();
			return;
		}
		// The previous scope's notes remain cached until the new load completes.
		if (this.scopeLoading) return;
		if (data === "u" || data === "U") {
			void this.undoDelete();
			return;
		}
		if (data === "g" || data === "G") {
			const note = this.notes[this.selected];
			if (note) {
				if (note.cwd !== undefined && note.cwd !== this.cwd) {
					this.status = "Cannot move another project's note";
				} else {
					this.pendingMove = note;
					this.status = `Move ${note.title || note.fileName} to ${note.cwd === undefined ? "current project" : "Global"}? y/n`;
				}
				this.tui.requestRender();
			}
			return;
		}
		if (data === "d" || data === "D") {
			const note = this.notes[this.selected];
			if (note) {
				this.pendingDelete = note;
				this.status = `Delete ${note.title || note.fileName}? y/n`;
				this.tui.requestRender();
			}
			return;
		}
		if (this.notes.length === 0) return;
		if (matchesKey(data, Key.shift("a")) || data === "A") {
			void this.applySelected();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.preview = true;
			this.status = "";
			this.scroll = 0;
			void this.loadSelectedContent().then(() => this.tui.requestRender());
			this.tui.requestRender();
			return;
		}

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
			const title = truncateToWidth(this.displayTitle(note), Math.max(1, leftWidth - 2));
			text = selected ? this.theme.fg("accent", `${prefix}${title}`) : `${prefix}${title}`;
		}
		const width = visibleWidth(text);
		if (width >= leftWidth) return truncateToWidth(text, leftWidth);
		return text + " ".repeat(leftWidth - width);
	}

	private renderHeader(width: number): string {
		const label = this.scope === "all" ? "All projects" : this.scope === "global" ? "Global" : "Current project";
		const count = `Notes • ${label} (${this.notes.length})`;
		const hint = "/px:notes:list";
		const gap = Math.max(1, width - visibleWidth(count) - visibleWidth(hint) - 1);
		return truncateToWidth(this.theme.fg("accent", this.theme.bold(count)) + " ".repeat(gap) + this.theme.fg("dim", hint), width);
	}

	render(width: number): string[] {
		if (this.editor) return this.editor.render(width);
		const renderWidth = Math.max(1, width);
		const border = this.theme.fg("accent", "─".repeat(renderWidth));

		if (this.preview) {
			const note = this.notes[this.selected];
			this.previewRows = clamp(this.tui.terminal.rows - 8, 5, 40);
			this.wrappedContent = this.wrapContent(renderWidth);
			this.scroll = clamp(this.scroll, 0, Math.max(0, this.wrappedContent.length - this.previewRows));
			const lines = [border, truncateToWidth(this.theme.fg("accent", this.theme.bold(note ? this.displayTitle(note) : "(untitled)")), renderWidth), this.theme.fg("dim", "─".repeat(renderWidth))];
			for (let row = 0; row < this.previewRows; row += 1) {
				lines.push(truncateToWidth(this.wrappedContent[this.scroll + row] ?? "", renderWidth));
			}
			lines.push(border, truncateToWidth(this.theme.fg("dim", " e edit • ↑↓/j k scroll • esc back"), renderWidth));
			if (this.status) lines.push(truncateToWidth(this.theme.fg("warning", this.status), renderWidth));
			return lines;
		}

		if (this.scopeLoading) {
			return [border, this.renderHeader(renderWidth), truncateToWidth(this.theme.fg("muted", " Loading notes…"), renderWidth), border];
		}

		if (this.notes.length === 0) {
			const lines = [
				border,
				this.renderHeader(renderWidth),
				truncateToWidth(this.theme.fg("muted", this.status.startsWith("Load failed:") ? " Notes could not be loaded." : " No notes yet. Press n to create one."), renderWidth),
				border,
				truncateToWidth(this.theme.fg("dim", " n new note • }/tab scope • g move • u undo • esc close"), renderWidth),
			];
			if (this.status) lines.push(truncateToWidth(this.theme.fg("success", this.status), renderWidth));
			return lines;
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
				rightCell = this.theme.fg("accent", this.theme.bold(current ? this.displayTitle(current) : "(untitled)"));
			} else if (row === 1) {
				rightCell = this.theme.fg("dim", current ? formatDisplayDate(current.mtimeMs) : "");
			} else {
				rightCell = this.wrappedContent[this.scroll + (row - 2)] ?? "";
			}
			lines.push(`${leftCell}${separator}${truncateToWidth(rightCell, rightWidth)}`);
		}

		lines.push(this.theme.fg("dim", "─".repeat(renderWidth)));
		const hint = " n new note • enter preview • }/tab scope • ↑↓/j k select • A apply • g move • d delete • u undo • shift+j/k scroll • ctrl+c/y copy • esc close";
		lines.push(truncateToWidth(this.theme.fg("dim", hint), renderWidth));
		if (this.status) {
			const color = this.status.startsWith("Prompt input is not empty") || this.status.startsWith("Apply failed:") ? "warning" : "success";
			lines.push(truncateToWidth(this.theme.fg(color, this.status), renderWidth));
		}

		return lines;
	}
}

async function openNoteEditor(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("notes: the editor dialog requires an interactive session", "warning");
		return;
	}
	await ctx.ui.custom<null>((tui, theme, _keybindings, done) => new NoteEditorDialog(tui, theme, done, ctx.cwd));
}

async function openNotesList(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("notes: the list dialog requires an interactive session", "warning");
		return;
	}
	await ctx.ui.custom<null>(async (tui, theme, _keybindings, done) => {
		const dialog = new NotesListDialog(tui, theme, () => done(null), ctx.cwd, ctx);
		await dialog.load();
		return dialog;
	});
}

export default function notesExtension(pi: ExtensionAPI): void {
	pi.registerCommand("px:notes", {
		description: "Compose a note; ctrl+s saves, ctrl+g toggles scope, esc closes",
		handler: async (_args, ctx) => {
			await openNoteEditor(ctx);
		},
	});

	pi.registerCommand("px:notes:list", {
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
