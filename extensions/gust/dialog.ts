/**
 * Gust comment browser — TUI.
 *
 * Two-pane browser for Gust threads (list on the left, selected thread on the
 * right) backed by `gust ctl comments` (see ./gust.ts). Replies typed here
 * default to human (`--human`); `tab` switches to an agent reply. A human
 * reply to a review thread reopens it as submitted on the Gust side.
 *
 * Keys:
 *   ↑/↓ or j/k      move selection
 *   shift+j/k       scroll the thread pane
 *   enter / r       reply (human by default, tab toggles the author)
 *   s               review (agent reply + mark review)
 *   x               resolve (y/n confirm)
 *   g               refresh from gust
 *   f               cycle the state filter
 *   esc             close (or go back / cancel)
 *
 * Narrow terminals fall back to a single pane: enter opens the thread, esc
 * returns to the list.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
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
import type { GustClient } from "./gust.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { Author, Thread, ThreadMessage, ThreadState } from "./types.ts";

type Tone = "accent" | "muted" | "dim" | "success" | "warning" | "error" | "text";

interface StateMeta {
	glyph: string;
	tone: Tone;
	label: string;
}

const STATE_META: Record<ThreadState, StateMeta> = {
	created: { glyph: "✎", tone: "dim", label: "draft" },
	submitted: { glyph: "○", tone: "warning", label: "submitted" },
	seen: { glyph: "◐", tone: "accent", label: "seen" },
	review: { glyph: "●", tone: "success", label: "review" },
	done: { glyph: "✓", tone: "muted", label: "done" },
};

// States the count legend and filter cycle cover. Resolved threads appear
// because listThreads asks gust for `--filter all`.
const COUNTED_STATES: ThreadState[] = ["created", "submitted", "seen", "review", "done"];

const FILTERS = ["all", "open", "submitted", "seen", "review", "done"] as const;
type Filter = (typeof FILTERS)[number];

const TWO_PANE_MIN_WIDTH = 84;
const LEFT_MIN = 26;
const LEFT_MAX = 48;
const SCROLL_STEP = 3;

interface DetailLine {
	text: string;
	tone?: Tone;
	bold?: boolean;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function padRight(text: string, width: number): string {
	const current = visibleWidth(text);
	if (current >= width) return truncateToWidth(text, width);
	return text + " ".repeat(width - current);
}

function wrapRaw(text: string, width: number): string[] {
	if (text.length === 0) return [""];
	const wrapped = wrapTextWithAnsi(text, Math.max(1, width));
	return wrapped.length > 0 ? wrapped : [""];
}

function formatTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isShiftLetter(data: string, letter: "j" | "k"): boolean {
	return matchesKey(data, Key.shift(letter)) || data === letter.toUpperCase();
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

type Mode = "browse" | "detail" | "reply" | "confirm";

export class ThreadsDialog implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly client: GustClient;
	private readonly done: () => void;

	private threads: Thread[] = [];
	private selected = 0;
	private listOffset = 0;
	private detailScroll = 0;
	private filter: Filter = "all";
	private mode: Mode = "browse";
	private replyIntent: "reply" | "review" = "reply";
	private replyAuthor: Author = "human";
	private replyEditor: Editor | null = null;
	private loading = true;
	private busy = false;
	private status = "";
	private error = "";
	private _focused = false;
	private readonly orchestrator: Orchestrator | null;
	private readonly unsubscribe: (() => void) | undefined;
	private activeWorkerId: string | null = null;

	constructor(
		tui: TUI,
		theme: Theme,
		client: GustClient,
		done: () => void,
		orchestrator: Orchestrator | null = null,
	) {
		this.tui = tui;
		this.theme = theme;
		this.client = client;
		this.done = done;
		this.orchestrator = orchestrator;
		this.unsubscribe = orchestrator?.subscribe(() => this.tui.requestRender());
		void this.load();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.replyEditor) this.replyEditor.focused = value;
	}

	invalidate(): void {
		this.replyEditor?.invalidate();
	}

	// --- data -----------------------------------------------------------------

	async load(): Promise<void> {
		this.loading = true;
		this.error = "";
		this.tui.requestRender();
		try {
			this.threads = await this.client.listThreads();
		} catch (error) {
			this.error = errorMessage(error);
		}
		this.loading = false;
		this.syncSelection();
		this.tui.requestRender();
	}

	async refresh(): Promise<void> {
		if (this.loading) return;
		const keepId = this.selectedThread()?.id;
		try {
			this.threads = await this.client.listThreads();
			this.error = "";
			if (keepId) {
				const index = this.visibleThreads().findIndex((thread) => thread.id === keepId);
				if (index >= 0) this.selected = index;
			}
		} catch (error) {
			this.error = errorMessage(error);
		}
		this.syncSelection();
		this.tui.requestRender();
	}

	// --- selection & filtering ------------------------------------------------

	private visibleThreads(): Thread[] {
		switch (this.filter) {
			case "all":
				return this.threads;
			case "open":
				return this.threads.filter((t) => t.state === "submitted" || t.state === "seen" || t.state === "review");
			default:
				return this.threads.filter((t) => t.state === this.filter);
		}
	}

	private selectedThread(): Thread | undefined {
		return this.visibleThreads()[this.selected];
	}

	private syncSelection(): void {
		const count = this.visibleThreads().length;
		this.selected = clamp(this.selected, 0, Math.max(0, count - 1));
	}

	private select(delta: number): void {
		const count = this.visibleThreads().length;
		if (count === 0) return;
		const next = clamp(this.selected + delta, 0, count - 1);
		if (next !== this.selected) {
			this.selected = next;
			this.detailScroll = 0;
		}
		this.tui.requestRender();
	}

	private cycleFilter(): void {
		const index = FILTERS.indexOf(this.filter);
		this.filter = FILTERS[(index + 1) % FILTERS.length];
		this.selected = 0;
		this.listOffset = 0;
		this.detailScroll = 0;
		this.status = `filter: ${this.filter}`;
		this.tui.requestRender();
	}

	private scrollDetail(delta: number): void {
		this.detailScroll = Math.max(0, this.detailScroll + delta);
		this.tui.requestRender();
	}

	private async toggleWorkers(): Promise<void> {
		if (!this.orchestrator) {
			this.status = "worker orchestrator unavailable";
			this.tui.requestRender();
			return;
		}
		if (this.orchestrator.isRunning()) {
			await this.orchestrator.stop();
			this.status = "workers stopped";
		} else {
			this.orchestrator.start();
			this.status = "workers started";
		}
		this.tui.requestRender();
	}

	// --- actions --------------------------------------------------------------

	private beginReply(intent: "reply" | "review"): void {
		const thread = this.selectedThread();
		if (!thread) return;
		if (thread.state === "done") {
			this.status = "thread is resolved";
			this.tui.requestRender();
			return;
		}
		if (thread.state === "created") {
			this.status = "draft — submit it in the browser first";
			this.tui.requestRender();
			return;
		}
		this.replyIntent = intent;
		this.replyAuthor = intent === "review" ? "agent" : "human";
		this.replyEditor = new Editor(this.tui, createEditorTheme(this.theme));
		this.replyEditor.focused = this._focused;
		this.mode = "reply";
		this.status = "";
		this.error = "";
		this.tui.requestRender();
	}

	private returnFromReply(): void {
		this.replyEditor = null;
		this.mode = this.tui.terminal.columns < TWO_PANE_MIN_WIDTH ? "detail" : "browse";
		this.tui.requestRender();
	}

	private cancelReply(): void {
		this.returnFromReply();
	}

	private async submitReply(): Promise<void> {
		const thread = this.selectedThread();
		const editor = this.replyEditor;
		if (!thread || !editor) return;
		const text = editor.getText().trim();
		if (!text) {
			this.status = "nothing to send";
			this.tui.requestRender();
			return;
		}
		const author: Author = this.replyIntent === "review" ? "agent" : this.replyAuthor;
		this.busy = true;
		this.status = "sending…";
		this.error = "";
		this.tui.requestRender();
		try {
			if (this.replyIntent === "review") {
				await this.client.review(thread.id, text);
				this.status = `marked review: ${thread.path}`;
			} else {
				await this.client.reply(thread.id, text, author === "human");
				this.status = `replied as ${author} to ${thread.path}`;
			}
			this.returnFromReply();
			await this.refresh();
		} catch (error) {
			this.error = `send failed: ${errorMessage(error)}`;
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
	}

	private requestResolve(): void {
		const thread = this.selectedThread();
		if (!thread) return;
		if (thread.state === "done") {
			this.status = "already resolved";
			this.tui.requestRender();
			return;
		}
		if (thread.state === "created") {
			this.status = "cannot resolve a draft";
			this.tui.requestRender();
			return;
		}
		this.mode = "confirm";
		this.tui.requestRender();
	}

	private async confirmResolve(): Promise<void> {
		const thread = this.selectedThread();
		if (!thread) return;
		this.busy = true;
		this.mode = "browse";
		this.status = "resolving…";
		this.error = "";
		this.tui.requestRender();
		try {
			await this.client.done(thread.id);
			this.status = `resolved ${thread.path}`;
			await this.refresh();
		} catch (error) {
			this.error = `resolve failed: ${errorMessage(error)}`;
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
	}

	private close(): void {
		this.unsubscribe?.();
		this.done();
	}

	// --- input ----------------------------------------------------------------

	handleInput(data: string): void {
		if (this.busy) return;

		if (this.mode === "reply") {
			this.handleReplyInput(data);
			return;
		}

		if (this.mode === "confirm") {
			if (data === "y" || data === "Y") {
				void this.confirmResolve();
				return;
			}
			if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
				this.mode = "browse";
				this.status = "cancelled";
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.escape)) {
			if (this.mode === "detail") {
				this.mode = "browse";
				this.tui.requestRender();
				return;
			}
			this.close();
			return;
		}

		const narrow = this.tui.terminal.columns < TWO_PANE_MIN_WIDTH;

		if (isShiftLetter(data, "j")) {
			this.scrollDetail(SCROLL_STEP);
			return;
		}
		if (isShiftLetter(data, "k")) {
			this.scrollDetail(-SCROLL_STEP);
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.select(-1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.select(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (narrow && this.mode === "browse") {
				this.mode = "detail";
				this.detailScroll = 0;
				this.tui.requestRender();
			} else {
				this.beginReply("reply");
			}
			return;
		}
		if (data === "r") {
			this.beginReply("reply");
			return;
		}
		if (data === "s") {
			this.beginReply("review");
			return;
		}
		if (data === "x") {
			this.requestResolve();
			return;
		}
		if (data === "g") {
			void this.refresh();
			return;
		}
		if (data === "w") {
			void this.toggleWorkers();
			return;
		}
		if (data === "f") {
			this.cycleFilter();
		}
	}

	private handleReplyInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.status = "reply cancelled";
			this.cancelReply();
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			void this.submitReply();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			if (this.replyIntent === "review") {
				this.status = "review replies are always agent";
			} else {
				this.replyAuthor = this.replyAuthor === "human" ? "agent" : "human";
				this.status = "";
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.replyEditor?.insertTextAtCursor?.("\n");
			this.tui.requestRender();
			return;
		}
		this.replyEditor?.handleInput(data);
		this.tui.requestRender();
	}

	// --- rendering ------------------------------------------------------------

	private tone(text: string, tone: Tone): string {
		return this.theme.fg(tone, text);
	}

	private renderLine(line: DetailLine): string {
		const text = line.bold ? this.theme.bold(line.text) : line.text;
		return line.tone ? this.tone(text, line.tone) : text;
	}

	private renderHeader(width: number): string {
		const title = this.theme.fg("accent", this.theme.bold(" Gust comments "));
		const subtitle = this.theme.fg("dim", ` ${this.client.invocationLabel()} · ${this.client.socketLabel()}`);
		const right = this.theme.fg("muted", `filter: ${this.filter} `);
		const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(subtitle) - visibleWidth(right));
		return truncateToWidth(title + subtitle + " ".repeat(gap) + right, width);
	}

	private renderCounts(width: number): string {
		const parts = COUNTED_STATES.map((state) => {
			const count = this.threads.filter((t) => t.state === state).length;
			const meta = STATE_META[state];
			return `${this.tone(meta.glyph, meta.tone)} ${this.theme.fg("muted", String(count))}`;
		});
		const total = this.theme.fg("dim", `${this.threads.length} threads`);
		let line = `${this.theme.fg("dim", "  ")}${parts.join("  ")}   ${total}`;
		if (this.orchestrator) {
			const status = this.orchestrator.status();
			if (status.started) {
				const label = status.running
					? `workers ${status.phase}${status.active ? `▶${status.active.slice(0, 6)}` : ""}`
					: "workers off";
				line += this.theme.fg("dim", `   ${label}`);
			}
		}
		return truncateToWidth(line, width);
	}

	private renderLeftCell(thread: Thread | undefined, rowWidth: number, isSelected: boolean): string {
		if (!thread) return " ".repeat(rowWidth);
		const meta = STATE_META[thread.state];
		const working = thread.id === this.activeWorkerId;
		const marker = working ? this.theme.fg("warning", "⚙") : isSelected ? this.theme.fg("accent", "▌") : " ";
		const glyph = this.tone(meta.glyph, meta.tone);
		let line = `${marker} ${glyph} `;
		const pathColor = isSelected ? this.theme.fg("accent", this.theme.bold(thread.path)) : this.theme.fg("muted", thread.path);
		line += truncateToWidth(pathColor, Math.max(1, rowWidth - visibleWidth(line)));
		const remaining = rowWidth - visibleWidth(line);
		if (remaining > 4) {
			const preview = truncateToWidth(thread.text.replace(/\s+/g, " "), remaining - 1);
			line += this.theme.fg("dim", ` ${preview}`);
		}
		return padRight(truncateToWidth(line, rowWidth), rowWidth);
	}

	private buildDetail(width: number): DetailLine[] {
		const thread = this.selectedThread();
		const out: DetailLine[] = [];
		if (!thread) {
			out.push({ text: this.threads.length === 0 ? "No threads." : "No threads match this filter.", tone: "muted" });
			return out;
		}

		const meta = STATE_META[thread.state];
		out.push({ text: thread.path, tone: "accent", bold: true });
		out.push({ text: `${meta.label}  ·  thread id ${thread.id}${thread.batchId ? `  ·  batch ${thread.batchId}` : ""}`, tone: meta.tone });
		if (thread.id === this.activeWorkerId) out.push({ text: "⚙ worker running", tone: "warning" });
		const times = [`created ${formatDateTime(thread.createdAt)}`];
		if (thread.finishedAt) times.push(`resolved ${formatDateTime(thread.finishedAt)}`);
		out.push({ text: times.join("  ·  "), tone: "dim" });
		out.push({ text: "" });

		if (thread.locator) {
			for (const line of wrapRaw(`locator  ${thread.locator}`, width)) out.push({ text: line, tone: "dim" });
		}
		if (thread.html) {
			out.push({ text: "html", tone: "dim" });
			for (const line of wrapRaw(thread.html, width - 2)) out.push({ text: `  ${line}`, tone: "dim" });
		}
		out.push({ text: "" });

		out.push({ text: `messages (${thread.messages.length + 1})`, tone: "dim" });
		const root: ThreadMessage = { id: `root-${thread.id}`, author: "human", text: thread.text, createdAt: thread.createdAt };
		for (const message of [root, ...thread.messages]) {
			const authorTone: Tone = message.author === "human" ? "accent" : "success";
			out.push({ text: `▌ ${message.author}  ${formatTime(message.createdAt)}`, tone: authorTone, bold: true });
			for (const line of wrapRaw(message.text, width - 2)) out.push({ text: `  ${line}` });
			out.push({ text: "" });
		}

		return out;
	}

	private footerHint(): string {
		if (this.mode === "reply") {
			const toggle = this.replyIntent === "review" ? "" : " · tab author";
			const label = this.replyIntent === "review" ? "review reply" : `reply as ${this.replyAuthor}`;
			return ` ${label}${toggle} · ctrl+s send · enter newline · esc cancel`;
		}
		if (this.mode === "confirm") return " resolve this thread? y/n";
		const narrow = this.tui.terminal.columns < TWO_PANE_MIN_WIDTH;
		if (narrow && this.mode === "browse") return " ↑↓ select · enter open · g refresh · f filter · w workers · esc close";
		if (narrow) return " shift+j/k scroll · r reply · s review · x resolve · w workers · esc back";
		return " ↑↓ select · shift+j/k scroll · enter/r reply · s review · x resolve · g refresh · f filter · w workers · esc close";
	}

	private renderReplyBox(width: number, lines: string[]): void {
		const inner = Math.max(1, width - 2);
		const border = this.theme.fg("accent", "─".repeat(width));
		const label = this.replyIntent === "review" ? "Review reply" : "Reply";
		const header = this.theme.fg("accent", this.theme.bold(` ${label} `));
		const author: Author = this.replyIntent === "review" ? "agent" : this.replyAuthor;
		const who = this.theme.fg(author === "human" ? "accent" : "success", ` (${author})`);
		lines.push(border);
		lines.push(truncateToWidth(header + who, width));
		const editorLines = this.replyEditor?.render(inner) ?? [""];
		for (const line of editorLines) {
			lines.push(truncateToWidth(` ${line}`, width));
		}
		lines.push(truncateToWidth(this.theme.fg("dim", this.footerHint()), width));
		lines.push(border);
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const narrow = this.tui.terminal.columns < TWO_PANE_MIN_WIDTH;
		const rows = this.tui.terminal.rows;
		const bodyRows = clamp(Math.floor(rows * 0.55), 8, 24);

		this.syncSelection();
		this.activeWorkerId = this.orchestrator?.status().active ?? null;
		const filtered = this.visibleThreads();

		const border = this.theme.fg("accent", "─".repeat(renderWidth));
		const separator = this.theme.fg("dim", "─".repeat(renderWidth));

		if (this.loading && this.threads.length === 0) {
			return [
				border,
				this.renderHeader(renderWidth),
				truncateToWidth(this.theme.fg("muted", " Loading threads…"), renderWidth),
				border,
			];
		}

		if (this.mode === "reply") {
			const lines: string[] = [border, this.renderHeader(renderWidth), this.renderCounts(renderWidth), separator];
			const leftWidth = narrow ? renderWidth : clamp(Math.floor(renderWidth * 0.42), LEFT_MIN, LEFT_MAX);
			if (narrow) {
				for (const line of this.buildDetail(renderWidth).slice(this.detailScroll, this.detailScroll + Math.max(1, bodyRows - 2))) {
					lines.push(truncateToWidth(this.renderLine(line), renderWidth));
				}
			} else {
				const rightWidth = Math.max(1, renderWidth - leftWidth - 3);
				const detail = this.buildDetail(rightWidth);
				for (let row = 0; row < Math.max(1, bodyRows - 4); row += 1) {
					const left = this.renderLeftCell(filtered[this.listOffset + row], leftWidth, this.listOffset + row === this.selected);
					const detailLine = detail[row];
					const right = detailLine ? this.renderLine(detailLine) : "";
					lines.push(`${left}${this.theme.fg("dim", " │ ")}${truncateToWidth(right, rightWidth)}`);
				}
			}
			this.renderReplyBox(renderWidth, lines);
			return lines;
		}

		const lines: string[] = [border, this.renderHeader(renderWidth), this.renderCounts(renderWidth), separator];

		if (narrow && this.mode !== "detail") {
			for (let row = 0; row < bodyRows; row += 1) {
				const index = this.listOffset + row;
				lines.push(this.renderLeftCell(filtered[index], renderWidth, index === this.selected));
			}
			if (filtered.length === 0) {
				lines.push(truncateToWidth(this.theme.fg("muted", " No threads match this filter."), renderWidth));
			}
			this.scrollListIntoView(bodyRows, filtered.length);
		} else if (narrow) {
			const detail = this.buildDetail(renderWidth);
			const maxScroll = Math.max(0, detail.length - bodyRows);
			this.detailScroll = clamp(this.detailScroll, 0, maxScroll);
			for (let row = 0; row < bodyRows; row += 1) {
				const detailLine = detail[this.detailScroll + row];
				lines.push(detailLine ? truncateToWidth(this.renderLine(detailLine), renderWidth) : "");
			}
		} else {
			const leftWidth = clamp(Math.floor(renderWidth * 0.42), LEFT_MIN, LEFT_MAX);
			const rightWidth = Math.max(1, renderWidth - leftWidth - 3);
			const detail = this.buildDetail(rightWidth);
			const maxScroll = Math.max(0, detail.length - bodyRows);
			this.detailScroll = clamp(this.detailScroll, 0, maxScroll);
			this.scrollListIntoView(bodyRows, filtered.length);
			for (let row = 0; row < bodyRows; row += 1) {
				const left = this.renderLeftCell(filtered[this.listOffset + row], leftWidth, this.listOffset + row === this.selected);
				const detailLine = detail[this.detailScroll + row];
				const right = detailLine ? this.renderLine(detailLine) : "";
				lines.push(`${left}${this.theme.fg("dim", " │ ")}${truncateToWidth(right, rightWidth)}`);
			}
		}

		lines.push(separator);
		lines.push(truncateToWidth(this.theme.fg("dim", this.footerHint()), renderWidth));
		if (this.busy) {
			lines.push(truncateToWidth(this.theme.fg("warning", ` ${this.status}`), renderWidth));
		} else if (this.error) {
			lines.push(truncateToWidth(this.theme.fg("error", ` ${this.error}`), renderWidth));
		} else if (this.status) {
			lines.push(truncateToWidth(this.theme.fg("success", ` ${this.status}`), renderWidth));
		}
		lines.push(border);
		return lines;
	}

	private scrollListIntoView(bodyRows: number, count: number): void {
		if (this.selected < this.listOffset) this.listOffset = this.selected;
		if (this.selected >= this.listOffset + bodyRows) {
			this.listOffset = this.selected - bodyRows + 1;
		}
		this.listOffset = clamp(this.listOffset, 0, Math.max(0, count - bodyRows));
	}
}
