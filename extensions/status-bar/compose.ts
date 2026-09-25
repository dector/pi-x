// Pure composition helpers for status-bar surfaces.
//
// Kept free of pi runtime and TUI imports so `index.ts` can wire them to real
// themes and tests can assert complete rendered strings. `network.ts` owns the
// state/token contract; these helpers own the surface ordering rules, including
// the rule that policy indicators share one label joined by exactly ` · ` even
// when surrounding items switch to the compact separator.

/**
 * Border bridge between two labels that share the bottom edge. The outer cells
 * are light/heavy half glyphs, so the line stays thin where it touches a label
 * and heavy in between:
 *
 *   `󰅟 ✓? ╼━╾ 󰊚 15.9% 210k`
 */
export const FRAME_LABEL_JOIN = "╼━╾";
export const FRAME_LABEL_OPEN = " ";
export const FRAME_LABEL_CLOSE = " ";
/**
 * Corner-adjacent bridges. The frame line is heavy, but the half that touches a
 * label is light: `╰━╾ <label>` and `<label> ╼━╮`.
 */
export const FRAME_LEFT_CORNER_OPEN = "━╾ ";
export const FRAME_RIGHT_CORNER_CLOSE = " ╼━";

export function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").trim();
}

/** Append the review icon after model effort with a frame-colored separator. */
export function composeTopLeftModelReview(
	modelLabel: string,
	reviewLabel: string | undefined,
	borderColor: (text: string) => string,
): string {
	return hasVisibleText(reviewLabel) ? `${modelLabel}${borderColor(` · ${reviewLabel}`)}` : modelLabel;
}

// Border-only status icons (Nerd Font). Each keeps a trailing space so the
// glyph reads as a prefix instead of touching its value. Legacy mode renders
// the plain labels and is intentionally left unchanged.
export const BORDER_SAFE_MODE_ICON = "󰕥 ";
// One space separates each policy/depth prefix glyph from its value.
export const BORDER_NETWORK_ICON = "󰅟 ";
export const BORDER_SUBAGENT_ICON = "󰚩 ";

const BORDER_GIT_MARKER_ICONS = {
	additions: "󰐖",
	removals: "󰍵",
	modified: "󰦓",
} as const;

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsiSequences(text: string): string {
	return text.replace(ANSI_ESCAPE_PATTERN, "");
}

/** First ANSI SGR sequence in a chunk, used as the producer color for a value. */
function firstAnsiSequence(text: string): string {
	const match = text.match(/\u001b\[[0-9;]*m/);
	return match ? match[0] : "";
}

/** Leading ANSI SGR sequences of a label, i.e. its producer style prefix. */
function leadingAnsiSequences(text: string): string {
	const match = text.match(/^(?:\u001b\[[0-9;]*m)+/);
	return match ? match[0] : "";
}

/** Wrap text in an ANSI color and reset, or leave it untouched when unstyled. */
function paintAnsi(color: string, text: string): string {
	return color ? `${color}${text}\u001b[0m` : text;
}

/** Prefix the network value and give the whole compact indicator one color. */
function decorateBorderNetworkLabel(label: string, accentColor: (text: string) => string): string {
	const sanitized = sanitizeStatusText(label);
	const producerColor = leadingAnsiSequences(sanitized);
	return producerColor
		? `${paintAnsi(producerColor, BORDER_NETWORK_ICON)}${sanitized}`
		: accentColor(`${BORDER_NETWORK_ICON}${sanitized}`);
}

/** Give the compact subagent depth indicator one state-dependent color. */
function decorateBorderSubagentLabel(label: string, accentColor: (text: string) => string): string {
	const sanitized = sanitizeStatusText(label);
	const valueWithSpacing = sanitized.replace(BORDER_SUBAGENT_ICON, "");
	const valueStyle = leadingAnsiSequences(valueWithSpacing);
	const value = `${valueStyle}${valueWithSpacing.slice(valueStyle.length).replace(/^ +/, "")}`;
	if (stripAnsi(value) === "✓") return accentColor(`${BORDER_SUBAGENT_ICON}✓`);
	const producerColor = leadingAnsiSequences(sanitized);
	return producerColor
		? `${paintAnsi(producerColor, BORDER_SUBAGENT_ICON)}${value}`
		: accentColor(`${BORDER_SUBAGENT_ICON}${value}`);
}

/** Read `+N`/`-N`/`MN` from a git stats chunk; `undefined` when it does not match. */
function readGitCount(chunk: string | undefined, marker: string): number | undefined {
	if (!chunk) return undefined;
	const plain = stripAnsiSequences(chunk);
	if (!plain.startsWith(marker)) return undefined;
	const value = Number.parseInt(plain.slice(marker.length), 10);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * Restyle the repo-stats label for the editor border as two explicit groups,
 * files first then changed lines, separated by ` · `:
 *
 *   `+1 -2 M4 · +150 -200` -> `󰐖 1 󰍵 2 󰦓 4 · 󰐖 150 󰍵 200`
 *
 * Both groups reuse the addition/removal icons; the modified count only exists
 * in the files group. Zero values use the caller's subdued color (via `mute`);
 * nonzero values keep the producer's ANSI colors. `separator` colors the group
 * divider (defaults to uncolored). `includeLineCounts: false` drops the line
 * group for narrow frames.
 */
export function decorateBorderGitStats(
	label: string,
	options: {
		mute?: (text: string) => string;
		separator?: (text: string) => string;
		includeLineCounts?: boolean;
	} = {},
): string {
	const mute = options.mute ?? ((text: string) => text);
	const separator = options.separator ?? ((text: string) => text);
	const includeLineCounts = options.includeLineCounts ?? true;

	const separatorIndex = label.indexOf("·");
	const filePart = separatorIndex === -1 ? label : label.slice(0, separatorIndex);
	const linePart = separatorIndex === -1 ? undefined : label.slice(separatorIndex + 1);
	const fileChunks = filePart.trim().split(/\s+/).filter(Boolean);
	const hasLineGroup = linePart !== undefined && linePart.trim().length > 0;
	const lineChunks = hasLineGroup ? linePart.trim().split(/\s+/).filter(Boolean) : [];

	const fileAdd = fileChunks.find((chunk) => stripAnsiSequences(chunk).startsWith("+"));
	const fileRemove = fileChunks.find((chunk) => stripAnsiSequences(chunk).startsWith("-"));
	const fileModified = fileChunks.find((chunk) => stripAnsiSequences(chunk).startsWith("M"));
	const lineAdd = lineChunks.find((chunk) => stripAnsiSequences(chunk).startsWith("+"));
	const lineRemove = lineChunks.find((chunk) => stripAnsiSequences(chunk).startsWith("-"));

	const renderItem = (icon: string, count: number, color: string): string => {
		const item = `${icon} ${count}`;
		return count === 0 ? mute(item) : paintAnsi(color, item);
	};

	const filesGroup = [
		renderItem(
			BORDER_GIT_MARKER_ICONS.additions,
			readGitCount(fileAdd, "+") ?? 0,
			firstAnsiSequence(fileAdd ?? ""),
		),
		renderItem(
			BORDER_GIT_MARKER_ICONS.removals,
			readGitCount(fileRemove, "-") ?? 0,
			firstAnsiSequence(fileRemove ?? ""),
		),
		renderItem(
			BORDER_GIT_MARKER_ICONS.modified,
			readGitCount(fileModified, "M") ?? 0,
			firstAnsiSequence(fileModified ?? ""),
		),
	].join(" ");

	if (!includeLineCounts || !hasLineGroup) return filesGroup;

	const lineGroup = [
		renderItem(BORDER_GIT_MARKER_ICONS.additions, readGitCount(lineAdd, "+") ?? 0, firstAnsiSequence(lineAdd ?? "")),
		renderItem(BORDER_GIT_MARKER_ICONS.removals, readGitCount(lineRemove, "-") ?? 0, firstAnsiSequence(lineRemove ?? "")),
	].join(" ");

	return `${filesGroup}${separator(" · ")}${lineGroup}`;
}

// Border-only context/cost icons (Nerd Font). Each keeps a trailing space so the
// glyph reads as a prefix. The final/total price doubles the price icon to
// distinguish it from the current/session price. Legacy mode keeps the `$`
// suffixes and `|` separator and is intentionally left unchanged.
export const BORDER_CONTEXT_ICON = "󰊚 ";
export const BORDER_PRICE_ICON = "󰇁 ";

/**
 * Decorate a border-mode cost label with prefix icons.
 *
 *   `0.03$`          -> `󰇁 0.03`
 *   `0.03$ | 0.034$` -> `󰇁 0.03 Tot󰇁 0.034`
 */
export function decorateBorderContextCost(label: string): string {
	const [current = "", total] = label.split(" | ");
	const currentLabel = `${BORDER_PRICE_ICON}${current.replace(/\$$/, "")}`;
	const totalLabel = total === undefined ? "" : ` Tot${BORDER_PRICE_ICON}${total.replace(/\$$/, "")}`;
	return `${currentLabel}${totalLabel}`;
}

/**
 * Decorate a border-mode context/cost label with prefix icons.
 *
 *   `15.9% 210k · 0.03$`          -> `󰊚 15.9% 210k · 󰇁 0.03`
 *   `15.9% 210k · 0.03$ | 0.034$` -> `󰊚 15.9% 210k · 󰇁 0.03 Tot󰇁 0.034`
 */
export function decorateBorderContextLabel(label: string): string {
	const separator = " · ";
	const at = label.indexOf(separator);
	if (at === -1) return `${BORDER_CONTEXT_ICON}${label}`;
	const context = label.slice(0, at);
	const cost = label.slice(at + separator.length);
	return `${BORDER_CONTEXT_ICON}${context}${separator}${decorateBorderContextCost(cost)}`;
}

export function stripAnsi(text: string): string {
	return text.replace(/\u001B\[[0-9;]*m/g, "");
}

export function hasVisibleText(value?: string): value is string {
	if (typeof value !== "string") return false;
	return value.trim().length > 0;
}

// Border-only first-line icons (Nerd Font). Each keeps a trailing space so the
// glyph reads as a prefix. Legacy mode keeps the plain cwd/branch and the
// unadorned token breakdown.
export const BORDER_BRANCH_ICON = "\ueafe ";
export const BORDER_TOTAL_USAGE_ICON = "\u{000f04e1} ";
export const REWIRE_ICON = "󰚩 󰒟 ";

/** Format the active subagent rewire target with the status bar's exact-name aliases. */
export function formatRewireStatusLabel(
	model: string,
	thinkingLevel: string,
	providerAliases: Readonly<Record<string, string>> = {},
	modelAliases: Readonly<Record<string, string>> = {},
	inherit = false,
	inheritAll = false,
): string {
	if (inheritAll) return `${REWIRE_ICON}Inherit`;
	if (inherit) return `${REWIRE_ICON}Inherit · ${thinkingLevel}`;
	const separator = model.indexOf("/");
	const provider = separator === -1 ? undefined : model.slice(0, separator);
	const modelId = separator === -1 ? model : model.slice(separator + 1);
	const modelLabel = modelAliases[modelId] ?? modelId;
	const providerLabel = provider ? (providerAliases[provider] ?? provider) : undefined;
	const target = providerLabel ? `${providerLabel}/${modelLabel}` : modelLabel;
	return `${REWIRE_ICON}${target} · ${thinkingLevel}`;
}

/** Append the git branch to the cwd path with the border-mode branch icon. */
export function decorateBorderPathBranch(args: { path: string; branch?: string }): string {
	return hasVisibleText(args.branch) ? `${args.path} (${BORDER_BRANCH_ICON}${args.branch})` : args.path;
}

/** Prefix the first-line token usage breakdown with the total-usage icon. */
export function decorateBorderTotalUsage(label: string): string {
	return `${BORDER_TOTAL_USAGE_ICON}${label}`;
}

// Border-only unsent-message icon (Nerd Font). Keeps a trailing space so the
// glyph reads as a prefix, matching the other border indicators.
export const BORDER_MESSAGE_ICON = "󰍡 ";

// Pi estimates tokens with a conservative chars/4 heuristic (`estimateTokens`).
// The interactive editor carries text only (a pasted image is inserted as its
// file path and attached later by the agent), so the same heuristic applies.
export const MESSAGE_CHARS_PER_TOKEN = 4;

/**
 * Estimate the token size of unsent editor text with pi's chars/4 heuristic.
 * Whitespace-only input is empty because pi trims submitted text.
 */
export function estimateMessageTokens(text: string): number {
	const trimmed = text.trim();
	if (trimmed.length === 0) return 0;
	return Math.ceil(trimmed.length / MESSAGE_CHARS_PER_TOKEN);
}

/**
 * Drop the decorative spaces from a border label so it fits narrow frames.
 * Only ASCII spaces are touched; ANSI color codes never contain one, so the
 * colored segments survive: `󰐖 1 󰍵 2 󰦓 4 · 󰐖 150 󰍵 200` -> `󰐖1󰍵2󰦓4·󰐖150󰍵200`.
 */
export function compactFrameLabel(label: string): string {
	return label.replace(/ /g, "");
}

/**
 * Choose top-border segments in caller-provided preference order. Left variants
 * have priority: when no pair fits, keep the model and drop git statistics.
 */
export function chooseTopBorderSegments(args: {
	width: number;
	leftSegments: readonly string[];
	rightSegments: readonly string[];
	minimumGap: number;
	visibleWidth: (text: string) => number;
}): { left: string; right: string } {
	const uniqueVisible = (segments: readonly string[]) =>
		segments.filter((segment, index) => hasVisibleText(segment) && segments.indexOf(segment) === index);
	const leftSegments = uniqueVisible(args.leftSegments);
	const rightSegments = uniqueVisible(args.rightSegments);
	const fitsAlone = (segment: string) => args.visibleWidth(segment) + args.minimumGap <= args.width;

	for (const left of leftSegments) {
		for (const right of rightSegments) {
			if (args.visibleWidth(left) + args.visibleWidth(right) + args.minimumGap <= args.width) {
				return { left, right };
			}
		}
	}
	for (const left of leftSegments) {
		if (fitsAlone(left)) return { left, right: "" };
	}
	for (const right of rightSegments) {
		if (fitsAlone(right)) return { left: "", right };
	}
	return { left: "", right: "" };
}

/** `SMART` is recolored to the frame border; other safe-mode labels keep the producer color. */
export function styleSafeModeLabel(label: string, borderColor: (text: string) => string): string {
	const plain = stripAnsi(sanitizeStatusText(label));
	if (/^SMART\+?$/.test(plain)) return borderColor(plain);
	return sanitizeStatusText(label);
}

/**
 * Prefix the safe-mode token with its Nerd Font icon so the glyph carries the
 * same color/style as the text it prefixes. `SMART`/`SMART+` are recolored to
 * the frame border, so the icon matches; any other mode keeps the producer's
 * ANSI style on both the icon and the text instead of reading as frame border.
 */
export function decorateBorderSafeModeLabel(
	label: string,
	borderColor: (text: string) => string,
): string {
	const plain = stripAnsi(sanitizeStatusText(label));
	const icon = /^SMART\+?$/.test(plain)
		? borderColor(BORDER_SAFE_MODE_ICON)
		: paintAnsi(leadingAnsiSequences(label), BORDER_SAFE_MODE_ICON);
	return `${icon}${styleSafeModeLabel(label, borderColor)}`;
}

// Explicit status-pill palette. The + variants keep their base mode's color.
const SAFE_MODE_PILL_COLORS: Record<string, { bg: string; fg: string }> = {
	SMART: { bg: "#554075", fg: "#dbc8f4" },
	PARANOID: { bg: "#284d80", fg: "#c1d9ff" },
	READER: { bg: "#215d39", fg: "#bce4c5" },
	YOLO: { bg: "#d70000", fg: "#ffe0e0" },
	"󰕥": { bg: "88", fg: "#d38f8f" },
};

/** Render a rounded badge; colors are #rrggbb or an ANSI-256 index (for the shield's red). */
export function renderStatusPill(text: string, bg: string, fg: string): string {
	const rgb = (hex: string): string => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(";");
	const color = (hexOrIndex: string, channel: 38 | 48): string =>
		/^\d+$/.test(hexOrIndex) ? `${channel};5;${hexOrIndex}` : `${channel};2;${rgb(hexOrIndex)}`;
	const cap = (glyph: string): string => `\x1b[${color(bg, 38)}m${glyph}\x1b[0m`;
	return `${cap("")}\x1b[${color(bg, 48)};${color(fg, 38)}m${text}\x1b[0m${cap("")}`;
}

export interface BorderBottomLeftArgs {
	contextLabel?: string;
	statusLabel?: string;
	networkLabel?: string;
	subagentLabel?: string;
	borderColor: (text: string) => string;
	/** Subdued color for default-color indicators; defaults to `borderColor`. */
	accentColor?: (text: string) => string;
}

/**
 * Compose the editor-frame bottom-left segment. Safe mode and the network token
 * share one label joined by exactly ` · ` (border-colored, except neutral
 * network and top-level subagent depth, which use `accentColor`); the context
 * label follows after the tapered border bridge:
 *
 *   `━╾ 󰕥 SMART · 󰅟 ✓? · 󰚩 ✓ ╼━╾ 󰊚 15.9% 210k · 󰇁 0.03 `
 *
 * Either producer part may be missing; both missing yields `""`.
 */
export function composeBorderBottomLeft(args: BorderBottomLeftArgs): string {
	const accentColor = args.accentColor ?? args.borderColor;
	const hasContext = hasVisibleText(args.contextLabel);
	const mode = args.statusLabel ? stripAnsi(sanitizeStatusText(args.statusLabel)) : "";
	const baseMode = mode.replace(/\+$/, "");
	const pillColors = Object.hasOwn(SAFE_MODE_PILL_COLORS, baseMode) ? SAFE_MODE_PILL_COLORS[baseMode] : undefined;
	const safeModeLabel = pillColors
		? renderStatusPill(mode === "󰕥" ? mode : `${BORDER_SAFE_MODE_ICON}${mode}`, pillColors.bg, pillColors.fg)
		: hasVisibleText(args.statusLabel)
			? decorateBorderSafeModeLabel(args.statusLabel, args.borderColor)
			: undefined;
	const networkLabel = hasVisibleText(args.networkLabel)
		? decorateBorderNetworkLabel(args.networkLabel, accentColor)
		: undefined;
	const subagentLabel = hasVisibleText(args.subagentLabel)
		? decorateBorderSubagentLabel(args.subagentLabel, accentColor)
		: undefined;
	const statusGroup = joinStatusPolicyGroup(safeModeLabel, networkLabel, subagentLabel, args.borderColor);
	if (!hasContext && !statusGroup) return "";

	const open = args.borderColor(FRAME_LEFT_CORNER_OPEN);
	const close = args.borderColor(FRAME_LABEL_CLOSE);

	if (statusGroup && hasContext) {
		const join = args.borderColor(` ${FRAME_LABEL_JOIN} `);
		return `${open}${statusGroup}${join}${sanitizeStatusText(args.contextLabel!)}${close}`;
	}
	if (statusGroup) return `${open}${statusGroup}${close}`;
	return `${open}${sanitizeStatusText(args.contextLabel!)}${close}`;
}

/**
 * Compose the status-line safe-mode/network group as a single section item.
 * `separator` is already themed (for example `theme.fg("muted", " · ")`), so the
 * group keeps the spaced dot even when surrounding items use a compact join.
 */
function joinStatusPolicyGroup(
	safeMode: string | undefined,
	network: string | undefined,
	subagent: string | undefined,
	separator: (text: string) => string,
): string | undefined {
	let group: string | undefined;
	for (const item of [safeMode, network, subagent]) {
		if (!item) continue;
		group = group ? `${group}${separator(" · ")}${item}` : item;
	}
	return group;
}

export function composeSafeModeNetworkGroup(args: {
	safeMode?: string;
	network?: string;
	subagent?: string;
	separator: string;
}): string | undefined {
	return joinStatusPolicyGroup(
		hasVisibleText(args.safeMode) ? sanitizeStatusText(args.safeMode) : undefined,
		hasVisibleText(args.network) ? sanitizeStatusText(args.network) : undefined,
		hasVisibleText(args.subagent) ? sanitizeStatusText(args.subagent) : undefined,
		() => args.separator,
	);
}

/** Resolve and join the non-empty items of one section in layout order. */
export function composeSectionItems(
	ids: readonly string[],
	getContent: (id: string) => string | undefined,
	joinSeparator: string,
	overrides?: ReadonlyMap<string, string | undefined>,
): string | undefined {
	const items: string[] = [];
	for (const id of ids) {
		const value = overrides?.has(id) ? overrides.get(id) : getContent(id);
		if (hasVisibleText(value)) items.push(sanitizeStatusText(value));
	}
	if (items.length === 0) return undefined;
	return items.join(joinSeparator);
}

export interface LegacyLeftSectionArgs {
	ids: readonly string[];
	getContent: (id: string) => string | undefined;
	networkLabel?: string;
	subagentLabel?: string;
	/** Already themed ` · ` used inside the policy-indicator group. */
	networkSeparator: string;
	/** Generic separator between section items (compact under crowded widths). */
	itemSeparator: string;
	safeModeId: string;
	overrides?: ReadonlyMap<string, string | undefined>;
}

/**
 * Compose the status-line left section. The safe-mode item is replaced in place
 * by the `safe · network · subagent` group (a single override), so its internal
 * separators never collapse under compact layout.
 */
export function composeLegacyLeftSection(args: LegacyLeftSectionArgs): string | undefined {
	const overrides = new Map<string, string | undefined>(args.overrides);
	if (hasVisibleText(args.networkLabel) || hasVisibleText(args.subagentLabel)) {
		overrides.set(
			args.safeModeId,
			composeSafeModeNetworkGroup({
				safeMode: args.getContent(args.safeModeId),
				network: args.networkLabel,
				subagent: args.subagentLabel,
				separator: args.networkSeparator,
			}),
		);
	}
	return composeSectionItems(args.ids, args.getContent, args.itemSeparator, overrides);
}
