// Pure composition helpers for status-bar surfaces.
//
// Kept free of pi runtime and TUI imports so `index.ts` can wire them to real
// themes and tests can assert complete rendered strings. `network.ts` owns the
// state/token contract; these helpers own the surface ordering rules, including
// the rule that safe mode and the network token always share one label joined
// by exactly ` · ` even when surrounding items switch to the compact separator.

import { joinSafeModeAndNetwork } from "./network";

/**
 * Border bridge between two labels that share the bottom edge. The outer cells
 * are light/heavy half glyphs, so the line stays thin where it touches a label
 * and heavy in between:
 *
 *   `󰅟  NET? ╼━╾ 󰊚 15.9% 210k`
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

// Border-only status icons (Nerd Font). Each keeps a trailing space so the
// glyph reads as a prefix instead of touching its value. Legacy mode renders
// the plain labels and is intentionally left unchanged.
export const BORDER_SAFE_MODE_ICON = "󰕥 ";
// The network icon keeps two spaces so the token stays clearly separated from
// the glyph even when the token carries its own producer ANSI style.
export const BORDER_NETWORK_ICON = "󰅟  ";

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

/**
 * Prefix the network token with its Nerd Font icon. The icon inherits the
 * token's producer ANSI style so it reads as part of the token rather than the
 * frame border; a plain token keeps a plain icon. Exactly two spaces sit
 * between the icon and the token.
 */
function decorateBorderNetworkLabel(label: string): string {
	const color = leadingAnsiSequences(label);
	return `${color ? paintAnsi(color, BORDER_NETWORK_ICON) : BORDER_NETWORK_ICON}${label}`;
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
 * in the files group. Zero values render muted (via `mute`); nonzero values keep
 * the producer's ANSI colors. `includeLineCounts: false` drops the line group
 * for narrow frames.
 */
export function decorateBorderGitStats(
	label: string,
	options: { mute?: (text: string) => string; includeLineCounts?: boolean } = {},
): string {
	const mute = options.mute ?? ((text: string) => text);
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

	return `${filesGroup} · ${lineGroup}`;
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
 *   `0.03$ | 0.034$` -> `󰇁 0.03 Tot:󰇁 0.034`
 */
export function decorateBorderContextCost(label: string): string {
	const [current = "", total] = label.split(" | ");
	const currentLabel = `${BORDER_PRICE_ICON}${current.replace(/\$$/, "")}`;
	const totalLabel = total === undefined ? "" : ` Tot:${BORDER_PRICE_ICON}${total.replace(/\$$/, "")}`;
	return `${currentLabel}${totalLabel}`;
}

/**
 * Decorate a border-mode context/cost label with prefix icons.
 *
 *   `15.9% 210k · 0.03$`          -> `󰊚 15.9% 210k · 󰇁 0.03`
 *   `15.9% 210k · 0.03$ | 0.034$` -> `󰊚 15.9% 210k · 󰇁 0.03 Tot:󰇁 0.034`
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
export const REWIRE_ICON = "󰒍 ";

/** Format the active subagent rewire target with the status bar's exact-name aliases. */
export function formatRewireStatusLabel(
	model: string,
	thinkingLevel: string,
	providerAliases: Readonly<Record<string, string>> = {},
	modelAliases: Readonly<Record<string, string>> = {},
): string {
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

export interface BorderBottomLeftArgs {
	contextLabel?: string;
	statusLabel?: string;
	networkLabel?: string;
	borderColor: (text: string) => string;
}

/**
 * Compose the editor-frame bottom-left segment. Safe mode and the network token
 * share one label joined by exactly ` · ` (colored like the border); the context
 * label follows after the tapered border bridge:
 *
 *   `━╾ 󰕥 SMART · 󰅟  NET? ╼━╾ 󰊚 15.9% 210k · 󰇁 0.03 `
 *
 * Either producer part may be missing; both missing yields `""`.
 */
export function composeBorderBottomLeft(args: BorderBottomLeftArgs): string {
	const hasContext = hasVisibleText(args.contextLabel);
	const safeModeLabel = hasVisibleText(args.statusLabel)
		? decorateBorderSafeModeLabel(args.statusLabel, args.borderColor)
		: undefined;
	const networkLabel = hasVisibleText(args.networkLabel)
		? decorateBorderNetworkLabel(args.networkLabel)
		: undefined;
	const statusGroup = joinSafeModeAndNetwork(safeModeLabel, networkLabel, args.borderColor);
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
export function composeSafeModeNetworkGroup(args: {
	safeMode?: string;
	network?: string;
	separator: string;
}): string | undefined {
	return joinSafeModeAndNetwork(
		hasVisibleText(args.safeMode) ? sanitizeStatusText(args.safeMode) : undefined,
		hasVisibleText(args.network) ? sanitizeStatusText(args.network) : undefined,
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
	/** Already themed ` · ` used only between safe mode and the network token. */
	networkSeparator: string;
	/** Generic separator between section items (compact under crowded widths). */
	itemSeparator: string;
	safeModeId: string;
	overrides?: ReadonlyMap<string, string | undefined>;
}

/**
 * Compose the status-line left section. The safe-mode item is replaced in place
 * by the `safe · network` group (a single override), so the network token always
 * follows safe mode immediately and is never joined by the compact separator.
 */
export function composeLegacyLeftSection(args: LegacyLeftSectionArgs): string | undefined {
	const overrides = new Map<string, string | undefined>(args.overrides);
	if (hasVisibleText(args.networkLabel)) {
		overrides.set(
			args.safeModeId,
			composeSafeModeNetworkGroup({
				safeMode: args.getContent(args.safeModeId),
				network: args.networkLabel,
				separator: args.networkSeparator,
			}),
		);
	}
	return composeSectionItems(args.ids, args.getContent, args.itemSeparator, overrides);
}
