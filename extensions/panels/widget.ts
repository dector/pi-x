/**
 * The coordinator-owned above-editor widget.
 *
 * Panels used to each call `ctx.ui.setWidget` with their own id, which made the
 * on-screen order depend on registration/refresh timing and remounted every
 * widget whenever a panel cycled. The coordinator now owns exactly one widget
 * (`px-panels`) and renders every panel's cached content in fixed order.
 *
 * The component instance is created once and reused for the whole session. A
 * content refresh only invalidates it and requests a render, so cycling and
 * timer ticks never remount the widget and cannot flicker. The widget is
 * mounted lazily on the first content and cleared when no panel has content or
 * the session shuts down.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

/** Stable widget id owned by the panels coordinator. */
export const PANELS_WIDGET_ID = "px-panels";

/** What the widget needs from the coordinator: ordered lines + emptiness. */
export interface PanelsRenderSource {
	/** Render every registered panel with cached content, in cycle order. */
	renderAll(width: number): string[];
	/** True when at least one panel has content to show. */
	hasContent(): boolean;
}

export class PanelsWidget {
	private mounted = false;
	private tui: TUI | undefined;
	private readonly component: Component;

	constructor(private readonly source: PanelsRenderSource) {
		this.component = {
			render: (width: number) => {
				const lines = this.source.renderAll(width);
				return lines.length > 0 ? [...lines, ""] : lines;
			},
			invalidate: () => {},
		};
	}

	/** True while the widget component is mounted in the UI. */
	get isMounted(): boolean {
		return this.mounted;
	}

	/**
	 * Sync the widget with the coordinator's current content.
	 *
	 * Mounts once on the first content, then only requests a render. Clears the
	 * widget when no panel has content. Safe to call before a session context
	 * exists (for example content published during `session_start`): the content
	 * stays cached and the next call with a context mounts it.
	 */
	refresh(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		if (!this.source.hasContent()) {
			this.clear(ctx);
			return;
		}
		if (!this.mounted) {
			try {
				ctx.ui.setWidget(
					PANELS_WIDGET_ID,
					(tui: TUI) => {
						this.tui = tui;
						return this.component;
					},
					{ placement: "aboveEditor" },
				);
				this.mounted = true;
			} catch {
				// A stale or closing UI must not break the coordinator.
				return;
			}
		}
		this.component.invalidate();
		this.tui?.requestRender();
	}

	/** Remove the widget from the UI, if it is mounted. */
	clear(ctx: ExtensionContext | undefined): void {
		if (!this.mounted) return;
		this.mounted = false;
		this.tui = undefined;
		try {
			ctx?.ui.setWidget(PANELS_WIDGET_ID, undefined, { placement: "aboveEditor" });
		} catch {
			// Ignore a stale or closing UI; lifecycle cleanup must still run.
		}
	}
}
