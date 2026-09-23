/**
 * Subagent panel integration.
 *
 * The subagent widget is one panel in the shared `px:panels:*` coordinator. The
 * coordinator owns `Alt+P` and broadcasts which panel is active; this module
 * turns that broadcast into the widget's collapsed/expanded state.
 *
 * The floating Watch overlay needs the widget out of the way while it is open.
 * That is modelled as a separate `watchSuppress` flag rather than a snapshot of
 * the previous state, so a cycle change made while Watch is open survives the
 * restore. Restoring only clears the flag and re-derives the collapsed state
 * from the current active panel.
 *
 * The decision function is pure so the collapse rules are unit-tested without a
 * TUI or event bus.
 */
import {
	PANELS_ACTIVE_EVENT,
	PANELS_CONTENT_EVENT,
	PANELS_REGISTER_EVENT,
	PANELS_VISIBILITY_EVENT,
	parsePanelActive,
	type PanelActive,
	type PanelContent,
} from "../panels/contract.ts";

export {
	PANELS_ACTIVE_EVENT,
	PANELS_CONTENT_EVENT,
	PANELS_REGISTER_EVENT,
	PANELS_VISIBILITY_EVENT,
	parsePanelActive,
	type PanelActive,
	type PanelContent,
};

/** Stable panel id shared with the coordinator and the proc worker contract. */
export const SUBAGENT_PANEL_ID = "subagents";
export const SUBAGENT_PANEL_LABEL = "Subagents";
export const SUBAGENT_PANEL_ORDER = 10;

/**
 * Effective collapsed state for the active-subagents widget.
 *
 * The widget starts collapsed, so anything other than its own panel id keeps it
 * collapsed. That includes `null` (all panels collapsed) and `undefined` (no
 * coordinator has broadcast yet, for example when only the subagent extension
 * is loaded). The panel never auto-expands; only a broadcast that selects
 * `subagents` expands it.
 */
export function isSubagentPanelCollapsed(
	activeId: string | null | undefined,
	watchSuppress: boolean,
): boolean {
	if (watchSuppress) return true;
	return activeId !== SUBAGENT_PANEL_ID;
}

/**
 * Small state holder that applies the effective collapsed state to the widget
 * and de-duplicates the visibility announcements sent to the coordinator.
 */
export class SubagentPanelBridge {
	private activeId: string | null = null;
	private watchSuppress = false;
	private lastVisible: boolean | undefined;

	constructor(private readonly applyCollapsed: (collapsed: boolean) => void) {}

	get collapsed(): boolean {
		return isSubagentPanelCollapsed(this.activeId, this.watchSuppress);
	}

	/** Apply an `px:panels:active` broadcast. */
	handleActive(activeId: string | null): void {
		this.activeId = activeId;
		this.applyCollapsed(this.collapsed);
	}

	/** Force the widget collapsed while the Watch overlay is open. */
	setWatchSuppress(suppress: boolean): void {
		if (this.watchSuppress === suppress) return;
		this.watchSuppress = suppress;
		this.applyCollapsed(this.collapsed);
	}

	/**
	 * Record the panel's content visibility. Returns true only when it changed,
	 * so the caller can emit `px:panels:visibility` without spamming the bus.
	 */
	noteVisibility(visible: boolean): boolean {
		if (this.lastVisible === visible) return false;
		this.lastVisible = visible;
		return true;
	}

	/** Forget all panel state, for example on shutdown. */
	reset(): void {
		this.activeId = null;
		this.watchSuppress = false;
		this.lastVisible = undefined;
	}
}
