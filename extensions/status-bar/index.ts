import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	CustomEditor,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type EditorOptions,
	type EditorTheme,
	Key,
	type KeybindingsManager,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	BORDER_PRIORITY_STATUS_BAR_LAYOUT,
	DEFAULT_STATUS_BAR_DISPLAY_MODE,
	DEFAULT_STATUS_BAR_LAYOUT,
	STATUS_BAR_DISPLAY_MODES,
	STATUS_BAR_EVENTS,
	STATUS_BAR_JOIN_SEPARATOR,
	type StatusBarClearPayload,
	type StatusBarDisplayMode,
	type StatusBarFirstLineClearPayload,
	type StatusBarFirstLineSetPayload,
	type StatusBarLayout,
	type StatusBarPingPayload,
	type StatusBarSection,
	type StatusBarSetPayload,
} from "./contract";

const SECTION_DELIMITER = "  ";
const SECTION_GAP = visibleWidth(SECTION_DELIMITER);
const COMPACT_ITEM_JOIN_SEPARATOR = "·";
const SWITCH_THINKING_ID = "switch-thinking";
const SWITCH_THINKING_ACTIVE_ID = "switch-thinking-active";
const CONTEXT_WATCHER_IDS = {
	tokens: "context-watcher-tokens",
	model: "context-watcher-model",
	percent: "context-watcher-percent",
} as const;
const ATTENSION_CORE_ID = "attension-core";
const SAFE_MODE_ID = "safe-mode";
const DISPLAY_MODE_SETTINGS_PATH = join(homedir(), ".pi", "agent", "status-bar.json");
// Minimum horizontal dashes kept when a corner label is rendered on a frame border.
const MIN_CORNER_LABEL_GAP = 6;
// Extra room kept for the working status when the top border already has embedded content.
const WORKING_STATUS_RESERVE = 30;

// Editor frame side borders.
const FRAME_BORDER = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	vertical: "│",
} as const;
// Providers whose context usage label also shows cumulative session cost.
const COST_DISPLAY_PROVIDERS = new Set<string>(["deepseek"]);

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCost(total: number): string {
	if (!Number.isFinite(total) || total <= 0) return "";
	if (total < 0.005) return "<$0.01";
	return `$${total.toFixed(2)}`;
}

// Thinking level shown in the editor frame label (3-4 symbols, uppercase).
const THINKING_LEVEL_ABBREVIATIONS: Record<string, string> = {
	off: "OFF",
	minimal: "MIN",
	low: "LOW",
	medium: "MED",
	high: "HIGH",
	xhigh: "XHI",
	max: "MAX",
};

function abbreviateThinkingLevel(level: string | undefined): string {
	if (typeof level !== "string") return "---";
	const normalized = level.trim().toLowerCase();
	if (!normalized) return "---";
	return THINKING_LEVEL_ABBREVIATIONS[normalized] ?? normalized.slice(0, 4).toUpperCase();
}

function formatCostTrailing(total: number): string {
	if (!Number.isFinite(total) || total <= 0) return "0.00$";
	if (total < 0.005) return "<0.01$";
	return `${total.toFixed(2)}$`;
}

// Bottom-border label: `MED | 15.9% (210k, 0.03$)` (the frame adds `─`/`└`).
// Colored with the same context-usage rules as the status-bar context items.
function buildFrameStatusLabel(
	ctx: ExtensionContext,
	thinkingLevel: string | undefined,
	theme?: { fg: (token: "muted" | "text" | "warning" | "error", text: string) => string },
): string {
	const usage = ctx.getContextUsage();

	const rawPercent = usage?.percent;
	const percentValue =
		typeof rawPercent === "number" && Number.isFinite(rawPercent) ? Math.max(0, rawPercent) : undefined;
	const percent = percentValue === undefined ? "--" : `${percentValue.toFixed(1)}%`;

	const rawTokens = usage?.tokens;
	const tokens = typeof rawTokens === "number" && Number.isFinite(rawTokens) ? formatTokens(rawTokens) : "--";

	const cost = collectUsage(ctx).cost;

	const label = `${abbreviateThinkingLevel(thinkingLevel)} | ${percent} (${tokens}, ${formatCostTrailing(cost)})`;
	if (!theme || percentValue === undefined) return label;

	return styleContextLabel(theme, Number(percentValue.toFixed(1)), label);
}

type FrameStatusProvider = () => string | undefined;

interface FrameStatusEditorOptions {
	/** Current display mode; `legacy` disables all border labels and the side frame. */
	getDisplayMode: () => StatusBarDisplayMode;
	/** Bottom-left corner label (thinking level, context usage, cost). */
	bottomLeft?: FrameStatusProvider;
	/** Bottom-right corner label (safe-mode status). */
	bottomRight?: FrameStatusProvider;
	/** Top-right corner label (active model). */
	topRight?: FrameStatusProvider;
}

/**
 * Build a full-width border line with optional left/right segments.
 * Remaining space is filled with border-colored horizontal dashes.
 */
function renderBorderLine(
	width: number,
	leftSegment: string,
	rightSegment: string,
	borderColor: (text: string) => string,
): string {
	if (width <= 0) return "";

	const leftWidth = visibleWidth(leftSegment);
	const rightWidth = visibleWidth(rightSegment);

	if (leftWidth === 0 && rightWidth === 0) {
		return borderColor("─".repeat(width));
	}

	if (leftWidth + rightWidth >= width) {
		if (leftWidth > 0) return truncateToWidth(leftSegment, width, "");
		return truncateToWidth(rightSegment, width, "");
	}

	return `${leftSegment}${borderColor("─".repeat(width - leftWidth - rightWidth))}${rightSegment}`;
}

/**
 * Default editor with the working status embedded in the top border (pi >= 0.85),
 * side borders, and status labels rendered in the frame corners:
 *
 * ```
 * ┌── <working status> ──────────────── <model> ─┐
 * │ ... input ...                                 │
 * └─ MED | 15.9% (210k, 0.03$) ──────── [SMART] ─┘
 * ```
 */
class FrameStatusEditor extends CustomEditor {
	private readonly getDisplayMode: () => StatusBarDisplayMode;
	private readonly bottomLeftProvider?: FrameStatusProvider;
	private readonly bottomRightProvider?: FrameStatusProvider;
	private readonly topRightProvider?: FrameStatusProvider;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options: FrameStatusEditorOptions) {
		super(tui, theme, keybindings, { embedWorkingStatus: true } as EditorOptions);
		this.getDisplayMode = options.getDisplayMode;
		this.bottomLeftProvider = options.bottomLeft;
		this.bottomRightProvider = options.bottomRight;
		this.topRightProvider = options.topRight;
	}

	private isBorderMode(): boolean {
		return this.getDisplayMode() === "new";
	}

	private rightCornerSegment(label: string, useBorderColor = false): string {
		const sanitized = sanitizeStatusText(label);
		const body = useBorderColor ? this.borderColor(sanitized) : sanitized;
		return ` ${body}${this.borderColor(" ─")}`;
	}

	/**
	 * Render the inner editor 2 columns narrower and draw vertical side borders
	 * plus corner characters around it. Autocomplete lines stay outside the frame.
	 */
	render(width: number): string[] {
		if (!this.isBorderMode() || width < 3) return super.render(width);

		const innerWidth = width - 2;
		const lines = super.render(innerWidth);
		const autocompleteHeight = this.getRenderedAutocompleteHeight();
		const bodyEnd = Math.max(1, lines.length - autocompleteHeight);
		const vertical = this.borderColor(FRAME_BORDER.vertical);
		const out: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			if (i >= bodyEnd) {
				// Keep autocomplete aligned with the editor interior.
				out.push(` ${line}`);
				continue;
			}
			if (i === 0) {
				out.push(`${this.borderColor(FRAME_BORDER.topLeft)}${line}${this.borderColor(FRAME_BORDER.topRight)}`);
			} else if (i === bodyEnd - 1) {
				out.push(
					`${this.borderColor(FRAME_BORDER.bottomLeft)}${line}${this.borderColor(FRAME_BORDER.bottomRight)}`,
				);
			} else {
				out.push(`${vertical}${line}${vertical}`);
			}
		}

		return out;
	}

	private getRenderedAutocompleteHeight(): number {
		const internal = this as unknown as { renderedAutocompleteHeight?: number };
		return typeof internal.renderedAutocompleteHeight === "number" ? internal.renderedAutocompleteHeight : 0;
	}

	/**
	 * Content is shifted one column right by the left border, so translate mouse
	 * coordinates back into the inner editor's coordinate space.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: base handleMouse is not in the published types.
	handleMouse(event: unknown): any {
		if (!this.isBorderMode() || !event || typeof event !== "object") {
			return this.callBaseHandleMouse(event);
		}

		const original = event as { x?: unknown; width?: unknown };
		const adjusted: Record<string, unknown> = {
			...(event as Record<string, unknown>),
			x: (typeof original.x === "number" ? original.x : 0) - 1,
			width: Math.max(0, (typeof original.width === "number" ? original.width : 0) - 2),
		};
		return this.callBaseHandleMouse(adjusted);
	}

	private callBaseHandleMouse(event: unknown): unknown {
		let proto = Object.getPrototypeOf(this) as { handleMouse?: (e: unknown) => unknown } | null;
		while (proto) {
			const handler = proto.handleMouse;
			if (typeof handler === "function" && handler !== FrameStatusEditor.prototype.handleMouse) {
				return handler.call(this, event);
			}
			proto = Object.getPrototypeOf(proto) as { handleMouse?: (e: unknown) => unknown } | null;
		}
		return undefined;
	}

	renderTopBorder(width: number, hiddenLineCount: number): string {
		const base = super.renderTopBorder(width, hiddenLineCount);
		if (!this.isBorderMode() || width <= 0) return base;

		const label = this.topRightProvider?.();
		if (!hasVisibleText(label)) return base;

		const segment = this.rightCornerSegment(label, true);
		const segmentWidth = visibleWidth(segment);
		// Keep the working status / scroll indicator from being truncated when present.
		const hasEmbeddedContent = base !== this.borderColor("─".repeat(width));
		const minGap = hasEmbeddedContent ? WORKING_STATUS_RESERVE : MIN_CORNER_LABEL_GAP;
		if (segmentWidth + minGap > width) return base;

		return `${truncateToWidth(base, width - segmentWidth, "")}${segment}`;
	}

	renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (!this.isBorderMode() || width <= 0) return super.renderBottomBorder(width, hiddenLineCount);

		const leftLabel = this.bottomLeftProvider?.();
		const rightLabel = this.bottomRightProvider?.();
		const hasLeft = hasVisibleText(leftLabel);
		const hasRight = hasVisibleText(rightLabel);

		if (!hasLeft && !hasRight) {
			return super.renderBottomBorder(width, hiddenLineCount);
		}

		const leftSegment = hasLeft ? `${this.borderColor("─ ")}${sanitizeStatusText(leftLabel)} ` : "";
		const rightSegment = hasRight ? this.rightCornerSegment(rightLabel) : "";
		const scrollSegment = hiddenLineCount > 0 ? this.borderColor(` ↓ ${hiddenLineCount} more `) : "";

		const borderColor = (text: string) => this.borderColor(text);
		const candidates: Array<[string, string]> = [
			[leftSegment, `${scrollSegment}${rightSegment}`],
			[leftSegment, rightSegment],
			[leftSegment, ""],
			["", rightSegment],
		];

		for (const [left, right] of candidates) {
			if (visibleWidth(left) + visibleWidth(right) < width) {
				return renderBorderLine(width, left, right, borderColor);
			}
		}

		return renderBorderLine(width, leftSegment, rightSegment, borderColor);
	}
}

function collectUsage(ctx: ExtensionContext): { input: number; output: number; cacheRead: number; cost: number } {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch() as Array<Record<string, unknown>>) {
		if (entry.type !== "message") continue;
		const message = entry.message as Record<string, unknown> | undefined;
		if (!message || message.role !== "assistant") continue;
		const usage = message.usage as Record<string, unknown> | undefined;
		if (!usage) continue;
		input += typeof usage.input === "number" ? usage.input : 0;
		output += typeof usage.output === "number" ? usage.output : 0;
		cacheRead += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
		const usageCost = usage.cost as Record<string, unknown> | undefined;
		cost += usageCost && typeof usageCost.total === "number" ? usageCost.total : 0;
	}

	return { input, output, cacheRead, cost };
}

function styleContextLabel(
	theme: { fg: (token: "muted" | "text" | "warning" | "error", text: string) => string },
	percent: number,
	label: string,
): string {
	if (percent <= 20) return theme.fg("muted", label);
	if (percent <= 30) return theme.fg("text", label);
	if (percent <= 50) return theme.fg("warning", label);
	return theme.fg("error", label);
}

function buildContextTokenLabel(ctx: ExtensionContext, includeCost: boolean): string {
	const usage = collectUsage(ctx);
	let label = `↑${formatTokens(usage.input)}/↓${formatTokens(usage.output)}/${formatTokens(usage.cacheRead)}`;
	if (includeCost && ctx.model?.provider && COST_DISPLAY_PROVIDERS.has(ctx.model.provider)) {
		const costLabel = formatCost(usage.cost);
		if (costLabel) label = `${label} (${costLabel})`;
	}
	return label;
}

function getContextWatcherOverrides(
	ctx: ExtensionContext,
	theme: { fg: (token: "muted" | "text" | "warning" | "error", text: string) => string },
): Map<string, string | undefined> {
	const overrides = new Map<string, string | undefined>([
		[CONTEXT_WATCHER_IDS.tokens, undefined],
		[CONTEXT_WATCHER_IDS.model, undefined],
		[CONTEXT_WATCHER_IDS.percent, undefined],
	]);

	const percent = ctx.getContextUsage()?.percent;
	if (typeof percent !== "number" || !Number.isFinite(percent)) {
		return overrides;
	}

	const safePercent = Math.max(0, percent);
	const roundedPercent = Number(safePercent.toFixed(1));
	const modelName = ctx.model?.id ?? "no-model";
	const percentLabel = `${roundedPercent.toFixed(1)}%`;

	overrides.set(CONTEXT_WATCHER_IDS.tokens, styleContextLabel(theme, roundedPercent, buildContextTokenLabel(ctx, true)));
	overrides.set(CONTEXT_WATCHER_IDS.model, styleContextLabel(theme, roundedPercent, modelName));
	overrides.set(CONTEXT_WATCHER_IDS.percent, styleContextLabel(theme, roundedPercent, percentLabel));

	return overrides;
}

// First-line token breakdown (new display mode), colored like the status-bar context items.
function buildFirstLineTokenLabel(
	ctx: ExtensionContext,
	theme: { fg: (token: "muted" | "text" | "warning" | "error", text: string) => string },
): string {
	const percent = ctx.getContextUsage()?.percent;
	if (typeof percent !== "number" || !Number.isFinite(percent)) {
		return buildContextTokenLabel(ctx, false);
	}
	return styleContextLabel(theme, Number(Math.max(0, percent).toFixed(1)), buildContextTokenLabel(ctx, false));
}

interface FirstLineEntry {
	content: string;
	section: StatusBarSection;
	priority: number;
	order: number;
}

function isSetPayload(value: unknown): value is StatusBarSetPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<StatusBarSetPayload>;
	return typeof maybe.id === "string" && typeof maybe.content === "string";
}

function isClearPayload(value: unknown): value is StatusBarClearPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<StatusBarClearPayload>;
	return typeof maybe.id === "string";
}

function isFirstLineSetPayload(value: unknown): value is StatusBarFirstLineSetPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<StatusBarFirstLineSetPayload>;
	if (typeof maybe.id !== "string") return false;
	if (typeof maybe.content !== "string") return false;
	if (maybe.section !== undefined && maybe.section !== "left" && maybe.section !== "center" && maybe.section !== "right") {
		return false;
	}
	if (maybe.priority !== undefined && typeof maybe.priority !== "number") return false;
	return true;
}

function isFirstLineClearPayload(value: unknown): value is StatusBarFirstLineClearPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<StatusBarFirstLineClearPayload>;
	return typeof maybe.id === "string";
}

function isPingPayload(value: unknown): value is StatusBarPingPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<StatusBarPingPayload>;
	return typeof maybe.id === "string";
}

function parseSetArgs(args: string): StatusBarSetPayload | undefined {
	const input = args.trim();
	if (!input) return undefined;
	const firstSpace = input.indexOf(" ");
	if (firstSpace === -1) return undefined;
	const id = input.slice(0, firstSpace).trim();
	const content = input.slice(firstSpace + 1);
	if (!id) return undefined;
	return { id, content };
}

function parseClearArgs(args: string): StatusBarClearPayload | undefined {
	const id = args.trim();
	if (!id) return undefined;
	return { id };
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").trim();
}

function hasVisibleText(value?: string): value is string {
	if (typeof value !== "string") return false;
	return value.trim().length > 0;
}

function isDisplayMode(value: unknown): value is StatusBarDisplayMode {
	return typeof value === "string" && (STATUS_BAR_DISPLAY_MODES as readonly string[]).includes(value);
}

function normalizeDisplayMode(value: unknown): StatusBarDisplayMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return isDisplayMode(normalized) ? normalized : undefined;
}

function loadDisplayMode(): StatusBarDisplayMode {
	const fromEnv = normalizeDisplayMode(process.env.PI_STATUS_BAR_DISPLAY_MODE);
	if (fromEnv) return fromEnv;

	try {
		const parsed = JSON.parse(readFileSync(DISPLAY_MODE_SETTINGS_PATH, "utf-8")) as { displayMode?: unknown } | null;
		const fromFile = normalizeDisplayMode(parsed?.displayMode);
		if (fromFile) return fromFile;
	} catch {
		// Missing or invalid settings file: fall back to the default.
	}

	return DEFAULT_STATUS_BAR_DISPLAY_MODE;
}

function saveDisplayMode(mode: StatusBarDisplayMode): { ok: true } | { ok: false; error: string } {
	let tempPath = "";
	try {
		let existing: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(readFileSync(DISPLAY_MODE_SETTINGS_PATH, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		} catch {
			// New or unreadable file: start from an empty object.
		}

		mkdirSync(dirname(DISPLAY_MODE_SETTINGS_PATH), { recursive: true });
		tempPath = `${DISPLAY_MODE_SETTINGS_PATH}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tempPath, `${JSON.stringify({ ...existing, displayMode: mode }, null, 2)}\n`, "utf-8");
		renameSync(tempPath, DISPLAY_MODE_SETTINGS_PATH);
		return { ok: true };
	} catch (error) {
		if (tempPath) {
			try {
				rmSync(tempPath, { force: true });
			} catch {
				// Ignore cleanup error.
			}
		}
		return {
			ok: false,
			error: `Failed to save ${DISPLAY_MODE_SETTINGS_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function composeAtPositions(
	width: number,
	segments: Array<{ text: string; start: number }>,
): string | undefined {
	if (width <= 0) return "";
	if (segments.length === 0) return undefined;

	const ordered = [...segments].sort((a, b) => a.start - b.start);
	let cursor = 0;
	let out = "";

	for (const segment of ordered) {
		const segmentWidth = visibleWidth(segment.text);
		const end = segment.start + segmentWidth;
		if (segment.start < cursor || segment.start < 0 || end > width) {
			return undefined;
		}
		if (segment.start > cursor) {
			out += " ".repeat(segment.start - cursor);
		}
		out += segment.text;
		cursor = end;
	}

	if (cursor < width) {
		out += " ".repeat(width - cursor);
	}

	return out;
}

function renderThreeSectionLine(width: number, left?: string, center?: string, right?: string): string {
	if (width <= 0) return "";

	const normalizedLeft = hasVisibleText(left) ? sanitizeStatusText(left) : undefined;
	const normalizedCenter = hasVisibleText(center) ? sanitizeStatusText(center) : undefined;
	const normalizedRight = hasVisibleText(right) ? sanitizeStatusText(right) : undefined;

	if (!normalizedLeft && !normalizedCenter && !normalizedRight) return "";

	const exactSegments: Array<{ text: string; start: number }> = [];
	if (normalizedLeft) exactSegments.push({ text: normalizedLeft, start: 0 });
	if (normalizedCenter) {
		exactSegments.push({
			text: normalizedCenter,
			start: Math.floor((width - visibleWidth(normalizedCenter)) / 2),
		});
	}
	if (normalizedRight) {
		exactSegments.push({
			text: normalizedRight,
			start: width - visibleWidth(normalizedRight),
		});
	}

	if (exactSegments.length > 0) {
		const ordered = [...exactSegments].sort((a, b) => a.start - b.start);
		let hasOverlap = false;
		for (let i = 0; i < ordered.length - 1; i++) {
			const current = ordered[i]!;
			const next = ordered[i + 1]!;
			const currentEnd = current.start + visibleWidth(current.text);
			if (currentEnd + SECTION_GAP > next.start) {
				hasOverlap = true;
				break;
			}
		}

		if (!hasOverlap) {
			const exact = composeAtPositions(width, exactSegments);
			if (typeof exact === "string") return exact;
		}
	}

	if (normalizedLeft && normalizedRight) {
		const leftWidth = visibleWidth(normalizedLeft);
		const rightWidth = visibleWidth(normalizedRight);
		const rightStart = width - rightWidth;

		if (leftWidth + SECTION_GAP <= rightStart) {
			const leftRight = composeAtPositions(width, [
				{ text: normalizedLeft, start: 0 },
				{ text: normalizedRight, start: rightStart },
			]);
			if (typeof leftRight === "string") return leftRight;
		}

		const leftBudget = width - rightWidth - SECTION_GAP;
		if (leftBudget > 0) {
			const truncatedLeft = truncateToWidth(normalizedLeft, leftBudget, "");
			const truncatedLeftWidth = visibleWidth(truncatedLeft);
			const padded = composeAtPositions(width, [
				{ text: truncatedLeft, start: 0 },
				{ text: normalizedRight, start: width - rightWidth },
			]);
			if (typeof padded === "string" && truncatedLeftWidth > 0) return padded;
		}

		const rightBudget = width - leftWidth - SECTION_GAP;
		if (rightBudget > 0) {
			const truncatedRight = truncateToWidth(normalizedRight, rightBudget, "");
			const truncatedRightWidth = visibleWidth(truncatedRight);
			const padded = composeAtPositions(width, [
				{ text: normalizedLeft, start: 0 },
				{ text: truncatedRight, start: width - truncatedRightWidth },
			]);
			if (typeof padded === "string") return padded;
		}

		return truncateToWidth(normalizedLeft, width, "");
	}

	if (normalizedLeft && normalizedCenter) {
		return truncateToWidth(`${normalizedLeft}${SECTION_DELIMITER}${normalizedCenter}`, width, "");
	}

	if (normalizedCenter && normalizedRight) {
		return truncateToWidth(`${normalizedCenter}${SECTION_DELIMITER}${normalizedRight}`, width, "");
	}

	if (normalizedCenter) return truncateToWidth(normalizedCenter, width, "");
	if (normalizedRight) return truncateToWidth(normalizedRight, width, "");
	return truncateToWidth(normalizedLeft ?? "", width, "");
}

interface StatusBarContractSettingItem {
	id: string;
	label: string;
	value: string;
	description?: string;
}

async function showStatusBarContractUI(ctx: ExtensionContext, displayMode: StatusBarDisplayMode): Promise<void> {
	if (!ctx.hasUI) return;

	const layout = displayMode === "new" ? BORDER_PRIORITY_STATUS_BAR_LAYOUT : DEFAULT_STATUS_BAR_LAYOUT;

	const items: StatusBarContractSettingItem[] = [
		{
			id: "display-mode",
			label: "Display mode",
			value: displayMode,
			description:
				"new: info on the editor frame border, duplicates hidden from the status line. legacy: info on the status line, border labels hidden.",
		},
		{
			id: "event-set",
			label: "Event: set",
			value: STATUS_BAR_EVENTS.set,
			description: "Producers publish status content updates with this event.",
		},
		{
			id: "event-clear",
			label: "Event: clear",
			value: STATUS_BAR_EVENTS.clear,
			description: "Producers remove previously published content with this event.",
		},
		{
			id: "event-first-line-set",
			label: "Event: first line set",
			value: STATUS_BAR_EVENTS.firstLineSet,
			description: "Sets first-line content with optional section (left/center/right) and priority.",
		},
		{
			id: "event-first-line-clear",
			label: "Event: first line clear",
			value: STATUS_BAR_EVENTS.firstLineClear,
			description: "Clears first-line producer content by id.",
		},
		{
			id: "event-ping",
			label: "Event: ping",
			value: STATUS_BAR_EVENTS.ping,
			description: "Availability probe; status-bar replies with pong echoing the same id.",
		},
		{
			id: "event-pong",
			label: "Event: pong",
			value: STATUS_BAR_EVENTS.pong,
			description: "Availability response emitted after a valid ping payload.",
		},
		{
			id: "item-join",
			label: "Item join separator",
			value: JSON.stringify(STATUS_BAR_JOIN_SEPARATOR),
			description: "Used between items within the same section.",
		},
		{
			id: "section-separator",
			label: "Section separator",
			value: JSON.stringify(SECTION_DELIMITER),
			description: "Minimum spacing between left / center / right sections.",
		},
		{
			id: "renderer",
			label: "Renderer",
			value: "ctx.ui.setFooter(custom)",
			description: "Status bar is rendered via custom footer, not setStatus.",
		},
		{
			id: "layout-left",
			label: "Layout: left",
			value: layout.left.join(", "),
			description: "Producer IDs rendered in the left section.",
		},
		{
			id: "layout-center",
			label: "Layout: center",
			value: layout.center.join(", ") || "(empty)",
			description: "Producer IDs rendered in the center section.",
		},
		{
			id: "layout-right",
			label: "Layout: right",
			value: layout.right.join(", ") || "(empty)",
			description: "Producer IDs rendered in the right section.",
		},
		{
			id: "cost-providers",
			label: "Cost display providers",
			value: [...COST_DISPLAY_PROVIDERS].join(", "),
			description: "Providers whose context usage label also shows cumulative session cost.",
		},
	];

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let selectedIndex = 0;

		interface View {
			container: Container;
			list: SelectList;
			listItems: SelectItem[];
		}

		const buildView = (): View => {
			const selected = items[selectedIndex] ?? items[0]!;
			const listItems: SelectItem[] = items.map((item) => ({
				value: item.id,
				label: item.label,
				description: item.description,
			}));

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Status Bar Contract (read-only)"))));

			const list = new SelectList(listItems, Math.min(Math.max(listItems.length, 1), 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			if (listItems.length > 0) {
				list.setSelectedIndex(selectedIndex);
			}

			list.onSelectionChange = (entry) => {
				const nextIndex = listItems.findIndex((candidate) => candidate.value === entry.value);
				if (nextIndex < 0 || nextIndex === selectedIndex) return;
				selectedIndex = nextIndex;
				refresh();
			};
			list.onSelect = () => done();
			list.onCancel = () => done();

			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "Value")));
			container.addChild(new Text(theme.fg("text", selected.value)));
			if (selected.description) {
				container.addChild(new Text(theme.fg("muted", selected.description)));
			}
			container.addChild(new Text(theme.fg("dim", "↑↓/j k navigate • enter/esc close")));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return { container, list, listItems };
		};

		let view = buildView();

		const refresh = () => {
			view = buildView();
			tui.requestRender();
		};

		const moveSelection = (delta: number) => {
			if (view.listItems.length === 0) return;
			const nextIndex = Math.max(0, Math.min(view.listItems.length - 1, selectedIndex + delta));
			if (nextIndex === selectedIndex) return;
			selectedIndex = nextIndex;
			refresh();
		};

		return {
			render(width: number) {
				return view.container.render(width);
			},
			invalidate() {
				view.container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, "j") || data === "j") {
					moveSelection(1);
					return;
				}
				if (matchesKey(data, "k") || data === "k") {
					moveSelection(-1);
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done();
					return;
				}

				view.list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export default function statusBarExtension(pi: ExtensionAPI): void {
	const contentById = new Map<string, string>();
	const firstLineById = new Map<string, FirstLineEntry>();
	let firstLineOrderCounter = 0;
	let displayMode: StatusBarDisplayMode = loadDisplayMode();
	let lastContext: ExtensionContext | undefined;
	let footerOwnerContext: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let editorOwnerContext: ExtensionContext | undefined;
	let requestEditorRender: (() => void) | undefined;
	let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

	const activeLayout = (): StatusBarLayout =>
		displayMode === "new" ? BORDER_PRIORITY_STATUS_BAR_LAYOUT : DEFAULT_STATUS_BAR_LAYOUT;

	const renderSection = (
		ids: string[],
		overrides?: Map<string, string | undefined>,
		joinSeparator: string = STATUS_BAR_JOIN_SEPARATOR,
	): string | undefined => {
		const items = ids
			.map((id) => (overrides?.has(id) ? overrides.get(id) : contentById.get(id)))
			.filter((value): value is string => hasVisibleText(value))
			.map((value) => sanitizeStatusText(value));
		if (items.length === 0) return undefined;
		return items.join(joinSeparator);
	};

	const isCrowded = (width: number, left?: string, center?: string, right?: string): boolean => {
		if (width <= 0) return true;
		if (visibleWidth(left ?? "") + visibleWidth(center ?? "") + visibleWidth(right ?? "") + SECTION_GAP * 2 > width) {
			return true;
		}
		if (!!left && !!right && visibleWidth(left) + SECTION_GAP + visibleWidth(right) > width) {
			return true;
		}
		return false;
	};

	const renderFirstLineSection = (
		section: StatusBarSection,
		joinSeparator: string = STATUS_BAR_JOIN_SEPARATOR,
		attensionCoreSuffix?: string,
	): string | undefined => {
		const items = [...firstLineById.entries()]
			.filter(([, entry]) => entry.section === section && hasVisibleText(entry.content))
			.sort(([, a], [, b]) => b.priority - a.priority || a.order - b.order)
			.map(([id, entry]) => {
				const content = sanitizeStatusText(entry.content);
				if (id === ATTENSION_CORE_ID && hasVisibleText(attensionCoreSuffix)) {
					return `${content} ${sanitizeStatusText(attensionCoreSuffix)}`;
				}
				return content;
			});

		if (items.length === 0) return undefined;
		return items.join(joinSeparator);
	};

	const hasFirstLineContent = (): boolean => {
		for (const entry of firstLineById.values()) {
			if (hasVisibleText(entry.content)) return true;
		}
		return false;
	};

	const requestRender = (): void => {
		requestFooterRender?.();
		requestEditorRender?.();
	};

	const installFooter = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (footerOwnerContext === ctx) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const localRenderRequest = () => tui.requestRender();
			requestFooterRender = localRenderRequest;
			const unsubscribeBranch = footerData.onBranchChange(localRenderRequest);

			return {
				invalidate() {},
				dispose() {
					if (requestFooterRender === localRenderRequest) {
						requestFooterRender = undefined;
					}
					unsubscribeBranch();
				},
				render(width: number): string[] {
					const activeCtx = lastContext ?? ctx;

					let pwd = activeCtx.cwd || process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = activeCtx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;
					const defaultFirstLine = theme.fg("dim", pwd);

					const firstLineTokenLabel = displayMode === "new" ? buildFirstLineTokenLabel(activeCtx, theme) : undefined;

					let line1: string;
					if (hasFirstLineContent()) {
						const firstLineJoinSeparator = theme.fg("muted", STATUS_BAR_JOIN_SEPARATOR);
						const hasAttensionCore = hasVisibleText(firstLineById.get(ATTENSION_CORE_ID)?.content);
						const attensionCoreSuffix = hasAttensionCore ? defaultFirstLine : undefined;
						const producerLeft = renderFirstLineSection("left", firstLineJoinSeparator, attensionCoreSuffix);
						const left = producerLeft ?? (hasAttensionCore ? undefined : defaultFirstLine);
						const center = renderFirstLineSection("center", firstLineJoinSeparator, attensionCoreSuffix);
						const producerRight = renderFirstLineSection("right", firstLineJoinSeparator, attensionCoreSuffix);
						const right = firstLineTokenLabel
							? producerRight
								? `${producerRight}${firstLineJoinSeparator}${firstLineTokenLabel}`
								: firstLineTokenLabel
							: producerRight;
						line1 = renderThreeSectionLine(width, left, center, right);
					} else if (firstLineTokenLabel) {
						line1 = renderThreeSectionLine(width, defaultFirstLine, undefined, firstLineTokenLabel);
					} else {
						line1 = truncateToWidth(defaultFirstLine, width, theme.fg("dim", "..."));
					}

					const layout = activeLayout();
					const contextOverrides = layout.right.length > 0 ? getContextWatcherOverrides(activeCtx, theme) : undefined;

					let joinSeparator = theme.fg("muted", STATUS_BAR_JOIN_SEPARATOR);
					let left = renderSection(layout.left, undefined, joinSeparator);
					let center = renderSection(layout.center, undefined, joinSeparator);
					let right = renderSection(layout.right, contextOverrides, joinSeparator);

					if (isCrowded(width, left, center, right)) {
						joinSeparator = theme.fg("muted", COMPACT_ITEM_JOIN_SEPARATOR);
						left = renderSection(layout.left, undefined, joinSeparator);
						center = renderSection(layout.center, undefined, joinSeparator);
						right = renderSection(layout.right, contextOverrides, joinSeparator);
					}

					const hasThinkingSection = layout.left.includes(SWITCH_THINKING_ID);
					const activeThinking = contentById.get(SWITCH_THINKING_ACTIVE_ID);
					const needCompactThinking = hasThinkingSection && hasVisibleText(activeThinking) && isCrowded(width, left, center, right);

					if (needCompactThinking) {
						const leftOverrides = new Map<string, string | undefined>([[SWITCH_THINKING_ID, activeThinking]]);
						left = renderSection(layout.left, leftOverrides, joinSeparator);
					}

					const line2 = renderThreeSectionLine(width, left, center, right);
					return line2.length > 0 ? [line1, line2] : [line1];
				},
			};
		});

		footerOwnerContext = ctx;
	};

	const installEditorFrameStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (editorOwnerContext === ctx) return;

		previousEditorFactory = ctx.ui.getEditorComponent();

		const activeContext = () => lastContext ?? ctx;
		const options: FrameStatusEditorOptions = {
			getDisplayMode: () => displayMode,
			bottomLeft: () => buildFrameStatusLabel(activeContext(), pi.getThinkingLevel(), activeContext().ui.theme),
			bottomRight: () => contentById.get(SAFE_MODE_ID),
			topRight: () => activeContext().model?.id,
		};

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			requestEditorRender = () => tui.requestRender();
			return new FrameStatusEditor(tui, editorTheme, keybindings, options);
		});

		editorOwnerContext = ctx;
	};

	const bindContextAndRender = (ctx: ExtensionContext): void => {
		lastContext = ctx;
		if (ctx.hasUI) {
			installFooter(ctx);
			installEditorFrameStatus(ctx);
		}
		requestRender();
	};

	pi.on("session_start", async (_event, ctx) => {
		bindContextAndRender(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		bindContextAndRender(ctx);
	});

	const bindRenderRefresh = (
		eventName:
			| "session_compact"
			| "model_select"
			| "turn_start"
			| "turn_end"
			| "agent_start"
			| "agent_end"
			| "message_start"
			| "message_update"
			| "message_end"
			| "input"
			| "user_bash",
	) => {
		pi.on(eventName, async (_event, ctx) => {
			lastContext = ctx;
			requestRender();
		});
	};

	bindRenderRefresh("session_compact");
	bindRenderRefresh("model_select");
	bindRenderRefresh("turn_start");
	bindRenderRefresh("turn_end");
	bindRenderRefresh("agent_start");
	bindRenderRefresh("agent_end");
	bindRenderRefresh("message_start");
	bindRenderRefresh("message_update");
	bindRenderRefresh("message_end");
	bindRenderRefresh("input");
	bindRenderRefresh("user_bash");

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setFooter(undefined);
		}
		if (footerOwnerContext === ctx) {
			footerOwnerContext = undefined;
		}
		if (editorOwnerContext === ctx) {
			if (ctx.hasUI) ctx.ui.setEditorComponent(previousEditorFactory);
			editorOwnerContext = undefined;
			previousEditorFactory = undefined;
			requestEditorRender = undefined;
		}
		if (lastContext === ctx) {
			lastContext = undefined;
		}
		requestFooterRender = undefined;
	});

	pi.events.on(STATUS_BAR_EVENTS.set, (payload) => {
		if (!isSetPayload(payload)) return;
		contentById.set(payload.id, payload.content);
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.clear, (payload) => {
		if (!isClearPayload(payload)) return;
		contentById.delete(payload.id);
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.firstLineSet, (payload) => {
		if (!isFirstLineSetPayload(payload)) return;
		const existing = firstLineById.get(payload.id);
		const order = existing?.order ?? firstLineOrderCounter++;
		firstLineById.set(payload.id, {
			content: payload.content,
			section: payload.section ?? "left",
			priority: Number.isFinite(payload.priority) ? payload.priority ?? 0 : 0,
			order,
		});
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.firstLineClear, (payload) => {
		if (!isFirstLineClearPayload(payload)) return;
		firstLineById.delete(payload.id);
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.ping, (payload) => {
		if (!isPingPayload(payload)) return;
		pi.events.emit(STATUS_BAR_EVENTS.pong, { id: payload.id });
	});

	pi.registerCommand("status-bar-contract", {
		description: "Open a read-only status-bar contract settings view",
		handler: async (_args, ctx) => {
			bindContextAndRender(ctx);
			if (!ctx.hasUI) return;
			await showStatusBarContractUI(ctx, displayMode);
		},
	});

	pi.registerCommand("status-bar-display-mode", {
		description: "Set status-bar display mode: /status-bar-display-mode new|legacy",
		handler: async (args, ctx) => {
			const requested = normalizeDisplayMode(args ?? "");
			if (!requested) {
				if (ctx.hasUI) {
					ctx.ui.notify(`status-bar display mode: ${displayMode} (usage: /status-bar-display-mode new|legacy)`, "info");
				}
				return;
			}

			displayMode = requested;
			bindContextAndRender(ctx);

			const saved = saveDisplayMode(requested);
			if (!ctx.hasUI) return;
			if (saved.ok) {
				ctx.ui.notify(`status-bar display mode: ${requested}`, "info");
			} else {
				ctx.ui.notify(`status-bar display mode: ${requested} (${saved.error})`, "warning");
			}
		},
	});

	pi.registerCommand("status-bar-set", {
		description: "Dev helper: /status-bar-set <id> <content>",
		handler: async (args, ctx) => {
			const parsed = parseSetArgs(args ?? "");
			if (!parsed) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /status-bar-set <id> <content>", "warning");
				return;
			}
			bindContextAndRender(ctx);
			pi.events.emit(STATUS_BAR_EVENTS.set, parsed);
		},
	});

	pi.registerCommand("status-bar-clear", {
		description: "Dev helper: /status-bar-clear <id>",
		handler: async (args, ctx) => {
			const parsed = parseClearArgs(args ?? "");
			if (!parsed) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /status-bar-clear <id>", "warning");
				return;
			}
			bindContextAndRender(ctx);
			pi.events.emit(STATUS_BAR_EVENTS.clear, parsed);
		},
	});
}
