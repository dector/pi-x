export const STATUS_BAR_EVENTS = {
	set: "px:status-bar:set",
	clear: "px:status-bar:clear",
	firstLineSet: "px:status-bar:first-line:set",
	firstLineClear: "px:status-bar:first-line:clear",
	rowSet: "px:status-bar:row:set",
	rowClear: "px:status-bar:row:clear",
	ping: "px:status-bar:ping",
	pong: "px:status-bar:pong",
} as const;

export type StatusBarSection = "left" | "center" | "right";

// `new`: info lives on the editor frame border; duplicates are hidden from the
// status line. `legacy`: info lives on the status line; border labels are hidden.
export const STATUS_BAR_DISPLAY_MODES = ["new", "legacy"] as const;
export type StatusBarDisplayMode = (typeof STATUS_BAR_DISPLAY_MODES)[number];
export const DEFAULT_STATUS_BAR_DISPLAY_MODE: StatusBarDisplayMode = "new";

export interface StatusBarLayout {
	left: string[];
	center: string[];
	right: string[];
}

// Short-label aliases for the border `provider/model` label. Keys are exact
// provider ids / model ids; values are the replacement labels. Configured in
// ~/.pi/agent/status-bar.json as `providerAliases` / `modelAliases`.
export type StatusBarAliasMap = Record<string, string>;

export interface StatusBarAliasConfig {
	providerAliases: StatusBarAliasMap;
	modelAliases: StatusBarAliasMap;
}

export interface StatusBarSetPayload {
	id: string;
	content: string;
}

export interface StatusBarClearPayload {
	id: string;
}

export interface StatusBarFirstLineSetPayload {
	id: string;
	content: string;
	section?: StatusBarSection;
	priority?: number;
}

export interface StatusBarFirstLineClearPayload {
	id: string;
}

// Extra footer rows. Each registered id renders as its own line after the two
// built-in status-bar lines, sorted by `order` (ascending) then registration.
// Producers publish pre-colored content (the footer does not theme it).
export interface StatusBarRowSetPayload {
	id: string;
	content: string;
	order?: number;
}

export interface StatusBarRowClearPayload {
	id: string;
}

export interface StatusBarPingPayload {
	id: string;
}

export interface StatusBarPongPayload {
	id: string;
}

// Join rule between items inside the same section
export const STATUS_BAR_JOIN_SEPARATOR = " · " as const;

// M1 default layout (frozen contract)
// Note: context-watcher-* IDs are now produced internally by status-bar.
export const DEFAULT_STATUS_BAR_LAYOUT: StatusBarLayout = {
	left: ["safe-mode", "switch-thinking"],
	center: [],
	right: ["context-watcher-tokens", "context-watcher-model", "context-watcher-percent"],
};

// New display mode: context/model/safe-mode live on the editor frame border, so
// they are suppressed on the status line to avoid duplication. The input/output/
// cache token breakdown moves to the first line (after the skills counter) and
// drops the cost suffix, which the border already shows.
export const BORDER_PRIORITY_STATUS_BAR_LAYOUT: StatusBarLayout = {
	left: [],
	center: [],
	right: [],
};
