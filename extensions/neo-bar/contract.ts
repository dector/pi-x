export const STATUS_BAR_EVENTS = {
	set: "px:status-bar:set",
	clear: "px:status-bar:clear",
	firstLineSet: "px:status-bar:first-line:set",
	firstLineClear: "px:status-bar:first-line:clear",
	rewireSet: "px:status-bar:rewire:set",
	rewireClear: "px:status-bar:rewire:clear",
	subagentDepthSet: "px:status-bar:subagent-depth:set",
	subagentDepthClear: "px:status-bar:subagent-depth:clear",
	reviewLevelSet: "px:status-bar:review-level:set",
	reviewLevelClear: "px:status-bar:review-level:clear",
	rowSet: "px:status-bar:row:set",
	rowClear: "px:status-bar:row:clear",
	ping: "px:status-bar:ping",
	pong: "px:status-bar:pong",
} as const;

export type NeoBarSection = "left" | "center" | "right";

// `new`: info lives on the editor frame border; duplicates are hidden from the
// status line. `legacy`: info lives on the status line; border labels are hidden.
export const NEO_BAR_DISPLAY_MODES = ["new", "legacy"] as const;
export type NeoBarDisplayMode = (typeof NEO_BAR_DISPLAY_MODES)[number];
export const DEFAULT_NEO_BAR_DISPLAY_MODE: NeoBarDisplayMode = "new";

export interface NeoBarLayout {
	left: string[];
	center: string[];
	right: string[];
}

// Short-label aliases for the border `provider/model` label. Keys are exact
// provider ids / model ids; values are the replacement labels. Configured in
// ~/.pi/agent/status-bar.json as `providerAliases` / `modelAliases`.
export type NeoBarAliasMap = Record<string, string>;

export interface NeoBarAliasConfig {
	providerAliases: NeoBarAliasMap;
	modelAliases: NeoBarAliasMap;
}

export interface NeoBarSetPayload {
	id: string;
	content: string;
}

export interface NeoBarClearPayload {
	id: string;
}

export interface NeoBarFirstLineSetPayload {
	id: string;
	content: string;
	section?: NeoBarSection;
	priority?: number;
}

export interface NeoBarFirstLineClearPayload {
	id: string;
}

export interface NeoBarRewireSetPayload {
	model: string;
	thinkingLevel: string;
	/** The model (and only the model) is resolved from the parent when true. */
	inherit?: boolean;
	/** The parent model and thinking level are both resolved when true. */
	inheritAll?: boolean;
}

export interface NeoBarSubagentDepthSetPayload {
	depth: number;
}

export const NEO_BAR_REVIEW_LEVELS = ["auto", "off", "minimal", "normal", "high"] as const;
export type NeoBarReviewLevel = (typeof NEO_BAR_REVIEW_LEVELS)[number];

export interface NeoBarReviewLevelSetPayload {
	level: NeoBarReviewLevel;
}

// Extra footer rows. Each registered id renders as its own line after the two
// built-in neo-bar lines, sorted by `order` (ascending) then registration.
// Producers publish pre-colored content (the footer does not theme it).
export interface NeoBarRowSetPayload {
	id: string;
	content: string;
	order?: number;
}

export interface NeoBarRowClearPayload {
	id: string;
}

export interface NeoBarPingPayload {
	id: string;
}

export interface NeoBarPongPayload {
	id: string;
}

// Join rule between items inside the same section
export const NEO_BAR_JOIN_SEPARATOR = " · " as const;

// M1 default layout (frozen contract)
// Note: context-watcher-* IDs are now produced internally by neo-bar.
export const DEFAULT_NEO_BAR_LAYOUT: NeoBarLayout = {
	left: ["safe-mode", "switch-thinking"],
	center: [],
	right: ["context-watcher-tokens", "context-watcher-model", "context-watcher-percent"],
};

// New display mode: context/model/safe-mode live on the editor frame border, so
// they are suppressed on the status line to avoid duplication. The input/output/
// cache token breakdown moves to the first line (after the skills counter) and
// drops the cost suffix, which the border already shows.
export const BORDER_PRIORITY_NEO_BAR_LAYOUT: NeoBarLayout = {
	left: [],
	center: [],
	right: [],
};

// --- Back-compat aliases -----------------------------------------------------
// The extension was renamed from `status-bar` to `neo-bar`, but the wire contract
// is unchanged: every `px:status-bar:*` event name and the `STATUS_BAR_EVENTS`
// map keep their old names, as does the `~/.pi/agent/status-bar.json` config
// file. These aliases exist so out-of-repo consumers that import the old symbol
// names keep compiling. Nothing inside this repo uses them; delete them once the
// deprecated names stop appearing in downstream code.

/** @deprecated Renamed to {@link NeoBarSection}. */
export type StatusBarSection = NeoBarSection;
/** @deprecated Renamed to {@link NeoBarDisplayMode}. */
export type StatusBarDisplayMode = NeoBarDisplayMode;
/** @deprecated Renamed to {@link NeoBarLayout}. */
export type StatusBarLayout = NeoBarLayout;
/** @deprecated Renamed to {@link NeoBarAliasMap}. */
export type StatusBarAliasMap = NeoBarAliasMap;
/** @deprecated Renamed to {@link NeoBarAliasConfig}. */
export type StatusBarAliasConfig = NeoBarAliasConfig;
/** @deprecated Renamed to {@link NeoBarSetPayload}. */
export type StatusBarSetPayload = NeoBarSetPayload;
/** @deprecated Renamed to {@link NeoBarClearPayload}. */
export type StatusBarClearPayload = NeoBarClearPayload;
/** @deprecated Renamed to {@link NeoBarFirstLineSetPayload}. */
export type StatusBarFirstLineSetPayload = NeoBarFirstLineSetPayload;
/** @deprecated Renamed to {@link NeoBarFirstLineClearPayload}. */
export type StatusBarFirstLineClearPayload = NeoBarFirstLineClearPayload;
/** @deprecated Renamed to {@link NeoBarRewireSetPayload}. */
export type StatusBarRewireSetPayload = NeoBarRewireSetPayload;
/** @deprecated Renamed to {@link NeoBarSubagentDepthSetPayload}. */
export type StatusBarSubagentDepthSetPayload = NeoBarSubagentDepthSetPayload;
/** @deprecated Renamed to {@link NeoBarReviewLevel}. */
export type StatusBarReviewLevel = NeoBarReviewLevel;
/** @deprecated Renamed to {@link NeoBarReviewLevelSetPayload}. */
export type StatusBarReviewLevelSetPayload = NeoBarReviewLevelSetPayload;
/** @deprecated Renamed to {@link NeoBarRowSetPayload}. */
export type StatusBarRowSetPayload = NeoBarRowSetPayload;
/** @deprecated Renamed to {@link NeoBarRowClearPayload}. */
export type StatusBarRowClearPayload = NeoBarRowClearPayload;
/** @deprecated Renamed to {@link NeoBarPingPayload}. */
export type StatusBarPingPayload = NeoBarPingPayload;
/** @deprecated Renamed to {@link NeoBarPongPayload}. */
export type StatusBarPongPayload = NeoBarPongPayload;

/** @deprecated Renamed to {@link NEO_BAR_DISPLAY_MODES}. */
export { NEO_BAR_DISPLAY_MODES as STATUS_BAR_DISPLAY_MODES };
/** @deprecated Renamed to {@link DEFAULT_NEO_BAR_DISPLAY_MODE}. */
export { DEFAULT_NEO_BAR_DISPLAY_MODE as DEFAULT_STATUS_BAR_DISPLAY_MODE };
/** @deprecated Renamed to {@link NEO_BAR_REVIEW_LEVELS}. */
export { NEO_BAR_REVIEW_LEVELS as STATUS_BAR_REVIEW_LEVELS };
/** @deprecated Renamed to {@link NEO_BAR_JOIN_SEPARATOR}. */
export { NEO_BAR_JOIN_SEPARATOR as STATUS_BAR_JOIN_SEPARATOR };
/** @deprecated Renamed to {@link DEFAULT_NEO_BAR_LAYOUT}. */
export { DEFAULT_NEO_BAR_LAYOUT as DEFAULT_STATUS_BAR_LAYOUT };
/** @deprecated Renamed to {@link BORDER_PRIORITY_NEO_BAR_LAYOUT}. */
export { BORDER_PRIORITY_NEO_BAR_LAYOUT as BORDER_PRIORITY_STATUS_BAR_LAYOUT };
