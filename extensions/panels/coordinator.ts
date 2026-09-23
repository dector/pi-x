/**
 * Pure panel-selection state machine and content cache.
 *
 * The coordinator owns which panel is active, when the active id must be
 * re-broadcast, and the last formatted content/renderer published by each
 * panel. It does not know how a panel draws itself: each panel supplies a
 * width-aware `render` with its content, and the coordinator only stacks the
 * results in fixed order. Keeping the selection logic pure makes the cycle
 * rules and the reload/visibility edge cases easy to test.
 *
 * Selection rules:
 * - Every panel starts collapsed: `activeId` defaults to `null`. Registering a
 *   panel, syncing, or changing another panel's visibility never expands one.
 *   `order` alone ties the panels to their display/cycle position.
 * - `Alt+P` cycles the visible panels in fixed `order` (then id) and then
 *   `null`, which means "all panels collapsed". The default forward sequence is
 *   `null -> subagents -> processes -> null`.
 * - `Alt+Shift+P` walks the same cycle backwards, so the default reverse
 *   sequence is `null -> processes -> subagents -> null`.
 * - When the active panel disappears (unregister or `visible: false`), all
 *   panels collapse and stay collapsed until the user presses a cycle key.
 * - Register and sync always re-broadcast the current active id so a panel that
 *   just subscribed cannot miss it. A user's explicit `null` (collapsed) choice
 *   survives later registrations and syncs.
 */
import type { PanelContent, PanelRegistration } from "./contract.ts";

export interface PanelCoordinatorOptions {
	/** Called with the normalized active id on every broadcast. */
	onActive?: (activeId: string | null) => void;
	/** Called whenever cached panel content changes. */
	onContent?: () => void;
}

export class PanelCoordinator {
	private readonly panels = new Map<string, PanelRegistration>();
	/** Last `px:panels:content` payload per panel id. */
	private readonly contents = new Map<string, PanelContent>();
	/** `null` means all panels collapsed, which is the default. */
	private activeId: string | null = null;

	constructor(private readonly options: PanelCoordinatorOptions = {}) {}

	/** Active panel id, or `null` when all panels are collapsed. */
	get active(): string | null {
		return this.activeId;
	}

	/** Registered panels in fixed cycle order. */
	list(): PanelRegistration[] {
		return this.sortedPanels().map((panel) => ({ ...panel }));
	}

	/** Add or refresh a panel, then broadcast the active id. */
	register(registration: PanelRegistration): void {
		this.panels.set(registration.id, { ...registration });
		// Registration never selects a panel. It only collapses when the
		// currently active panel just vanished: it was re-registered as
		// invisible, so nothing may keep it expanded.
		if (this.activeId !== null && registration.id === this.activeId && !registration.visible) {
			this.activeId = null;
		}
		this.publish();
		// Content may have been cached before this panel registered (for example a
		// panel that publishes during `session_start`). Refresh so it mounts now
		// that the registration supplies the cycle position.
		this.options.onContent?.();
	}

	/** Report a visibility change, then broadcast if the active id changed. */
	setVisibility(id: string, visible: boolean): void {
		const panel = this.panels.get(id);
		if (!panel || panel.visible === visible) return;
		panel.visible = visible;

		// A panel that disappears takes the selection with it; nothing else may
		// re-expand it. Only a cycle key selects a panel again.
		if (!visible && this.activeId === id) this.activeId = null;
		this.publish();
	}

	/**
	 * Cache a panel's latest formatted content. `content: undefined` (or an empty
	 * array) removes it, so a disappeared panel never leaves stale lines behind.
	 * Content is cached even before the panel registers; it renders once the
	 * registration supplies the cycle position.
	 */
	setContent(panelContent: PanelContent): void {
		if (panelContent.content === undefined || panelContent.content.length === 0) {
			this.contents.delete(panelContent.id);
		} else {
			this.contents.set(panelContent.id, panelContent);
		}
		this.options.onContent?.();
	}

	/** True when at least one registered panel has content to draw. */
	hasContent(): boolean {
		for (const panel of this.panels.values()) {
			const content = this.contents.get(panel.id)?.content;
			if (content && content.length > 0) return true;
		}
		return false;
	}

	/**
	 * Render every registered panel with cached content, in fixed cycle order
	 * (order, then id). The result is the concatenation of each panel's own
	 * width-aware renderer, so panel order never depends on refresh order.
	 */
	renderAll(width: number): string[] {
		const lines: string[] = [];
		for (const panel of this.sortedPanels()) {
			const cached = this.contents.get(panel.id);
			if (!cached?.content || cached.content.length === 0) continue;
			try {
				lines.push(...cached.render(cached.content, width));
			} catch {
				// A broken panel must not blank the whole widget.
			}
		}
		return lines;
	}

	/** Remove a panel; the active panel collapsing if it was the one removed. */
	unregister(id: string): void {
		if (!this.panels.delete(id)) return;
		this.contents.delete(id);
		if (this.activeId === id) this.activeId = null;
		this.publish();
		this.options.onContent?.();
	}

	/** Advance `Alt+P`: next visible panel, or `null` after the last one. */
	cycle(): void {
		this.step(1);
	}

	/**
	 * Advance `Alt+Shift+P`: previous visible panel. From the default all-collapsed
	 * state the reverse sequence is `null -> processes -> subagents -> null`.
	 */
	cycleBackward(): void {
		this.step(-1);
	}

	private step(direction: 1 | -1): void {
		const visible = this.visiblePanels();
		if (visible.length === 0) {
			this.activeId = null;
			this.publish();
			return;
		}

		// The cycle is the visible panels followed by `null` (all collapsed).
		const sequence: Array<string | null> = [...visible.map((panel) => panel.id), null];
		const found = sequence.indexOf(this.activeId);
		const index = found === -1
			? direction === 1
				? 0
				: sequence.length - 2
			: (found + direction + sequence.length) % sequence.length;
		this.activeId = sequence[index] ?? null;
		this.publish();
	}

	/** Re-broadcast the current active id without changing it. */
	sync(): void {
		this.publish();
	}

	/** Forget all panels, content, and selection, for example on shutdown. */
	clear(): void {
		this.panels.clear();
		this.contents.clear();
		this.activeId = null;
	}

	private visiblePanels(): PanelRegistration[] {
		return this.sortedPanels().filter((panel) => panel.visible);
	}

	private sortedPanels(): PanelRegistration[] {
		return [...this.panels.values()].sort(
			(a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);
	}

	private publish(): void {
		this.options.onActive?.(this.active);
	}
}
