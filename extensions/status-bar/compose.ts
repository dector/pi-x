// Pure composition helpers for status-bar surfaces.
//
// Kept free of pi runtime and TUI imports so `index.ts` can wire them to real
// themes and tests can assert complete rendered strings. `network.ts` owns the
// state/token contract; these helpers own the surface ordering rules, including
// the rule that safe mode and the network token always share one label joined
// by exactly ` · ` even when surrounding items switch to the compact separator.

import { joinSafeModeAndNetwork } from "./network";

/** Join two labels on the same border edge: the two tacks with a vertically centered dot. */
export const FRAME_LABEL_JOIN = "-·-";

export function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").trim();
}

export function stripAnsi(text: string): string {
	return text.replace(/\u001B\[[0-9;]*m/g, "");
}

export function hasVisibleText(value?: string): value is string {
	if (typeof value !== "string") return false;
	return value.trim().length > 0;
}

/**
 * Drop the decorative spaces from a border label so it fits narrow frames.
 * Only ASCII spaces are touched; ANSI color codes never contain one, so the
 * colored segments survive: `+1 -2 M4 · +150 -200` -> `+1-2M4·+150-200`.
 */
export function compactFrameLabel(label: string): string {
	return label.replace(/ /g, "");
}

/** `SMART` is recolored to the frame border; other safe-mode labels keep the producer color. */
export function styleSafeModeLabel(label: string, borderColor: (text: string) => string): string {
	const plain = stripAnsi(sanitizeStatusText(label));
	if (/^SMART\+?$/.test(plain)) return borderColor(plain);
	return sanitizeStatusText(label);
}

export interface BorderBottomLeftArgs {
	contextLabel?: string;
	statusLabel?: string;
	networkLabel?: string;
	borderColor: (text: string) => string;
}

/**
 * Compose the editor-frame bottom-left segment. Safe mode and the network token
 * share one `-< ... >-` label joined by exactly ` · ` (colored like the border);
 * the context label follows in its own tacks joined by the standard bridge:
 *
 *   `-< SMART · NET? >-·-< 15.9% 210k · 0.03$ >-`
 *
 * Either producer part may be missing; both missing yields `""`.
 */
export function composeBorderBottomLeft(args: BorderBottomLeftArgs): string {
	const hasContext = hasVisibleText(args.contextLabel);
	const statusGroup = joinSafeModeAndNetwork(
		hasVisibleText(args.statusLabel) ? styleSafeModeLabel(args.statusLabel, args.borderColor) : undefined,
		hasVisibleText(args.networkLabel) ? args.networkLabel : undefined,
		args.borderColor,
	);
	if (!hasContext && !statusGroup) return "";

	const open = args.borderColor("-< ");
	const close = args.borderColor(" >-");

	if (statusGroup && hasContext) {
		const join = args.borderColor(`${FRAME_LABEL_JOIN}< `);
		return `${open}${statusGroup}${args.borderColor(" >")}${join}${sanitizeStatusText(args.contextLabel!)}${close}`;
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
