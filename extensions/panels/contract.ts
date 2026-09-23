/**
 * Panel coordinator event contract.
 *
 * Panels are independent extensions (or extensions with several surfaces) that
 * own their own widget/overlay rendering. They announce themselves to the
 * coordinator over the shared `pi.events` bus and never touch the coordinator's
 * state directly. The coordinator is the single owner of the panel cycle
 * shortcut (`Alt+P`) so two panels can never fight over the same key.
 *
 * Channels:
 * - `px:panels:register`   panel -> coordinator: announce/update a panel.
 * - `px:panels:visibility` panel -> coordinator: the panel appeared/disappeared.
 * - `px:panels:content`    panel -> coordinator: publish formatted lines + width renderer.
 * - `px:panels:sync`       panel -> coordinator: re-broadcast the active panel.
 * - `px:panels:active`     coordinator -> panels: the active panel changed.
 *
 * The coordinator is the single owner of the above-editor widget (`px-panels`).
 * Panels never call `ctx.ui.setWidget` themselves; they publish their formatted
 * lines on `px:panels:content` and the coordinator stacks every panel in fixed
 * order into one component. This keeps panel order stable across refreshes and
 * keeps cycling flicker-free (the widget is mounted once, not remounted).
 *
 * `visible` means "the panel currently has something to show". A panel that is
 * not visible is skipped by the cycle. Every panel starts collapsed; only an
 * explicit cycle key selects one.
 */

/** A panel announces or refreshes its registration. */
export const PANELS_REGISTER_EVENT = "px:panels:register";
/** A panel reports that it appeared (`visible: true`) or disappeared (`false`). */
export const PANELS_VISIBILITY_EVENT = "px:panels:visibility";
/** A panel publishes its formatted content and width renderer. */
export const PANELS_CONTENT_EVENT = "px:panels:content";
/** A panel asks the coordinator to re-broadcast the active panel. */
export const PANELS_SYNC_EVENT = "px:panels:sync";
/** The coordinator reports the currently active panel, or `null` for all collapsed. */
export const PANELS_ACTIVE_EVENT = "px:panels:active";

export interface PanelRegistration {
	/** Stable unique id, for example `subagents` or `processes`. */
	id: string;
	/** Human-readable label used in notifications. */
	label: string;
	/** Fixed cycle position; lower comes first. */
	order: number;
	/** Whether the panel currently has content to show. */
	visible: boolean;
}

export interface PanelVisibility {
	id: string;
	visible: boolean;
}

/**
 * A panel's formatted lines plus the width-aware renderer for those lines.
 *
 * `content` is `undefined` (or empty) when the panel has nothing to show. The
 * coordinator caches the last payload per id and calls `render` at draw time
 * with the terminal width. Keeping the renderer on the payload lets each panel
 * keep its own wrapping/inset logic without the coordinator knowing about it.
 */
export interface PanelContent {
	id: string;
	content: string[] | undefined;
	render: (content: readonly string[], width: number) => string[];
}

export interface PanelActive {
	activeId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Validate an untrusted `px:panels:register` payload. */
export function parsePanelRegistration(payload: unknown): PanelRegistration | undefined {
	if (!isRecord(payload)) return undefined;
	if (typeof payload.id !== "string" || payload.id.length === 0) return undefined;
	if (typeof payload.label !== "string") return undefined;
	if (typeof payload.order !== "number" || !Number.isFinite(payload.order)) return undefined;
	if (typeof payload.visible !== "boolean") return undefined;
	return {
		id: payload.id,
		label: payload.label,
		order: payload.order,
		visible: payload.visible,
	};
}

/** Validate an untrusted `px:panels:visibility` payload. */
export function parsePanelVisibility(payload: unknown): PanelVisibility | undefined {
	if (!isRecord(payload)) return undefined;
	if (typeof payload.id !== "string" || payload.id.length === 0) return undefined;
	if (typeof payload.visible !== "boolean") return undefined;
	return { id: payload.id, visible: payload.visible };
}

/** Validate an untrusted `px:panels:content` payload. */
export function parsePanelContent(payload: unknown): PanelContent | undefined {
	if (!isRecord(payload)) return undefined;
	if (typeof payload.id !== "string" || payload.id.length === 0) return undefined;
	if (typeof payload.render !== "function") return undefined;
	const content = payload.content;
	if (content !== undefined) {
		if (!Array.isArray(content) || content.some((line) => typeof line !== "string")) return undefined;
	}
	return {
		id: payload.id,
		content: content as string[] | undefined,
		render: payload.render as PanelContent["render"],
	};
}

/** Validate an untrusted `px:panels:active` payload. */
export function parsePanelActive(payload: unknown): PanelActive | undefined {
	if (!isRecord(payload)) return undefined;
	const activeId = payload.activeId;
	if (activeId === null) return { activeId: null };
	if (typeof activeId === "string") return { activeId };
	return undefined;
}
