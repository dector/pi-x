import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Key, matchesKey, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Orchestrator } from "./orchestrator.ts";

// Do not allow tool output to inject terminal escape sequences.
function clean(text: string): string {
	return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");
}

export class ActivityMonitor implements Component, Focusable {
	focused = false;
	private selected = 0;
	private selectedId: string | undefined;
	private activityId: string | undefined;
	private offset = 0;
	private maxOffset = 0;
	private following = true;
	private pendingG = false;
	private error = "";
	private loading = true;
	private closed = false;
	private readonly unsubscribe: () => void;

	constructor(private tui: TUI, private theme: Theme, private worker: Orchestrator, private done: () => void) {
		this.unsubscribe = worker.subscribe(() => { if (!this.closed) this.tui.requestRender(); });
		void this.load();
	}

	async load(): Promise<void> {
		try { await this.worker.loadThreads(); this.error = ""; }
		catch (error) { this.error = error instanceof Error ? error.message : String(error); }
		this.loading = false;
		if (!this.closed) this.tui.requestRender();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.activityId) { this.activityId = undefined; this.pendingG = false; }
			else { this.closed = true; this.unsubscribe(); this.done(); }
		} else if (!this.activityId) {
			const threads = this.worker.monitorThreads();
			if (data === "j" || matchesKey(data, "j") || matchesKey(data, Key.down)) this.selected = Math.min(threads.length - 1, this.selected + 1);
			if (data === "k" || matchesKey(data, "k") || matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
			this.selectedId = threads[this.selected]?.id;
			if (matchesKey(data, Key.enter) && this.selectedId) {
				this.activityId = this.selectedId;
				this.following = true;
				this.offset = 0;
			}
		} else {
			if (data === "g" || matchesKey(data, "g")) {
				if (this.pendingG) { this.offset = 0; this.following = false; }
				this.pendingG = !this.pendingG;
			} else {
				this.pendingG = false;
				if (data === "G" || matchesKey(data, Key.shift("g"))) { this.offset = this.maxOffset; this.following = true; }
				else {
					const step = data === "J" || matchesKey(data, Key.shift("j")) ? 5
						: data === "K" || matchesKey(data, Key.shift("k")) ? -5
						: data === "j" || matchesKey(data, "j") || matchesKey(data, Key.down) ? 1
						: data === "k" || matchesKey(data, "k") || matchesKey(data, Key.up) ? -1 : 0;
					if (step) {
						this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + step));
						this.following = this.offset === this.maxOffset;
					}
				}
			}
		}
		if (!this.closed) this.tui.requestRender();
	}

	render(width: number): string[] {
		const height = Math.max(1, (this.tui.terminal.rows ?? 24) - 4);
		const fit = (text: string) => truncateToWidth(text, Math.max(1, width));
		const threads = this.worker.monitorThreads();
		if (this.selectedId) {
			const index = threads.findIndex((thread) => thread.id === this.selectedId);
			if (index >= 0) this.selected = index;
		}
		this.selected = Math.max(0, Math.min(this.selected, threads.length - 1));
		this.selectedId = threads[this.selected]?.id;
		if (!this.activityId) {
			const lines = [this.theme.fg("accent", fit("Gust activity — threads"))];
			const start = Math.max(0, this.selected - height + 1);
			for (const [index, thread] of threads.slice(start, start + height).entries()) {
				const state = this.worker.activity(thread.id).state;
				const text = `${start + index === this.selected ? "›" : " "} ${thread.id.slice(0, 8)} [${state}] ${clean(thread.text).replace(/\s+/g, " ")}`;
				lines.push(fit(text));
			}
			if (this.loading) lines.push(fit("Loading threads…"));
			else if (!threads.length) lines.push(fit("No threads available."));
			if (this.error) lines.push(fit(`Error: ${clean(this.error)}`));
			lines.push(fit("j/k select · Enter activity · Esc close"));
			return lines;
		}
		const activity = this.worker.activity(this.activityId);
		const thread = threads.find((thread) => thread.id === this.activityId);
		const content = activity.entries.flatMap((entry) => {
			const prefix = entry.kind === "text" ? "" : `[${entry.kind}] `;
			return (prefix + clean(entry.text)).split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
		});
		if (!content.length) content.push("No worker activity yet.");
		this.maxOffset = Math.max(0, content.length - height);
		if (this.following) this.offset = this.maxOffset;
		else this.offset = Math.min(this.offset, this.maxOffset);
		return [
			this.theme.fg("accent", fit(`${this.activityId.slice(0, 8)} [${activity.state}] ${clean(thread?.text ?? "").replace(/\s+/g, " ")}`)),
			...content.slice(this.offset, this.offset + height).map(fit),
			fit(`gg start · G end · j/k line · J/K 5 lines · Esc list${this.following ? " · live tail" : ""}`),
		];
	}
}
