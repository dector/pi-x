/**
 * Click-to-toggle wrapper for a rendered transcript component.
 *
 * The dispatch completion message is a custom message, so the harness already
 * drives expansion through the parent `CustomMessageComponent.setExpanded()`
 * (ctrl+o). This wrapper adds a per-message left-click override on top:
 *
 * - `render` builds the child lazily and rebuilds only when the local state
 *   changes, so a click does not pay for a rebuild on every frame.
 * - `handleMouse` flips the state on a left click and asks for a render.
 * - It deliberately exposes no `setExpanded`, so `isExpandable()` still matches
 *   the parent component and ctrl+o keeps working globally.
 *
 * Mouse events are only routed in fullscreen mode; in regular mode the terminal
 * owns the scrollback and clicks never reach components, so this degrades to a
 * no-op rather than breaking anything.
 */

import type { Component } from "@earendil-works/pi-tui";

/**
 * Minimal structural view of the mouse event and result the runtime dispatches.
 * Declared locally because the public `@earendil-works/pi-tui` entry point does
 * not export these types; the runtime dispatch is duck-typed on `handleMouse`,
 * so the nominal type never matters.
 */
interface MouseClickEvent {
	type: string;
	button: string;
}

interface MouseHandledResult {
	handled: true;
	render: true;
}

export class ClickToggleComponent implements Component {
	private expanded: boolean;
	private cached?: Component;
	private cachedExpanded?: boolean;

	constructor(
		private readonly build: (expanded: boolean) => Component,
		expanded: boolean,
	) {
		this.expanded = expanded;
	}

	render(width: number): string[] {
		return this.child().render(width);
	}

	invalidate(): void {
		this.cached = undefined;
	}

	handleMouse(event: MouseClickEvent): MouseHandledResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.expanded = !this.expanded;
		return { handled: true, render: true };
	}

	private child(): Component {
		if (!this.cached || this.cachedExpanded !== this.expanded) {
			this.cached = this.build(this.expanded);
			this.cachedExpanded = this.expanded;
		}
		return this.cached;
	}
}
