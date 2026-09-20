/**
 * Live attach overlay for a subagent run.
 *
 * The view renders the transcript built by `attach.ts`, follows the tail while
 * new output arrives, and lets the user scroll, steer, or detach. Steering is
 * submitted through an injected native transport (see `sendSteer` in
 * `registry.ts`) so the view can show inline success/failure and does not need
 * to know how the child is reached.
 *
 * The component is driven by a small 200ms poll because the registry already
 * mutates the in-memory `SingleResult`; polling keeps the view simple and only
 * runs while the overlay is open. `dispose()` is idempotent so the framework,
 * an explicit close, and session teardown can all call it safely.
 *
 * The embedded editor receives raw input and owns the terminal cursor while
 * composing, and the view forwards `focused` to it for IME candidate-window
 * positioning. Tests inject a fake editor so the interaction can be exercised
 * without a real terminal.
 */

import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import { buildTranscript, TranscriptViewport, type TranscriptBlock } from "./attach.ts";
import { formatToolCall, formatToolStatus, type ThemeFg } from "./format.ts";
import { isFailedResult } from "./result-output.ts";
import type { SingleResult } from "./types.ts";

/** Poll cadence for live updates while attached. */
export const ATTACH_POLL_INTERVAL_MS = 200;

export interface AttachTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export interface AttachViewRun {
	runId: string;
	agentName: string;
	startedAt: number;
	completedAt?: number;
}

export interface AttachViewTimers {
	set: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
	clear: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_TIMERS: AttachViewTimers = {
	set: (callback, delayMs) => setInterval(callback, delayMs),
	clear: (handle) => clearInterval(handle),
};

/**
 * Minimal editor seam. The real `Editor` from `@earendil-works/pi-tui`
 * satisfies this structurally; tests supply a fake that records submissions.
 */
export interface AttachEditor {
	focused: boolean;
	disableSubmit: boolean;
	onSubmit?: (text: string) => void;
	render(width: number): string[];
	handleInput(data: string): void;
	getText?(): string;
	setText?(text: string): void;
}

/** Inline steering status shown under the editor. */
export interface AttachSteerStatus {
	kind: "info" | "success" | "error";
	text: string;
}

/** Which keyboard target currently owns input. */
export type AttachMode = "scroll" | "compose";

export interface AttachViewOptions {
	/** Reads the live result on every render so updates are always current. */
	getResult: () => SingleResult;
	getRun: () => AttachViewRun;
	theme: AttachTheme;
	requestRender: () => void;
	done: (result: null) => void;
	/** Embedded steering editor. Omitted in read-only/no-input contexts. */
	editor?: AttachEditor;
	/**
	 * Deliver a steering message to the given run. Resolves on success and
	 * rejects with a user-facing message on failure. Addressing the run by id
	 * keeps the transport honest about which child was steered.
	 */
	steer?: (runId: string, message: string) => Promise<void>;
	/** Terminal row count; defaults to 24 when unavailable. */
	terminalRows?: () => number;
	/** Injectable clock for deterministic tests. */
	now?: () => number;
	pollIntervalMs?: number;
	timers?: AttachViewTimers;
}

export class AttachView implements Component, Focusable {
	private readonly viewport = new TranscriptViewport();
	private expanded = false;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;
	private closed = false;
	private mode: AttachMode = "scroll";
	private submitting = false;
	private steerStatus: AttachSteerStatus | undefined;
	private _focused = false;

	constructor(private readonly options: AttachViewOptions) {
		if (this.options.editor) {
			this.options.editor.onSubmit = (text) => {
				void this.submitSteer(text);
			};
			this.options.editor.disableSubmit = this.isReadOnly;
		}
		this.startPolling();
	}

	/** Focusable interface: the TUI sets this on the focused overlay. */
	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncEditorFocus();
	}

	/** Whether the viewport is pinned to the newest transcript line. */
	get isFollowing(): boolean {
		return this.viewport.isFollowing;
	}

	/** Whether expanded tool arguments/results are shown. */
	get isExpanded(): boolean {
		return this.expanded;
	}

	/** Whether the run has settled and steering is disabled. */
	get isReadOnly(): boolean {
		const run = this.options.getRun();
		if (run.completedAt !== undefined) return true;
		const result = this.options.getResult();
		if (result.state === "settled" || result.state === "failed") return true;
		return typeof result.exitCode === "number" && result.exitCode !== -1;
	}

	/** Current keyboard target. */
	get inputMode(): AttachMode {
		return this.mode;
	}

	/** Last inline steering status, if any. */
	get lastSteerStatus(): AttachSteerStatus | undefined {
		return this.steerStatus;
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const result = this.options.getResult();
		const run = this.options.getRun();
		const theme = this.options.theme;

		const readOnly = this.isReadOnly;
		if (readOnly && this.mode === "compose") this.mode = "scroll";
		if (this.options.editor) this.options.editor.disableSubmit = readOnly || this.submitting;
		this.syncEditorFocus();

		const taskLines = this.renderTask(result.task, w);
		const body: string[] = [];
		for (const block of buildTranscript(result, { includeTask: false })) body.push(...this.renderBlock(block, w));

		const statusLines = this.renderStatusLines(w, readOnly);
		const editorLines = this.renderEditor(w, readOnly);

		const totalRows = Math.max(8, (this.options.terminalRows?.() ?? 24) - 2);
		// Header + task + two separators + help + status; keep at least one
		// transcript row before the editor claims the rest.
		const reserved = 1 + taskLines.length + 2 + 1 + statusLines.length;
		const maxEditor = Math.max(0, totalRows - reserved - 1);
		const clippedEditor = editorLines.length > maxEditor ? editorLines.slice(editorLines.length - maxEditor) : editorLines;
		const chrome = reserved + clippedEditor.length;
		const viewportHeight = Math.max(1, totalRows - chrome);
		this.viewport.setViewportHeight(viewportHeight);
		this.viewport.update(body.length);
		const windowLines = this.viewport.window(body);
		while (windowLines.length < viewportHeight) windowLines.push("");

		const separator = theme.fg("dim", "─".repeat(w));
		const lines = [this.headerLine(result, run, w)];
		lines.push(...taskLines);
		lines.push(separator);
		lines.push(...windowLines);
		lines.push(separator);
		if (clippedEditor.length > 0) lines.push(...clippedEditor);
		lines.push(...statusLines);
		lines.push(this.helpLine(w, readOnly));
		return lines;
	}

	handleInput(data: string): void {
		const readOnly = this.isReadOnly;
		if (matchesKey(data, Key.escape)) {
			if (this.mode === "compose") {
				this.setMode("scroll");
				return;
			}
			this.close();
			return;
		}

		if (this.mode === "compose" && !readOnly) {
			if (matchesKey(data, Key.ctrl("enter"))) {
				const text = this.options.editor?.getText?.() ?? "";
				this.options.editor?.setText?.("");
				void this.submitSteer(text);
				this.options.requestRender();
				return;
			}
			this.options.editor?.handleInput(data);
			this.options.requestRender();
			return;
		}

		if (matchesKey(data, Key.up)) this.viewport.lineUp();
		else if (matchesKey(data, Key.down)) this.viewport.lineDown();
		else if (matchesKey(data, Key.pageUp)) this.viewport.pageUp();
		else if (matchesKey(data, Key.pageDown)) this.viewport.pageDown();
		else if (matchesKey(data, Key.home)) this.viewport.scrollToTop();
		else if (matchesKey(data, Key.end)) this.viewport.scrollToBottom();
		else if (matchesKey(data, Key.ctrl("o"))) this.expanded = !this.expanded;
		else if (matchesKey(data, Key.enter) && !readOnly && this.options.editor) {
			this.setMode("compose");
			return;
		} else return;
		this.options.requestRender();
	}

	/**
	 * Submit steering text through the injected transport. Public so the
	 * editor callback and tests share one path. Empty messages are ignored.
	 */
	async submitSteer(message: string): Promise<void> {
		const text = message.trim();
		if (text.length === 0) return;
		if (this.isReadOnly) {
			this.steerStatus = { kind: "error", text: "This run has settled; steering is read-only." };
			this.options.requestRender();
			return;
		}
		if (this.submitting) return;
		const steer = this.options.steer;
		if (!steer) {
			this.steerStatus = { kind: "error", text: "Steering is unavailable for this run." };
			this.options.requestRender();
			return;
		}

		const runId = this.options.getRun().runId;
		this.submitting = true;
		if (this.options.editor) this.options.editor.disableSubmit = true;
		this.steerStatus = { kind: "info", text: `Sending steering message to ${runId}…` };
		this.options.requestRender();
		try {
			await steer(runId, text);
			this.steerStatus = { kind: "success", text: `Steering message sent to ${runId}.` };
		} catch (error) {
			this.steerStatus = { kind: "error", text: error instanceof Error ? error.message : String(error) };
		} finally {
			this.submitting = false;
			if (this.options.editor) this.options.editor.disableSubmit = this.isReadOnly;
			this.options.requestRender();
		}
	}

	invalidate(): void {
		// Rendering is recomputed from live state on every frame; nothing cached.
	}

	/** Clear the poll timer. Safe to call multiple times. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.pollTimer !== undefined) {
			(this.options.timers ?? DEFAULT_TIMERS).clear(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	/** Detach: stop polling and resolve the overlay promise. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.options.done(null);
	}

	// --- internals ---------------------------------------------------------

	private setMode(mode: AttachMode): void {
		this.mode = mode;
		this.syncEditorFocus();
		this.options.requestRender();
	}

	/** Forward focus to the embedded editor only while composing. */
	private syncEditorFocus(): void {
		if (!this.options.editor) return;
		this.options.editor.focused = this._focused && this.mode === "compose" && !this.isReadOnly;
	}

	private startPolling(): void {
		const timers = this.options.timers ?? DEFAULT_TIMERS;
		const interval = this.options.pollIntervalMs ?? ATTACH_POLL_INTERVAL_MS;
		this.pollTimer = timers.set(() => {
			if (!this.disposed) this.options.requestRender();
		}, interval);
	}

	private headerLine(result: SingleResult, run: AttachViewRun, width: number): string {
		const theme = this.options.theme;
		const now = this.options.now?.() ?? Date.now();
		const state = result.state ?? (run.completedAt ? "settled" : "running");
		const stateColor = isFailedResult(result) ? "error" : run.completedAt ? "success" : "warning";
		const parts = [
			theme.bold(run.agentName),
			theme.fg("dim", run.runId),
			theme.fg(stateColor, state),
			theme.fg("dim", formatElapsed((run.completedAt ?? now) - run.startedAt)),
		];
		const cost = result.usage?.cost;
		if (typeof cost === "number" && cost > 0) parts.push(theme.fg("dim", `$${cost.toFixed(4)}`));
		return truncateToWidth(parts.join(" · "), width, "…");
	}

	private helpLine(width: number, readOnly: boolean): string {
		const theme = this.options.theme;
		if (readOnly) {
			const expand = this.expanded ? "collapse" : "expand";
			const help = `Esc detach · ↑↓/PgUp/PgDn scroll · End follow · Ctrl+O ${expand} · read-only`;
			return truncateToWidth(theme.fg("dim", help), width, "…");
		}
		if (this.mode === "compose") {
			return truncateToWidth(theme.fg("dim", "Esc back · Enter send · Shift+Enter newline · Ctrl+Enter send"), width, "…");
		}
		const follow = this.viewport.isFollowing ? "following" : "scrolled";
		const expand = this.expanded ? "collapse" : "expand";
		const help = `Esc detach · Enter steer · ${follow} · ↑↓/PgUp/PgDn scroll · End follow · Ctrl+O ${expand}`;
		return truncateToWidth(theme.fg("dim", help), width, "…");
	}

	private renderStatusLines(width: number, readOnly: boolean): string[] {
		const theme = this.options.theme;
		if (this.steerStatus) {
			const { kind, text } = this.steerStatus;
			const color = kind === "error" ? "error" : kind === "success" ? "success" : "muted";
			const glyph = kind === "error" ? "✗ " : kind === "success" ? "✓ " : "… ";
			return [truncateToWidth(theme.fg(color, `${glyph}${text}`), width, "…")];
		}
		if (readOnly) return [truncateToWidth(theme.fg("dim", "run settled · read-only"), width, "…")];
		return [];
	}

	private renderEditor(width: number, readOnly: boolean): string[] {
		if (readOnly || !this.options.editor) return [];
		return this.options.editor.render(width);
	}

	private renderTask(task: unknown, width: number): string[] {
		if (typeof task !== "string" || task.length === 0) return [];
		const prefix = this.options.theme.fg("muted", "task: ");
		const lines = this.wrapWithPrefix(prefix, task, width);
		const maxLines = 2;
		if (lines.length <= maxLines) return lines;
		const clipped = lines.slice(0, maxLines);
		const last = clipped[maxLines - 1] ?? "";
		clipped[maxLines - 1] = truncateToWidth(last, width, "…");
		return clipped;
	}

	private renderBlock(block: TranscriptBlock, width: number): string[] {
		const theme = this.options.theme;
		switch (block.type) {
			case "task":
				return this.wrapWithPrefix(theme.fg("muted", "task: "), block.text, width);
			case "assistant": {
				const label = theme.fg("accent", block.streaming ? "assistant · streaming" : "assistant");
				return [label, ...this.wrap(block.text, width)];
			}
			case "thinking": {
				const label = theme.fg("muted", block.streaming ? "thinking · streaming" : "thinking");
				return [label, ...this.wrap(theme.fg("dim", block.text), width)];
			}
			case "tool-call": {
				const call = theme.fg("muted", "→ ") + formatToolCall(block.name, block.args, theme.fg as ThemeFg);
				const status = formatToolStatus(block.status, theme.fg as ThemeFg);
				const reason = block.summary && block.status !== "completed" ? ` ${theme.fg("dim", `— ${block.summary}`)}` : "";
				const lines = this.wrap(`${call}  ${status}${reason}`, width);
				if (this.expanded) lines.push(...this.wrap(theme.fg("dim", indentJson(block.args)), width));
				return lines;
			}
			case "tool-result": {
				if (this.expanded) {
					const body = block.text.length > 0 ? block.text : "(empty)";
					return [
						theme.fg("muted", "  result:"),
						...this.wrap(body, Math.max(1, width - 2)).map((line) => `  ${line}`),
					];
				}
				const preview = firstLine(block.text);
				if (!preview) return [];
				return this.wrap(theme.fg(block.isError ? "error" : "dim", `  ↳ ${preview}`), width);
			}
			case "approval":
				return this.wrap(theme.fg("warning", `⏸ approval (${block.state}): ${block.title}`), width);
			case "diagnostic":
				return this.wrap(theme.fg("warning", `⚠ ${block.text}`), width);
			case "status":
				return this.wrap(theme.fg("error", block.text), width);
		}
	}

	private wrap(text: string, width: number): string[] {
		const out: string[] = [];
		for (const raw of text.split("\n")) {
			if (raw.length === 0) {
				out.push("");
				continue;
			}
			out.push(...wrapTextWithAnsi(raw, width));
		}
		return out;
	}

	private wrapWithPrefix(prefix: string, text: string, width: number): string[] {
		const prefixWidth = visibleWidth(prefix);
		const lines: string[] = [];
		for (const raw of text.split("\n")) {
			const wrapped = wrapTextWithAnsi(raw, Math.max(1, width - prefixWidth));
			for (let index = 0; index < wrapped.length; index += 1) {
				lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[index]}`);
			}
			if (wrapped.length === 0) lines.push(prefix);
		}
		return lines;
	}
}

function firstLine(text: string): string {
	const index = text.indexOf("\n");
	return (index === -1 ? text : text.slice(0, index)).trim();
}

function indentJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		const remainder = seconds % 60;
		return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
	}
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
