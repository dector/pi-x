import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	CustomEditor,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type EditorOptions,
	type EditorTheme,
	Key,
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
	type StatusBarAliasConfig,
	type StatusBarAliasMap,
	type StatusBarClearPayload,
	type StatusBarDisplayMode,
	type StatusBarFirstLineClearPayload,
	type StatusBarFirstLineSetPayload,
	type StatusBarLayout,
	type StatusBarPingPayload,
	type StatusBarRowClearPayload,
	type StatusBarRowSetPayload,
	type StatusBarSection,
	type StatusBarSetPayload,
} from "./contract";
import {
	chooseTopBorderSegments,
	compactFrameLabel,
	composeBorderBottomLeft,
	composeLegacyLeftSection,
	composeSectionItems,
	decorateBorderContextLabel,
	decorateBorderGitStats,
	decorateBorderPathBranch,
	decorateBorderTotalUsage,
	FRAME_LABEL_CLOSE,
	FRAME_LABEL_OPEN,
	FRAME_LEFT_CORNER_OPEN,
	FRAME_RIGHT_CORNER_CLOSE,
	hasVisibleText,
	sanitizeStatusText,
} from "./compose";
import { NetworkStateStore, resolveNetworkStatus } from "./network";

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
const REPO_STATS_ID = "repo-stats";
const STATUS_BAR_SETTINGS_PATH = join(homedir(), ".pi", "agent", "status-bar.json");
// Minimum horizontal dash kept between labels (or beside a lone label).
const MIN_CORNER_LABEL_GAP = 1;
// While streaming, the top-left model label is animated. Two styles are available:
// - `comet`: a single character is highlighted and bounces back and forth across
//   the label. A short fading trail follows behind it (in the direction of motion).
// - `glitch`: a few random characters are replaced with matrix-like blocks
//   (`▓▒░`) for a random number of ticks each.
const WORKING_COMET_INTERVAL_MS = 60;
const WORKING_TRAIL_LENGTH = 3;
const WORKING_GLITCH_INTERVAL_MS = 70;
// Matrix-like replacement glyphs. Denser glyphs render brighter (see depth map).
const WORKING_GLITCH_GLYPHS = ["▓", "▒", "░"] as const;
const WORKING_GLITCH_DEPTH: Record<string, number> = { "▓": 0, "▒": 1, "░": 2 };
// Glitch cells spawn in this range and live for this many ticks. The cap keeps
// only a few characters corrupted at once so the label stays readable.
const WORKING_GLITCH_SPAWN_MIN = 1;
const WORKING_GLITCH_SPAWN_MAX = 2;
const WORKING_GLITCH_MAX_ACTIVE = 3;
const WORKING_GLITCH_STAY_MIN = 1;
const WORKING_GLITCH_STAY_MAX = 4;

const WORKING_ANIMATIONS = ["comet", "glitch"] as const;
type WorkingAnimation = (typeof WORKING_ANIMATIONS)[number];
// Source-level default for the streaming animation. Override for a quick preview
// with `PI_STATUS_BAR_WORKING_ANIMATION=comet|glitch`.
const WORKING_ANIMATION: WorkingAnimation = "comet";

// Nerd Font glyph shown immediately before the model label in border mode.
const MODEL_DISPLAY_GLYPH = "󰙴 ";

// Heavy editor frame with square corners.
const FRAME_BORDER = {
	topLeft: "┏",
	topRight: "┓",
	bottomLeft: "┗",
	bottomRight: "┛",
	vertical: "┃",
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

// Thinking level abbreviations shown in the editor frame label (3-4 symbols, lowercase).
const THINKING_LEVEL_ABBREVIATIONS: Record<string, string> = {
	off: "off",
	minimal: "min",
	low: "low",
	medium: "med",
	high: "high",
	xhigh: "xhi",
	max: "max",
};

// Arrow indicators appended to the abbreviation. Higher levels point up, lower
// levels point down; extra arrows mark extremes.
const THINKING_LEVEL_INDICATORS: Record<string, string> = {
	off: "✘",
	minimal: "🡻🡻",
	low: "🡻",
	medium: "🡺",
	high: "🢁",
	xhigh: "🢁🢁",
	max: "🢁🢁🢁",
};

// Wide screens show only the abbreviation; compact (narrow) screens fall back
// to the arrow indicator without text.
function formatThinkingLevel(level: string | undefined, options?: { compact?: boolean }): string {
	if (typeof level !== "string") return "---";
	const normalized = level.trim().toLowerCase();
	if (!normalized) return "---";
	const abbreviation = THINKING_LEVEL_ABBREVIATIONS[normalized] ?? normalized.slice(0, 4).toLowerCase();
	if (options?.compact) return THINKING_LEVEL_INDICATORS[normalized] ?? abbreviation;
	return abbreviation;
}

function formatCostTrailing(total: number): string {
	if (!Number.isFinite(total) || total <= 0) return "0.00$";
	if (total < 0.005) return "<0.01$";
	return `${total.toFixed(2)}$`;
}

// Three-decimal variant used for the session+subagent total, so small subagent
// spend stays visible next to the two-decimal session cost.
function formatCostTrailingPrecise(total: number): string {
	if (!Number.isFinite(total) || total <= 0) return "0.000$";
	if (total < 0.0005) return "<0.001$";
	return `${total.toFixed(3)}$`;
}

// Bottom-border context label: `15.9% 210k · 0.03$` (the frame adds spacing and border dashes).
// Colored with the same context-usage rules as the status-bar context items.
function buildFrameContextLabel(
	ctx: ExtensionContext,
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
	const subagentCost = collectSubagentCost(ctx);
	const totalCost = cost + subagentCost;
	// Show session | total only when the extra precision actually differs.
	const costLabel =
		cost.toFixed(3) !== totalCost.toFixed(3)
			? `${formatCostTrailing(cost)} | ${formatCostTrailingPrecise(totalCost)}`
			: formatCostTrailing(cost);

	const label = decorateBorderContextLabel(`${percent} ${tokens} · ${costLabel}`);
	if (!theme || percentValue === undefined) return label;

	return styleContextLabel(theme, Number(percentValue.toFixed(1)), label);
}

type FrameStatusProvider = (options?: { compact?: boolean }) => string | undefined;

interface FrameStatusEditorOptions {
	/** Current display mode; `legacy` disables all border labels and the side frame. */
	getDisplayMode: () => StatusBarDisplayMode;
	/** Bottom-left corner label (context usage and cost). */
	bottomLeft?: FrameStatusProvider;
	/** Secondary bottom-left label (safe-mode status), rendered after `bottomLeft`. */
	bottomLeftStatus?: FrameStatusProvider;
	/** Effective network token, rendered immediately after the safe-mode status. */
	bottomLeftNetwork?: FrameStatusProvider;
	/** Top-left corner label (active provider/model plus effort), with the working highlight while streaming. */
	topLeft?: FrameStatusProvider;
	/** Top-right corner label (git dirty totals). */
	topRight?: FrameStatusProvider;
	/** Streaming animation style for the top-left model label. */
	getWorkingAnimation: () => WorkingAnimation;
	/** Muted theme color used for zero-valued border git stats. */
	mutedColor?: (text: string) => string;
	/**
	 * Color for the working highlight. `depth` 0 is the leading character
	 * (brightest); higher depths are the trailing fade behind the direction of motion.
	 */
	highlightColor?: (text: string, depth: number) => string;
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
		return borderColor("━".repeat(width));
	}

	if (leftWidth + rightWidth >= width) {
		if (leftWidth > 0) return truncateToWidth(leftSegment, width, "");
		return truncateToWidth(rightSegment, width, "");
	}

	return `${leftSegment}${borderColor("━".repeat(width - leftWidth - rightWidth))}${rightSegment}`;
}

/**
 * Default editor with heavy square borders and status labels rendered in the
 * frame corners. In `new` display mode the top-left corner shows the active
 * provider/model plus effort (abbreviation, or arrows-only on narrow screens)
 * and the top-right corner shows the git dirty totals. While streaming, the
 * label runs the configured animation
 * (`comet` or `glitch`; no spinner, no `Working` word). Editor content is inset
 * by one column on each side
 * (`┃ <input> ┃`):
 *
 * ```
 * ┏━━ 󰙴 cdx/5.6-sol · high ━ 󰐖 1 󰍵 2 󰦓 4 · 󰐖 150 󰍵 200 ━━┓
 * ┃ ... input ...                                  ┃
 * ┗━━ SMART · 󰅟  NET? ━━━ 15.9% 210k · 0.03$ ━━━━━━━━━┛
 * ```
 */
class FrameStatusEditor extends CustomEditor {
	private readonly getDisplayMode: () => StatusBarDisplayMode;
	private readonly bottomLeftProvider?: FrameStatusProvider;
	private readonly bottomLeftStatusProvider?: FrameStatusProvider;
	private readonly bottomLeftNetworkProvider?: FrameStatusProvider;
	private readonly topLeftProvider?: FrameStatusProvider;
	private readonly topRightProvider?: FrameStatusProvider;
	private readonly getWorkingAnimation: () => WorkingAnimation;
	private readonly mutedColor?: (text: string) => string;
	private readonly highlightColor?: (text: string, depth: number) => string;
	private readonly frameTui: TUI;
	private working = false;
	private workingTick = 0;
	private workingTimer?: ReturnType<typeof setInterval>;
	/** Active glitch cells keyed by character index, with ticks left to live. */
	private readonly glitchCells = new Map<number, { glyph: string; remaining: number }>();
	/** Length of the model label from the last render, used to place glitch cells. */
	private lastModelLabelLength = 0;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options: FrameStatusEditorOptions) {
		super(tui, theme, keybindings, { embedWorkingStatus: true, paddingX: 1 } as EditorOptions);
		this.frameTui = tui;
		this.getDisplayMode = options.getDisplayMode;
		this.bottomLeftProvider = options.bottomLeft;
		this.bottomLeftStatusProvider = options.bottomLeftStatus;
		this.bottomLeftNetworkProvider = options.bottomLeftNetwork;
		this.topLeftProvider = options.topLeft;
		this.topRightProvider = options.topRight;
		this.getWorkingAnimation = options.getWorkingAnimation;
		this.mutedColor = options.mutedColor;
		this.highlightColor = options.highlightColor;
	}

	/** Track streaming state and drive the model-label animation. */
	setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
		super.setWorkingStatusIndicator(indicator);
		this.working = indicator !== undefined && indicator !== null;
		if (this.working) {
			this.startWorkingAnimation();
		} else {
			this.stopWorkingAnimation();
		}
	}

	/** Stop the highlight animation and clear the timer (safe to call repeatedly). */
	stopWorkingAnimation(): void {
		if (this.workingTimer) {
			clearInterval(this.workingTimer);
			this.workingTimer = undefined;
		}
		this.glitchCells.clear();
	}

	private startWorkingAnimation(): void {
		this.stopWorkingAnimation();
		this.workingTick = 0;
		const interval =
			this.getWorkingAnimation() === "glitch" ? WORKING_GLITCH_INTERVAL_MS : WORKING_COMET_INTERVAL_MS;
		this.workingTimer = setInterval(() => {
			this.workingTick += 1;
			if (this.getWorkingAnimation() === "glitch") this.advanceGlitch();
			if (this.isBorderMode()) this.frameTui.requestRender();
		}, interval);
	}

	/**
	 * Expire finished glitch cells, then corrupt a random few new characters.
	 * Each cell keeps its own lifetime so cells appear and vanish out of sync.
	 */
	private advanceGlitch(): void {
		for (const [index, cell] of this.glitchCells) {
			cell.remaining -= 1;
			if (cell.remaining <= 0) this.glitchCells.delete(index);
		}

		const length = this.lastModelLabelLength;
		if (length <= 0) return;

		const spawn = randomInt(WORKING_GLITCH_SPAWN_MIN, WORKING_GLITCH_SPAWN_MAX);
		for (let i = 0; i < spawn; i++) {
			if (this.glitchCells.size >= WORKING_GLITCH_MAX_ACTIVE) break;
			const index = randomInt(0, length - 1);
			if (this.glitchCells.has(index)) continue;
			this.glitchCells.set(index, {
				glyph: WORKING_GLITCH_GLYPHS[randomInt(0, WORKING_GLITCH_GLYPHS.length - 1)]!,
				remaining: randomInt(WORKING_GLITCH_STAY_MIN, WORKING_GLITCH_STAY_MAX),
			});
		}
	}

	private isBorderMode(): boolean {
		return this.getDisplayMode() === "new";
	}

	/**
	 * Color the model label while streaming. `comet` moves a leading highlight
	 * 0..n-1..0 with a fading trail; `glitch` swaps a few characters for matrix
	 * blocks. When idle, every character uses the border color.
	 */
	private renderModelLabel(label: string): string {
		const chars = Array.from(sanitizeStatusText(label));
		if (chars.length === 0) return "";
		this.lastModelLabelLength = chars.length;

		const highlight = this.highlightColor ?? ((text: string) => this.borderColor(text));

		if (this.working && this.getWorkingAnimation() === "glitch") {
			// Drop cells that no longer point at a character (e.g. after a model switch).
			for (const index of this.glitchCells.keys()) {
				if (index >= chars.length) this.glitchCells.delete(index);
			}
			return chars
				.map((ch, i) => {
					const cell = this.glitchCells.get(i);
					if (!cell) return this.borderColor(ch);
					return highlight(cell.glyph, WORKING_GLITCH_DEPTH[cell.glyph] ?? 0);
				})
				.join("");
		}

		const bounce = this.working ? bounceState(chars.length, this.workingTick) : undefined;
		return chars
			.map((ch, i) => {
				if (!bounce) return this.borderColor(ch);
				const depth = (bounce.index - i) * bounce.direction;
				return depth >= 0 && depth <= WORKING_TRAIL_LENGTH ? highlight(ch, depth) : this.borderColor(ch);
			})
			.join("");
	}

	/** Resolve the top-left model/effort label, optionally in compact (arrows-only) form. */
	private topLeftLabel(compact: boolean): string | undefined {
		const label = this.topLeftProvider?.({ compact });
		return hasVisibleText(label) ? label : undefined;
	}

	/**
	 * Top-left corner label: model plus effort inset from the corner by `━━ `.
	 * While streaming the label runs the configured animation.
	 */
	private topLeftSegment(label: string): string {
		const body = this.renderModelLabel(label);
		return `${this.borderColor(FRAME_LEFT_CORNER_OPEN)}${body}${this.borderColor(FRAME_LABEL_CLOSE)}`;
	}

	/**
	 * Top-right corner label. Compact mode removes value spacing; the narrow
	 * fallback (`omitLineCounts`) drops the changed-line group while keeping the
	 * files group and modified-file count.
	 */
	private topRightSegment(options: { compact?: boolean; omitLineCounts?: boolean } = {}): string {
		const label = this.topRightProvider?.();
		if (!hasVisibleText(label)) return "";
		const decorated = decorateBorderGitStats(sanitizeStatusText(label), {
			mute: this.mutedColor,
			includeLineCounts: !options.omitLineCounts,
		});
		const body = options.compact ? compactFrameLabel(decorated) : decorated;
		return `${this.borderColor(FRAME_LABEL_OPEN)}${body}${this.borderColor(FRAME_RIGHT_CORNER_CLOSE)}`;
	}

	/**
	 * Render the inner editor 2 columns narrower and draw heavy vertical side
	 * borders plus square corners around it. The inner editor applies one column
	 * of horizontal padding, so content sits at `┃ <input> ┃`. Autocomplete lines stay
	 * outside the frame.
	 */
	render(width: number): string[] {
		if (!this.isBorderMode() || width < 3) return super.render(width);

		const innerWidth = width - 2;
		// Host settings override constructor padding after the editor is created,
		// so re-assert it here to keep one column of inner padding in border mode.
		this.setPaddingX(1);
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
	 * Content is shifted one column right by the left border (the inner editor
	 * applies its own horizontal padding), so translate mouse coordinates back.
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
		if (!this.isBorderMode() || width <= 0) return super.renderTopBorder(width, hiddenLineCount);

		const scrollSegment = hiddenLineCount > 0 ? this.borderColor(` ↑ ${hiddenLineCount} more `) : "";
		const borderColor = (text: string) => this.borderColor(text);

		// Keep the model whenever possible. Git totals degrade from the full split
		// form, to the compact split form, to the files-only icon form; if no pair
		// fits, the model wins.
		const fullModelLabel = this.topLeftLabel(false);
		const compactModelLabel = this.topLeftLabel(true);
		// Measure uncolored placeholders so only the selected model variant runs
		// through the stateful working animation renderer.
		const fullModelPlaceholder = fullModelLabel
			? `${FRAME_LEFT_CORNER_OPEN}${fullModelLabel}${FRAME_LABEL_CLOSE}`
			: "";
		const compactModelPlaceholder = compactModelLabel
			? `${FRAME_LEFT_CORNER_OPEN}${compactModelLabel}${FRAME_LABEL_CLOSE}`
			: "";
		const chosen = chooseTopBorderSegments({
			width,
			leftSegments: [fullModelPlaceholder, compactModelPlaceholder],
			rightSegments: [
				this.topRightSegment(),
				this.topRightSegment({ compact: true }),
				this.topRightSegment({ omitLineCounts: true, compact: true }),
			],
			minimumGap: MIN_CORNER_LABEL_GAP,
			visibleWidth,
		});
		const selectedModelLabel =
			chosen.left === fullModelPlaceholder
				? fullModelLabel
				: chosen.left === compactModelPlaceholder
					? compactModelLabel
					: undefined;
		const leftSegment = selectedModelLabel ? this.topLeftSegment(selectedModelLabel) : "";
		const rightSegment = chosen.right;

		const candidates: Array<[string, string]> = [
			[leftSegment, `${scrollSegment}${rightSegment}`],
			[leftSegment, rightSegment],
			[leftSegment, ""],
			["", `${scrollSegment}${rightSegment}`],
			["", rightSegment],
			["", scrollSegment],
		];

		for (const [left, right] of candidates) {
			if (visibleWidth(left) + visibleWidth(right) < width) {
				return renderBorderLine(width, left, right, borderColor);
			}
		}

		return renderBorderLine(width, leftSegment, rightSegment, borderColor);
	}

	renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (!this.isBorderMode() || width <= 0) return super.renderBottomBorder(width, hiddenLineCount);

		const contextLabel = this.bottomLeftProvider?.();
		const statusLabel = this.bottomLeftStatusProvider?.();
		const networkLabel = this.bottomLeftNetworkProvider?.();
		const leftSegment = this.bottomLeftSegment(contextLabel, statusLabel, networkLabel);
		const scrollSegment = hiddenLineCount > 0 ? this.borderColor(` ↓ ${hiddenLineCount} more `) : "";
		const borderColor = (text: string) => this.borderColor(text);
		if (!leftSegment) {
			return renderBorderLine(width, "", scrollSegment, borderColor);
		}

		if (visibleWidth(leftSegment) + visibleWidth(scrollSegment) < width) {
			return renderBorderLine(width, leftSegment, scrollSegment, borderColor);
		}
		if (visibleWidth(leftSegment) < width) {
			return renderBorderLine(width, leftSegment, "", borderColor);
		}
		if (scrollSegment && visibleWidth(scrollSegment) < width) {
			return renderBorderLine(width, "", scrollSegment, borderColor);
		}

		return renderBorderLine(width, "", "", borderColor);
	}

	/**
	 * Combined bottom-left segment. Safe mode and the effective network token
	 * share one label joined by exactly ` · `; context info follows after the
	 * border bridge: `━━ SMART · NET? ━━━ 15.9% 210k `. Composition (including
	 * safe-mode recoloring) lives in the pure `composeBorderBottomLeft` helper.
	 */
	private bottomLeftSegment(contextLabel?: string, statusLabel?: string, networkLabel?: string): string {
		return composeBorderBottomLeft({
			contextLabel,
			statusLabel,
			networkLabel,
			borderColor: (text) => this.borderColor(text),
		});
	}
}

function collectUsage(ctx: ExtensionContext): { input: number; output: number; cacheRead: number; cost: number } {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readCost(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Subagents run with `--no-session`, so their cost is only durable inside the
// parent's persisted tool results (`details.results[].usage.cost`). Children may
// spawn their own subagents, so recurse through the child messages as well.
function collectSubagentCost(ctx: ExtensionContext): number {
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>) {
		if (entry.type !== "message") continue;
		cost += collectSubagentCostFromMessage(entry.message);
	}
	return cost;
}

function collectSubagentCostFromMessage(message: unknown): number {
	if (!isRecord(message) || message.role !== "toolResult") return 0;
	return collectSubagentCostFromDetails(message.details);
}

function collectSubagentCostFromDetails(details: unknown): number {
	if (!isRecord(details) || !Array.isArray(details.results)) return 0;
	let cost = 0;
	for (const result of details.results) {
		if (!isRecord(result)) continue;
		if (isRecord(result.usage)) cost += readCost(result.usage.cost);
		cost += collectSubagentCostFromMessages(result.messages);
	}
	return cost;
}

function collectSubagentCostFromMessages(messages: unknown): number {
	if (!Array.isArray(messages)) return 0;
	let cost = 0;
	for (const message of messages) cost += collectSubagentCostFromMessage(message);
	return cost;
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

// Border (top-left) model label: "provider/model-id (EFFORT)" with alias tables
// applied, id-only when provider is missing. Effort is the abbreviation on wide
// screens and the arrow indicator on narrow ones.
function buildBorderModelLabel(
	ctx: ExtensionContext,
	providerAliases: StatusBarAliasMap,
	modelAliases: StatusBarAliasMap,
	thinkingLevel: string | undefined,
	compactEffort: boolean,
): string | undefined {
	const model = ctx.model;
	if (!model?.id) return undefined;
	const modelLabel = modelAliases[model.id] ?? model.id;
	const providerLabel = model.provider ? (providerAliases[model.provider] ?? model.provider) : undefined;
	const base = providerLabel ? `${providerLabel}/${modelLabel}` : modelLabel;
	if (typeof thinkingLevel !== "string" || !thinkingLevel.trim()) return `${MODEL_DISPLAY_GLYPH}${base}`;
	return `${MODEL_DISPLAY_GLYPH}${base} · ${formatThinkingLevel(thinkingLevel, { compact: compactEffort })}`;
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
	modelAliases: StatusBarAliasMap = {},
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
	const rawModelName = ctx.model?.id;
	const modelName = rawModelName ? (modelAliases[rawModelName] ?? rawModelName) : "no-model";
	const percentLabel = `${roundedPercent.toFixed(1)}%`;

	overrides.set(CONTEXT_WATCHER_IDS.tokens, styleContextLabel(theme, roundedPercent, buildContextTokenLabel(ctx, true)));
	overrides.set(CONTEXT_WATCHER_IDS.model, styleContextLabel(theme, roundedPercent, modelName));
	overrides.set(CONTEXT_WATCHER_IDS.percent, styleContextLabel(theme, roundedPercent, percentLabel));

	return overrides;
}

// First-line token breakdown (new display mode), colored like the status-bar context items.
// The icon is decorated before styling so it shares the label's themed color.
export function buildFirstLineTokenLabel(
	ctx: ExtensionContext,
	theme: { fg: (token: "muted" | "text" | "warning" | "error", text: string) => string },
): string {
	const percent = ctx.getContextUsage()?.percent;
	if (typeof percent !== "number" || !Number.isFinite(percent)) {
		return decorateBorderTotalUsage(buildContextTokenLabel(ctx, false));
	}
	return styleContextLabel(
		theme,
		Number(Math.max(0, percent).toFixed(1)),
		decorateBorderTotalUsage(buildContextTokenLabel(ctx, false)),
	);
}

interface FirstLineEntry {
	content: string;
	section: StatusBarSection;
	priority: number;
	order: number;
}

interface RowEntry {
	content: string;
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

function isRowSetPayload(value: unknown): value is StatusBarRowSetPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<StatusBarRowSetPayload>;
	if (typeof maybe.id !== "string") return false;
	if (typeof maybe.content !== "string") return false;
	if (maybe.order !== undefined && typeof maybe.order !== "number") return false;
	return true;
}

function isRowClearPayload(value: unknown): value is StatusBarRowClearPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<StatusBarRowClearPayload>;
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

/** Bouncing highlight position and its direction of travel. */
interface BounceState {
	index: number;
	/** `1` while moving right, `-1` while moving left. */
	direction: 1 | -1;
}

/** Inclusive random integer in `[min, max]`. */
function randomInt(min: number, max: number): number {
	return min + Math.floor(Math.random() * (max - min + 1));
}

/** Ping-pong state driven by a monotonically increasing tick. */
function bounceState(length: number, tick: number): BounceState {
	if (length <= 1) return { index: 0, direction: 1 };
	const period = 2 * (length - 1);
	const position = ((tick % period) + period) % period;
	if (position < length) return { index: position, direction: 1 };
	return { index: period - position, direction: -1 };
}

interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** Theme color token for each thinking level (the editor border color). */
const THINKING_COLOR_TOKENS: Record<string, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

function rgbFrom256(index: number): Rgb {
	if (index < 16) {
		const system: Rgb[] = [
			{ r: 0, g: 0, b: 0 },
			{ r: 128, g: 0, b: 0 },
			{ r: 0, g: 128, b: 0 },
			{ r: 128, g: 128, b: 0 },
			{ r: 0, g: 0, b: 128 },
			{ r: 128, g: 0, b: 128 },
			{ r: 0, g: 128, b: 128 },
			{ r: 192, g: 192, b: 192 },
			{ r: 128, g: 128, b: 128 },
			{ r: 255, g: 0, b: 0 },
			{ r: 0, g: 255, b: 0 },
			{ r: 255, g: 255, b: 0 },
			{ r: 0, g: 0, b: 255 },
			{ r: 255, g: 0, b: 255 },
			{ r: 0, g: 255, b: 255 },
			{ r: 255, g: 255, b: 255 },
		];
		return system[index] ?? { r: 0, g: 0, b: 0 };
	}
	if (index < 232) {
		const steps = [0, 95, 135, 175, 215, 255];
		const i = index - 16;
		return { r: steps[Math.floor(i / 36)]!, g: steps[Math.floor(i / 6) % 6]!, b: steps[i % 6]! };
	}
	const level = 8 + (index - 232) * 10;
	return { r: level, g: level, b: level };
}

/** Parse an ANSI foreground escape (truecolor or 256-color) back to RGB. */
function parseAnsiRgb(ansi: string): Rgb | undefined {
	const truecolor = /38;2;(\d+);(\d+);(\d+)/.exec(ansi);
	if (truecolor) return { r: Number(truecolor[1]), g: Number(truecolor[2]), b: Number(truecolor[3]) };
	const indexed = /38;5;(\d+)/.exec(ansi);
	if (indexed) return rgbFrom256(Number(indexed[1]));
	return undefined;
}

function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
	const clamped = Math.max(0, Math.min(1, t));
	return {
		r: Math.round(from.r + (to.r - from.r) * clamped),
		g: Math.round(from.g + (to.g - from.g) * clamped),
		b: Math.round(from.b + (to.b - from.b) * clamped),
	};
}

function fgRgb(rgb: Rgb, text: string): string {
	return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[39m`;
}

function isDisplayMode(value: unknown): value is StatusBarDisplayMode {
	return typeof value === "string" && (STATUS_BAR_DISPLAY_MODES as readonly string[]).includes(value);
}

function readSettingsFile(): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(STATUS_BAR_SETTINGS_PATH, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Missing or invalid settings file.
	}
	return {};
}

function normalizeAliasMap(value: unknown): StatusBarAliasMap {
	const aliases: StatusBarAliasMap = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return aliases;
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === "string" && raw.trim()) aliases[key] = raw.trim();
	}
	return aliases;
}

// Exact-name alias tables (no pattern matching). Configured under
// `providerAliases` / `modelAliases` in ~/.pi/agent/status-bar.json.
function loadAliases(): StatusBarAliasConfig {
	const settings = readSettingsFile();
	return {
		providerAliases: normalizeAliasMap(settings.providerAliases),
		modelAliases: normalizeAliasMap(settings.modelAliases),
	};
}

function normalizeDisplayMode(value: unknown): StatusBarDisplayMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return isDisplayMode(normalized) ? normalized : undefined;
}

function normalizeWorkingAnimation(value: unknown): WorkingAnimation | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return (WORKING_ANIMATIONS as readonly string[]).includes(normalized)
		? (normalized as WorkingAnimation)
		: undefined;
}

function loadWorkingAnimation(): WorkingAnimation {
	return normalizeWorkingAnimation(process.env.PI_STATUS_BAR_WORKING_ANIMATION) ?? WORKING_ANIMATION;
}

function loadDisplayMode(): StatusBarDisplayMode {
	const fromEnv = normalizeDisplayMode(process.env.PI_STATUS_BAR_DISPLAY_MODE);
	if (fromEnv) return fromEnv;

	try {
		const parsed = JSON.parse(readFileSync(STATUS_BAR_SETTINGS_PATH, "utf-8")) as { displayMode?: unknown } | null;
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
			const parsed = JSON.parse(readFileSync(STATUS_BAR_SETTINGS_PATH, "utf-8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		} catch {
			// New or unreadable file: start from an empty object.
		}

		mkdirSync(dirname(STATUS_BAR_SETTINGS_PATH), { recursive: true });
		tempPath = `${STATUS_BAR_SETTINGS_PATH}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tempPath, `${JSON.stringify({ ...existing, displayMode: mode }, null, 2)}\n`, "utf-8");
		renameSync(tempPath, STATUS_BAR_SETTINGS_PATH);
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
			error: `Failed to save ${STATUS_BAR_SETTINGS_PATH}: ${error instanceof Error ? error.message : String(error)}`,
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

function formatAliasSummary(aliases: StatusBarAliasMap): string {
	const entries = Object.entries(aliases);
	if (entries.length === 0) return "(none)";
	return entries.map(([from, to]) => `${from}->${to}`).join(", ");
}

async function showStatusBarContractUI(
	ctx: ExtensionContext,
	displayMode: StatusBarDisplayMode,
	aliases: StatusBarAliasConfig,
): Promise<void> {
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
		{
			id: "alias-providers",
			label: "Provider aliases",
			value: formatAliasSummary(aliases.providerAliases),
			description: "Exact provider id -> short label for the border provider/model label.",
		},
		{
			id: "alias-models",
			label: "Model aliases",
			value: formatAliasSummary(aliases.modelAliases),
			description: "Exact model id -> short label, applied wherever the model is shown.",
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
	const rowById = new Map<string, RowEntry>();
	let firstLineOrderCounter = 0;
	let rowOrderCounter = 0;
	let displayMode: StatusBarDisplayMode = loadDisplayMode();
	const workingAnimation = loadWorkingAnimation();
	const { providerAliases, modelAliases } = loadAliases();
	let lastContext: ExtensionContext | undefined;
	let footerOwnerContext: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let editorOwnerContext: ExtensionContext | undefined;
	let requestEditorRender: (() => void) | undefined;
	let frameEditor: FrameStatusEditor | undefined;
	const ansiRgbCache = new Map<string, Rgb | undefined>();
	const ansiRgb = (ansi: string): Rgb | undefined => {
		if (ansiRgbCache.has(ansi)) return ansiRgbCache.get(ansi);
		const rgb = parseAnsiRgb(ansi);
		ansiRgbCache.set(ansi, rgb);
		return rgb;
	};
	let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

	const activeLayout = (): StatusBarLayout =>
		displayMode === "new" ? BORDER_PRIORITY_STATUS_BAR_LAYOUT : DEFAULT_STATUS_BAR_LAYOUT;

	const renderSection = (
		ids: string[],
		overrides?: Map<string, string | undefined>,
		joinSeparator: string = STATUS_BAR_JOIN_SEPARATOR,
	): string | undefined => composeSectionItems(ids, (id) => contentById.get(id), joinSeparator, overrides);

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

	// In `new` mode the repo dirty totals live on the editor frame top-right, so
	// they are hidden from the first line to avoid duplication.
	const isFirstLineSuppressed = (id: string): boolean => displayMode === "new" && id === REPO_STATS_ID;

	const renderFirstLineSection = (
		section: StatusBarSection,
		joinSeparator: string = STATUS_BAR_JOIN_SEPARATOR,
		attensionCoreSuffix?: string,
	): string | undefined => {
		const items = [...firstLineById.entries()]
			.filter(
				([id, entry]) =>
					entry.section === section && hasVisibleText(entry.content) && !isFirstLineSuppressed(id),
			)
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
		for (const [id, entry] of firstLineById.entries()) {
			if (hasVisibleText(entry.content) && !isFirstLineSuppressed(id)) return true;
		}
		return false;
	};

	const requestRender = (): void => {
		requestFooterRender?.();
		requestEditorRender?.();
	};

	// Live cache of the effective network state from permissions-core. `current`
	// is `undefined` when the core is absent, so no token is rendered. Live
	// `changed` events win over slower in-flight queries (see network.ts).
	const networkStore = new NetworkStateStore({ events: pi.events, onChange: requestRender });

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
					if (displayMode === "new") {
						pwd = decorateBorderPathBranch({ path: pwd, branch });
					} else if (branch) {
						pwd = `${pwd} (${branch})`;
					}
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
					const contextOverrides =
						layout.right.length > 0 ? getContextWatcherOverrides(activeCtx, theme, modelAliases) : undefined;

					let joinSeparator = theme.fg("muted", STATUS_BAR_JOIN_SEPARATOR);
					// Network token: on the status line in `legacy` mode, on the border in
					// `new` mode. Exactly one surface renders it, so there is no duplication.
					const networkResolution = resolveNetworkStatus({ displayMode, state: networkStore.current, theme });
					const networkStatusLabel =
						networkResolution?.surface === "status-line" ? networkResolution.label : undefined;
					// Safe mode and the network token always share one item joined by exactly
					// ` · ` (here `networkSeparator`), so a crowded line switching to the compact
					// separator cannot collapse that dot.
					const renderLeft = (
						itemSeparator: string,
						extraOverrides?: Map<string, string | undefined>,
					): string | undefined =>
						composeLegacyLeftSection({
							ids: layout.left,
							getContent: (id) => contentById.get(id),
							networkLabel: networkStatusLabel,
							networkSeparator: theme.fg("muted", STATUS_BAR_JOIN_SEPARATOR),
							itemSeparator,
							safeModeId: SAFE_MODE_ID,
							overrides: extraOverrides,
						});
					let left = renderLeft(joinSeparator);
					let center = renderSection(layout.center, undefined, joinSeparator);
					let right = renderSection(layout.right, contextOverrides, joinSeparator);

					if (isCrowded(width, left, center, right)) {
						joinSeparator = theme.fg("muted", COMPACT_ITEM_JOIN_SEPARATOR);
						left = renderLeft(joinSeparator);
						center = renderSection(layout.center, undefined, joinSeparator);
						right = renderSection(layout.right, contextOverrides, joinSeparator);
					}

					const hasThinkingSection = layout.left.includes(SWITCH_THINKING_ID);
					const activeThinking = contentById.get(SWITCH_THINKING_ACTIVE_ID);
					const needCompactThinking = hasThinkingSection && hasVisibleText(activeThinking) && isCrowded(width, left, center, right);

					if (needCompactThinking) {
						left = renderLeft(joinSeparator, new Map([[SWITCH_THINKING_ID, activeThinking]]));
					}

					const line2 = renderThreeSectionLine(width, left, center, right);
					const lines = line2.length > 0 ? [line1, line2] : [line1];
					for (const entry of [...rowById.values()].sort((a, b) => a.order - b.order)) {
						const content = sanitizeStatusText(entry.content);
						if (!hasVisibleText(content)) continue;
						lines.push(truncateToWidth(content, width, theme.fg("dim", "...")));
					}
					return lines;
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
			bottomLeft: () => buildFrameContextLabel(activeContext(), activeContext().ui.theme),
			bottomLeftStatus: () => contentById.get(SAFE_MODE_ID),
			bottomLeftNetwork: () => {
				const resolution = resolveNetworkStatus({
					displayMode,
					state: networkStore.current,
					theme: activeContext().ui.theme,
				});
				return resolution?.surface === "border" ? resolution.label : undefined;
			},
			topLeft: (opts) =>
				buildBorderModelLabel(
					activeContext(),
					providerAliases,
					modelAliases,
					pi.getThinkingLevel(),
					opts?.compact ?? false,
				),
			topRight: () => firstLineById.get(REPO_STATS_ID)?.content,
			getWorkingAnimation: () => workingAnimation,
			mutedColor: (text) => activeContext().ui.theme.fg("muted", text),
			highlightColor: (text, depth) => {
				const theme = activeContext().ui.theme;
				if (depth <= 0) return theme.bold(theme.fg("text", text));
				const lead = ansiRgb(theme.getFgAnsi("text"));
				const baseToken = THINKING_COLOR_TOKENS[pi.getThinkingLevel()] ?? "thinkingOff";
				const base = ansiRgb(theme.getFgAnsi(baseToken));
				if (!lead || !base) {
					if (depth === 1) return theme.fg("text", text);
					if (depth === 2) return theme.fg("muted", text);
					return theme.fg("dim", text);
				}
				// Fade the trail from the bright lead into the label's own border color.
				return fgRgb(mixRgb(lead, base, depth / (WORKING_TRAIL_LENGTH + 1)), text);
			},
		};

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			requestEditorRender = () => tui.requestRender();
			frameEditor = new FrameStatusEditor(tui, editorTheme, keybindings, options);
			return frameEditor;
		});

		editorOwnerContext = ctx;
	};

	/**
	 * Configure pi's working spinner. In `new` mode the top-left label renders its
	 * own bouncing highlight, so hide pi's built-in spinner to avoid a second
	 * animation; other modes keep pi's default animated spinner.
	 */
	const applyWorkingIndicator = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingIndicator(displayMode === "new" ? { frames: [] } : undefined);
	};

	const bindContextAndRender = (ctx: ExtensionContext): void => {
		lastContext = ctx;
		if (ctx.hasUI) {
			installFooter(ctx);
			installEditorFrameStatus(ctx);
			applyWorkingIndicator(ctx);
		}
		requestRender();
	};

	pi.on("session_start", async (_event, ctx) => {
		// Only an active session may apply live network `changed` events.
		networkStore.activate();
		bindContextAndRender(ctx);
		// Refresh in the background; a live `changed` event also updates state.
		void networkStore.refresh();
	});

	pi.on("session_tree", async (_event, ctx) => {
		networkStore.activate();
		bindContextAndRender(ctx);
		void networkStore.refresh();
	});

	const refreshOnEvent = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		lastContext = ctx;
		requestRender();
	};

	pi.on("session_compact", refreshOnEvent);
	pi.on("model_select", refreshOnEvent);
	pi.on("turn_start", refreshOnEvent);
	pi.on("turn_end", refreshOnEvent);
	pi.on("agent_start", refreshOnEvent);
	pi.on("agent_end", refreshOnEvent);
	pi.on("message_start", refreshOnEvent);
	pi.on("message_update", refreshOnEvent);
	pi.on("message_end", refreshOnEvent);
	pi.on("input", refreshOnEvent);
	pi.on("user_bash", refreshOnEvent);

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setFooter(undefined);
			ctx.ui.setWorkingIndicator();
		}
		if (footerOwnerContext === ctx) {
			footerOwnerContext = undefined;
		}
		if (editorOwnerContext === ctx) {
			frameEditor?.stopWorkingAnimation();
			frameEditor = undefined;
			if (ctx.hasUI) ctx.ui.setEditorComponent(previousEditorFactory);
			editorOwnerContext = undefined;
			previousEditorFactory = undefined;
			requestEditorRender = undefined;
		}
		if (lastContext === ctx) {
			lastContext = undefined;
		}
		// Drop stale network state and deactivate so late `changed` events after
		// shutdown cannot restore the previous session's effective policy.
		networkStore.deactivate();
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

	pi.events.on(STATUS_BAR_EVENTS.rowSet, (payload) => {
		if (!isRowSetPayload(payload)) return;
		const existing = rowById.get(payload.id);
		const order = Number.isFinite(payload.order) ? (payload.order as number) : (existing?.order ?? rowOrderCounter++);
		rowById.set(payload.id, { content: payload.content, order });
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.rowClear, (payload) => {
		if (!isRowClearPayload(payload)) return;
		rowById.delete(payload.id);
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.ping, (payload) => {
		if (!isPingPayload(payload)) return;
		pi.events.emit(STATUS_BAR_EVENTS.pong, { id: payload.id });
	});

	pi.registerCommand("px:status-bar-contract", {
		description: "Open a read-only status-bar contract settings view",
		handler: async (_args, ctx) => {
			bindContextAndRender(ctx);
			if (!ctx.hasUI) return;
			await showStatusBarContractUI(ctx, displayMode, { providerAliases, modelAliases });
		},
	});

	pi.registerCommand("px:status-bar-display-mode", {
		description: "Set status-bar display mode: /px:status-bar-display-mode new|legacy",
		handler: async (args, ctx) => {
			const requested = normalizeDisplayMode(args ?? "");
			if (!requested) {
				if (ctx.hasUI) {
					ctx.ui.notify(`status-bar display mode: ${displayMode} (usage: /px:status-bar-display-mode new|legacy)`, "info");
				}
				return;
			}

			displayMode = requested;
			bindContextAndRender(ctx);

			const saved = saveDisplayMode(requested);
			if (!ctx.hasUI) return;
			// `=== false` (rather than a truthiness check) keeps the discriminated
			// union narrowing working without `--strictNullChecks`.
			if (saved.ok === false) {
				ctx.ui.notify(`status-bar display mode: ${requested} (${saved.error})`, "warning");
			} else {
				ctx.ui.notify(`status-bar display mode: ${requested}`, "info");
			}
		},
	});

	pi.registerCommand("px:status-bar-set", {
		description: "Dev helper: /px:status-bar-set <id> <content>",
		handler: async (args, ctx) => {
			const parsed = parseSetArgs(args ?? "");
			if (!parsed) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /px:status-bar-set <id> <content>", "warning");
				return;
			}
			bindContextAndRender(ctx);
			pi.events.emit(STATUS_BAR_EVENTS.set, parsed);
		},
	});

	pi.registerCommand("px:status-bar-clear", {
		description: "Dev helper: /px:status-bar-clear <id>",
		handler: async (args, ctx) => {
			const parsed = parseClearArgs(args ?? "");
			if (!parsed) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /px:status-bar-clear <id>", "warning");
				return;
			}
			bindContextAndRender(ctx);
			pi.events.emit(STATUS_BAR_EVENTS.clear, parsed);
		},
	});
}
