export const STATUS_BAR_EVENTS = {
	set: "status-bar:set",
	clear: "status-bar:clear",
	firstLineSet: "status-bar:first-line:set",
	firstLineClear: "status-bar:first-line:clear",
} as const;

export type StatusBarSection = "left" | "center" | "right";

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

// Join rule between items inside the same section
export const STATUS_BAR_JOIN_SEPARATOR = " · " as const;

// M1 default layout (frozen contract)
// Note: context-watcher-* IDs are now produced internally by status-bar.
export const DEFAULT_STATUS_BAR_LAYOUT: StatusBarLayout = {
	left: ["safe-mode", "switch-thinking"],
	center: [],
	right: ["context-watcher-tokens", "context-watcher-model", "context-watcher-percent"],
};
