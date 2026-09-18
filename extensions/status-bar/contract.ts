export const STATUS_BAR_EVENTS = {
	set: "status-bar:set",
	clear: "status-bar:clear",
	firstLineSet: "status-bar:first-line:set",
	firstLineClear: "status-bar:first-line:clear",
	ping: "status-bar:ping",
	pong: "status-bar:pong",
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
