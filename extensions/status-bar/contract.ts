export const STATUS_BAR_EVENTS = {
	set: "status-bar:set",
	clear: "status-bar:clear",
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

// M1 join rule (frozen contract)
export const STATUS_BAR_JOIN_SEPARATOR = " | " as const;

// M1 default layout (frozen contract)
export const DEFAULT_STATUS_BAR_LAYOUT: StatusBarLayout = {
	left: ["safe-mode", "switch-thinking"],
	center: [],
	right: [],
};
