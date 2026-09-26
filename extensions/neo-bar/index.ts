import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	BORDER_PRIORITY_NEO_BAR_LAYOUT,
	DEFAULT_NEO_BAR_DISPLAY_MODE,
	DEFAULT_NEO_BAR_LAYOUT,
	NEO_BAR_DISPLAY_MODES,
	NEO_BAR_INPUT_MODES,
	STATUS_BAR_EVENTS,
	NEO_BAR_JOIN_SEPARATOR,
	type NeoBarAliasConfig,
	type NeoBarAliasMap,
	type NeoBarClearPayload,
	type NeoBarDisplayMode,
	type NeoBarFirstLineClearPayload,
	type NeoBarFirstLineSetPayload,
	type NeoBarInputMode,
	type NeoBarInputModeSetPayload,
	type NeoBarLayout,
	type NeoBarPingPayload,
	type NeoBarRewireSetPayload,
	type NeoBarReviewLevel,
	type NeoBarReviewLevelSetPayload,
	type NeoBarSubagentDepthSetPayload,
	type NeoBarRowClearPayload,
	type NeoBarRowSetPayload,
	type NeoBarSection,
	type NeoBarSetPayload,
} from "./contract";
import {
	BORDER_CONTEXT_ICON,
	BORDER_MESSAGE_ICON,
	chooseTopBorderSegments,
	composeBorderBottomLeft,
	composeLegacyLeftSection,
	composeTopLeftModelReview,
	composeSectionItems,
	decorateBorderContextCost,
	decorateBorderGitStats,
	decorateBorderPathBranch,
	decorateBorderTotalUsage,
	estimateMessageTokens,
	FRAME_LABEL_CLOSE,
	FRAME_LABEL_OPEN,
	FRAME_LEFT_CORNER_OPEN,
	FRAME_RIGHT_CORNER_CLOSE,
	formatRewireStatusLabel,
	hasVisibleText,
	sanitizeStatusText,
} from "./compose";
import {
	collectGitSnapshot,
	dirtyStats,
	formatGitStatsText,
	type GitStats,
	GitStatsWatcher,
	renderGitStatsLabel,
} from "./git-stats";
import { createProtectedInterrupt, InterruptConfirmationGuard, showInterruptConfirmation } from "./interrupt-confirmation";
import { deepseekImageTokens, findImagePaths, parseImageDimensions } from "./image-tokens";
import { NetworkStateStore, resolveNetworkStatus } from "./network";
import { formatProgressRow, ProgressObserver } from "./progress";
import {
	countLoadedSkills,
	countSessionSkills,
	renderSkillStatsLabel,
	type SkillStats,
	SkillStatsTracker,
} from "./skill-stats";

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
// Git dirty totals are collected internally (git-stats.ts) and rendered on the
// editor frame's top-right corner in `new` mode. In `legacy` mode they keep the
// first-line right section, ordered like a producer at this priority.
const GIT_STATS_ID = "git-stats";
const GIT_STATS_FIRST_LINE_PRIORITY = 100;
// Read-skill counter, also collected internally (skill-stats.ts). It always
// renders on the first line right section, ordered behind the other items.
const SKILL_STATS_ID = "skill-stats";
const SKILL_STATS_FIRST_LINE_PRIORITY = -100;
// The standalone `repo-stats` and `skill-stats` extensions were folded in here.
// Their ids are ignored on the first line so a stale installed copy cannot
// duplicate the counters.
const SUPERSEDED_FIRST_LINE_IDS = new Set(["repo-stats", "skill-stats"]);
const REWIRE_STATUS_ID = "subagent-rewire";
const REWIRE_FIRST_LINE_PRIORITY = -50; // Immediately before skill-stats (-100).
const SUBAGENT_DEPTH_ICON = "󰚩";
const REVIEW_LEVEL_ICONS: Record<NeoBarReviewLevel, string> = {
	auto: "󰈈",
	off: "󰛑",
	minimal: "󱀧",
	normal: "󰛐",
	high: "󰡬",
};
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

const FRAME_CORNER_STYLES = ["round", "square"] as const;
type FrameCornerStyle = (typeof FRAME_CORNER_STYLES)[number];
// Source-level default for the editor frame corners. Override for a quick preview
// with `PI_STATUS_BAR_FRAME_CORNERS=round|square`.
const FRAME_CORNER_STYLE: FrameCornerStyle = "round";

// Heavy editor frame with light arc corners. Unicode has no heavy arcs, but the
// arc is short enough that the weight step is barely visible, and the frame reads
// as rounded. `square` restores the weight-matched heavy square corners.
const FRAME_BORDERS = {
	round: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", vertical: "┃" },
	square: { topLeft: "┏", topRight: "┓", bottomLeft: "┗", bottomRight: "┛", vertical: "┃" },
} as const;
// Resolved once at load: the frame style is a visual constant, not a runtime toggle.
const ACTIVE_FRAME_CORNER_STYLE = loadFrameCornerStyle();
const FRAME_BORDER = FRAME_BORDERS[ACTIVE_FRAME_CORNER_STYLE];

// The frame line is heavy, but wherever it touches a corner label the glyph
// tapers so the light half faces the text.
const FRAME_LINE = "━";
/** Light on the left, heavy on the right: the line resumes after a label. */
const FRAME_LINE_AFTER_LABEL = "╼";
/** Heavy on the left, light on the right: the line ends at a label. */
const FRAME_LINE_BEFORE_LABEL = "╾";
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

// The editor frame shows the full thinking level name, never an abbreviation
// or arrow shortcut.
function formatThinkingLevel(level: string | undefined): string {
	if (typeof level !== "string") return "---";
	const normalized = level.trim().toLowerCase();
	if (!normalized) return "---";
	return normalized;
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

// Bottom-border context usage + cost, kept separate so a narrow frame can keep the
// usage meter on the border and relocate only the cost to status line 2.
interface FrameContextParts {
	/** Context usage meter, e.g. `󰊚 15.9% 210k`. Always shown on the border. */
	usage: string;
	/** Cost, e.g. `󰇁 0.03` or `󰇁 0.03 Tot󰇁 0.034`. Relocated on narrow frames. */
	cost: string;
	/** Separator between usage and cost, colored like the meter so the dot never shows as white. */
	separator: string;
}

// Uses the subdued accent for the first bucket; higher usage follows the neo-bar context colors.
export function buildFrameContextParts(
	ctx: ExtensionContext,
	theme?: {
		fg: (token: ThemeColor, text: string) => string;
		getFgAnsi: (token: ThemeColor) => string;
	},
): FrameContextParts {
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

	const usageLabel = `${BORDER_CONTEXT_ICON}${percent} ${tokens}`;
	const costText = decorateBorderContextCost(costLabel);
	const separator = " · ";
	if (!theme || percentValue === undefined) return { usage: usageLabel, cost: costText, separator };

	const firstBucket = (text: string) => styleDarkAccent(theme, text);
	const styledUsage = styleContextLabel(theme, Number(percentValue.toFixed(1)), usageLabel, firstBucket);
	const styledCost = styleContextLabel(theme, Number(percentValue.toFixed(1)), costText, firstBucket);
	const styledSeparator = styleContextLabel(theme, Number(percentValue.toFixed(1)), separator, firstBucket);
	return { usage: styledUsage, cost: styledCost, separator: styledSeparator };
}

type FrameStatusProvider = (options?: { compact?: boolean }) => string | undefined;

/**
 * Border labels that no longer fit on a narrow editor frame. The editor clears
 * them while the full label fits and fills them when it relocates the label to
 * status line 2. The editor renders before the footer, so the footer reads the
 * same-frame decision.
 */
interface RelocatedBorderLabels {
	/** Git dirty totals moved off the top-right border. */
	gitStats?: GitStats;
	/** Cost label moved off the bottom-left border (the usage meter stays). */
	contextLabel?: string;
}

interface FrameStatusEditorOptions {
	/** Current display mode; `legacy` disables all border labels and the side frame. */
	getDisplayMode: () => NeoBarDisplayMode;
	/** Bottom-left context usage + cost, split so only the cost relocates on narrow frames. */
	bottomLeft?: () => FrameContextParts | undefined;
	/** Secondary bottom-left label (safe-mode status), rendered after `bottomLeft`. */
	bottomLeftStatus?: FrameStatusProvider;
	/** Effective network token, rendered immediately after the safe-mode status. */
	bottomLeftNetwork?: FrameStatusProvider;
	/** Effective subagent depth policy, rendered immediately after the network token. */
	bottomLeftSubagent?: FrameStatusProvider;
	/** Top-left corner label (active provider/model plus effort), with the working highlight while streaming. */
	topLeft?: FrameStatusProvider;
	/** Recommended review level, rendered after the top-left model effort. */
	topLeftReview?: FrameStatusProvider;
	/** Dirty counters rendered as the top-right corner label. */
	topRightGitStats?: () => GitStats | undefined;
	/** Bottom-right corner label (unsent message token size). Receives the current editor text. */
	bottomRight?: (text: string) => string | undefined;
	/** Sink for labels relocated off the border on narrow frames (status line 2). */
	relocatedLabels?: RelocatedBorderLabels;
	/** Streaming animation style for the top-left model label. */
	getWorkingAnimation: () => WorkingAnimation;
	/** Confirmation guard used before an active agent operation is interrupted. */
	interruptConfirmation: InterruptConfirmationGuard;
	/** Subdued accent color used for the border's default-color indicators. */
	subduedColor?: (text: string) => string;
	/** Dim shutter stripes and muted rules inside the locked panel. */
	lockedStripeColor?: (text: string) => string;
	lockedRuleColor?: (text: string) => string;
	/**
	 * Color for the working highlight. `depth` 0 is the leading character
	 * (brightest); higher depths are the trailing fade behind the direction of motion.
	 */
	highlightColor?: (text: string, depth: number) => string;
	/** Frame line color while normal mode holds keyboard keys back. Defaults to the accent. */
	dimColor?: (text: string) => string;
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
		return borderColor(FRAME_LINE.repeat(width));
	}

	if (leftWidth + rightWidth >= width) {
		if (leftWidth > 0) return truncateToWidth(leftSegment, width, "");
		return truncateToWidth(rightSegment, width, "");
	}

	// The filler starts and ends with a tapered glyph whenever a label sits on
	// that side, so the heavy line stays thin where it touches the text. Both
	// transitions replace heavy dashes, so the total width is unchanged.
	const lead = leftWidth > 0 ? FRAME_LINE_AFTER_LABEL : "";
	const tail = rightWidth > 0 ? FRAME_LINE_BEFORE_LABEL : "";
	const fill = width - leftWidth - rightWidth;
	if (fill < lead.length + tail.length) {
		return `${leftSegment}${borderColor("─".repeat(fill))}${rightSegment}`;
	}
	const filler = lead + FRAME_LINE.repeat(fill - lead.length - tail.length) + tail;
	return `${leftSegment}${borderColor(filler)}${rightSegment}`;
}

/** Maximum number of lines the fallback progress block may occupy. */
export const PROGRESS_MAX_LINES = 3;

/**
 * Wrap plain progress text to at most `maxLines` lines. When the text needs
 * more lines, the final line is truncated and suffixed with `...`.
 */
export function wrapProgressText(text: string, width: number, maxLines: number): string[] {
	if (width <= 0 || maxLines <= 0) return [];
	const wrapped = wrapTextWithAnsi(text, width).filter((line) => line.length > 0);
	if (wrapped.length <= maxLines) return wrapped;
	const head = wrapped.slice(0, maxLines - 1);
	const tail = `${truncateToWidth(wrapped[maxLines - 1] ?? "", Math.max(0, width - 3), "")}...`;
	return [...head, tail];
}

/** Center an ANSI-styled progress line within `width` without trailing padding. */
export function centerProgressLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width, "");
	const padding = Math.max(0, Math.floor((width - visibleWidth(truncated)) / 2));
	return `${" ".repeat(padding)}${truncated}`;
}

/**
 * Footer lines for the progress text, rendered directly above the status bar's
 * first line (line `-1`). Prefers the full text, then the compact (abbreviated)
 * form, then wraps to at most {@link PROGRESS_MAX_LINES} lines with a trailing
 * `...`.
 */
export function progressFooterLines(args: {
	width: number;
	full: string;
	compact?: string;
}): string[] {
	if (args.width <= 0) return [];
	if (visibleWidth(args.full) <= args.width) return [args.full];

	const shortened = args.compact && args.compact.length > 0 ? args.compact : args.full;
	if (visibleWidth(shortened) <= args.width) return [shortened];

	return wrapProgressText(shortened, args.width, PROGRESS_MAX_LINES);
}

/** The editor's zero-width hardware-cursor marker (pi-tui scans for it). */
const CURSOR_MARKER = "\u001B_pi:c\u0007";
// The editor draws its text cursor as reverse video, closed by SGR 0.
const REVERSE_VIDEO_CURSOR = /\x1b\[7m([^\x1b]*)\x1b\[0m/g;

/**
 * Remove the text cursor from already-rendered editor lines: no hardware-cursor
 * marker (so the TUI hides the terminal cursor) and no reverse-video block (so
 * an editor that ignores keys stops looking typeable). Width is unchanged.
 */
export function stripEditorCursor(lines: readonly string[]): string[] {
	return lines.map((line) => line.split(CURSOR_MARKER).join("").replace(REVERSE_VIDEO_CURSOR, "$1\x1b[0m"));
}

/**
 * Default editor with heavy borders and rounded arc corners, plus status labels
 * rendered in the frame corners. In `new` display mode the top-left corner shows
 * the active provider/model plus effort (abbreviation, or arrows-only on narrow screens)
 * and the top-right corner shows the git dirty totals. While streaming, the
 * label runs the configured animation
 * (`comet` or `glitch`; no spinner, no `Working` word). Editor content is inset
 * by one column on each side
 * (`┃ <input> ┃`):
 *
 * ```
 * ╭━╾ 󰙴 cdx/5.6-sol · high ╼━━╾ 󰐖 1 󰍵 2 󰦓 4 · 󰐖 150 󰍵 200 ╼━╮
 * ┃ ... input ...                                  ┃
 * ╰━╾ SMART · 󰅟 ✓? · 󰚩 ✓ ╼━╾ 15.9% 210k · 0.03$ ╼━━━━━╯
 * ```
 */
export class FrameStatusEditor extends CustomEditor {
	private locked = false;
	private readonly getDisplayMode: () => NeoBarDisplayMode;
	private readonly bottomLeftProvider?: () => FrameContextParts | undefined;
	private readonly bottomLeftStatusProvider?: FrameStatusProvider;
	private readonly bottomLeftNetworkProvider?: FrameStatusProvider;
	private readonly bottomLeftSubagentProvider?: FrameStatusProvider;
	private readonly topLeftProvider?: FrameStatusProvider;
	private readonly topLeftReviewProvider?: FrameStatusProvider;
	private readonly topRightGitStats?: () => GitStats | undefined;
	private readonly bottomRightProvider?: (text: string) => string | undefined;
	private readonly relocatedLabels?: RelocatedBorderLabels;
	private readonly getWorkingAnimation: () => WorkingAnimation;
	private readonly subduedColor?: (text: string) => string;
	private readonly lockedStripeColor: (text: string) => string;
	private readonly lockedRuleColor: (text: string) => string;
	private readonly highlightColor?: (text: string, depth: number) => string;
	/**
	 * pi assigns `borderColor` after construction (the thinking-level color) and
	 * updates it when the level changes. Remember the latest non-dim value here so
	 * normal mode can dim the frame and restore the accent afterwards.
	 */
	private lastAccent: ((text: string) => string) | undefined;
	/** Frame line color while normal mode holds keys back. */
	private readonly dimColor: (text: string) => string;
	/** Current vim input mode; `undefined` when vim-mode is off. */
	private inputMode: NeoBarInputMode | undefined;
	private readonly frameTui: TUI;
	private working = false;
	private workingTick = 0;
	private workingTimer?: ReturnType<typeof setInterval>;
	private readonly interruptConfirmation: InterruptConfirmationGuard;
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
		this.bottomLeftSubagentProvider = options.bottomLeftSubagent;
		this.topLeftProvider = options.topLeft;
		this.topLeftReviewProvider = options.topLeftReview;
		this.topRightGitStats = options.topRightGitStats;
		this.bottomRightProvider = options.bottomRight;
		this.relocatedLabels = options.relocatedLabels;
		this.getWorkingAnimation = options.getWorkingAnimation;
		this.interruptConfirmation = options.interruptConfirmation;
		this.subduedColor = options.subduedColor;
		this.lockedStripeColor = options.lockedStripeColor ?? ((text) => this.borderColor(text));
		this.lockedRuleColor = options.lockedRuleColor ?? ((text) => this.borderColor(text));
		this.highlightColor = options.highlightColor;
		this.dimColor = options.dimColor ?? theme.borderColor;
	}

	setLocked(locked: boolean): void {
		this.locked = locked;
		this.frameTui.requestRender();
	}

	/** Publish the editor input mode; `normal` dims the frame and hides the cursor. */
	setInputMode(mode: NeoBarInputMode | undefined): void {
		this.inputMode = mode;
		this.frameTui.requestRender();
	}

	private isInputInactive(): boolean {
		return this.inputMode === "normal";
	}

	/** Accent used for frame labels; stays purple while the frame line dims. */
	private labelColor(text: string): string {
		return (this.lastAccent ?? this.borderColor)(text);
	}

	/** Wrap pi's dynamic interrupt callback after the editor has been installed. */
	protectInterrupt(): void {
		if (!this.onEscape) throw new Error("neo-bar: pi did not wire the editor interrupt handler");
		this.onEscape = createProtectedInterrupt(this.onEscape, this.interruptConfirmation);
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

		const highlight = this.highlightColor ?? ((text: string) => this.labelColor(text));

		if (this.working && this.getWorkingAnimation() === "glitch") {
			// Drop cells that no longer point at a character (e.g. after a model switch).
			for (const index of this.glitchCells.keys()) {
				if (index >= chars.length) this.glitchCells.delete(index);
			}
			return chars
				.map((ch, i) => {
					const cell = this.glitchCells.get(i);
					if (!cell) return this.labelColor(ch);
					return highlight(cell.glyph, WORKING_GLITCH_DEPTH[cell.glyph] ?? 0);
				})
				.join("");
		}

		const bounce = this.working ? bounceState(chars.length, this.workingTick) : undefined;
		return chars
			.map((ch, i) => {
				if (!bounce) return this.labelColor(ch);
				const depth = (bounce.index - i) * bounce.direction;
				return depth >= 0 && depth <= WORKING_TRAIL_LENGTH ? highlight(ch, depth) : this.labelColor(ch);
			})
			.join("");
	}

	/** Resolve the top-left model/effort label. */
	private topLeftLabel(): string | undefined {
		const label = this.topLeftProvider?.();
		return hasVisibleText(label) ? label : undefined;
	}

	/**
	 * Top-left corner label: model plus effort inset from the corner by `━━ `.
	 * While streaming the label runs the configured animation.
	 */
	private topLeftSegment(label: string, reviewLabel?: string): string {
		const body = composeTopLeftModelReview(this.renderModelLabel(label), reviewLabel, (text) => this.labelColor(text));
		return `${this.borderColor(FRAME_LEFT_CORNER_OPEN)}${body}${this.borderColor(FRAME_LABEL_CLOSE)}`;
	}

	/**
	 * Top-right corner label: git dirty totals in the full split form. On a narrow
	 * frame the totals no longer fit, so the editor drops them here and relocates
	 * them to status line 2 (no compact/files-only fallback).
	 */
	private topRightSegment(): string {
		const stats = this.topRightGitStats?.();
		if (!stats) return "";
		const decorated = decorateBorderGitStats(stats, {
			mute: this.subduedColor,
			separator: (text) => this.borderColor(text),
		});
		return `${this.borderColor(FRAME_LABEL_OPEN)}${decorated}${this.borderColor(FRAME_RIGHT_CORNER_CLOSE)}`;
	}

	/**
	 * Render the inner editor 2 columns narrower and draw heavy vertical side
	 * borders plus square corners around it. The inner editor applies one column
	 * of horizontal padding, so content sits at `┃ <input> ┃`. Autocomplete lines stay
	 * outside the frame.
	 */
	render(width: number): string[] {
		// pi owns the accent (thinking-level color) and rewrites `borderColor` after
		// construction. Track the latest accent, then swap the frame line to dim in
		// normal mode while the labels keep the accent. The cursor disappears too.
		if (this.borderColor !== this.dimColor) this.lastAccent = this.borderColor;
		const inactive = this.isInputInactive();
		this.borderColor = inactive ? this.dimColor : (this.lastAccent ?? this.borderColor);
		const lines = this.renderFrame(width);
		return inactive ? stripEditorCursor(lines) : lines;
	}

	private renderFrame(width: number): string[] {
		if (this.locked) {
			// Only replace the editor body; border labels remain live while locked.
			const label = "LOCKED \u{f023}"; // Nerd Font fa-lock
			if (width < 3) return ["", "", truncateToWidth(label, Math.max(0, width), ""), "", ""];
			const innerWidth = width - 2;
			const center = (text: string): string => {
				const clipped = truncateToWidth(text, innerWidth, "");
				const left = Math.floor((innerWidth - visibleWidth(clipped)) / 2);
				return `${" ".repeat(left)}${clipped}${" ".repeat(innerWidth - left - visibleWidth(clipped))}`;
			};
			const row = (text: string): string => `${this.borderColor("┃")}${center(text)}${this.borderColor("┃")}`;
			const tapeWidth = Math.min(96, innerWidth - 6);
			const showTape = tapeWidth >= visibleWidth("  LOCKED  ") + 4;
			const motif = showTape
				? [
					row(this.lockedStripeColor("╱".repeat(tapeWidth))),
					row(this.lockedStripeColor("╱".repeat(tapeWidth))),
					row(this.lockedRuleColor("═".repeat(tapeWidth))),
					row("  LOCKED  "),
					row(this.lockedRuleColor("═".repeat(tapeWidth))),
					row(this.lockedStripeColor("╱".repeat(tapeWidth))),
					row(this.lockedStripeColor("╱".repeat(tapeWidth))),
				]
				: [row(this.borderColor("╾━━━━╼")), row(label)];
			return [
				this.isBorderMode()
					? `${this.borderColor("╭")}${this.renderTopBorder(innerWidth, 0)}${this.borderColor("╮")}`
					: this.borderColor(`╭${"━".repeat(innerWidth)}╮`),
				row(""),
				...motif,
				row(""),
				row(this.lockedRuleColor("Ctrl+,  ·  L to unlock")),
				row(""),
				this.isBorderMode()
					? `${this.borderColor("╰")}${this.renderBottomBorder(innerWidth, 0)}${this.borderColor("╯")}`
					: this.borderColor(`╰${"━".repeat(innerWidth)}╯`),
			];
		}
		if (!this.isBorderMode() || width < 3) {
			return super.render(width);
		}

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

		// Keep the model whenever possible. Git totals render on the border only in
		// their full split form; on a narrow frame that no longer fits, so the label is
		// relocated to status line 2 (no compact/files-only fallback). If even the model
		// alone does not fit, the model still wins and the totals relocate.
		const modelLabel = this.topLeftLabel();
		const reviewLabel = this.topLeftReviewProvider?.();
		const reviewSuffix = hasVisibleText(reviewLabel) ? ` · ${reviewLabel}` : "";
		// Measure the uncolored placeholder so only the model label runs through
		// the stateful working animation renderer.
		const modelPlaceholder = modelLabel
			? `${FRAME_LEFT_CORNER_OPEN}${modelLabel}${reviewSuffix}${FRAME_LABEL_CLOSE}`
			: "";
		const fullRightSegment = this.topRightSegment();
		const chosen = chooseTopBorderSegments({
			width,
			leftSegments: [modelPlaceholder],
			rightSegments: [fullRightSegment],
			minimumGap: MIN_CORNER_LABEL_GAP,
			visibleWidth,
		});
		const rawGitStats = this.topRightGitStats?.();
		if (this.relocatedLabels) {
			this.relocatedLabels.gitStats = hasVisibleText(chosen.right) ? undefined : rawGitStats;
		}
		const selectedModelLabel = chosen.left === modelPlaceholder ? modelLabel : undefined;
		const leftSegment = selectedModelLabel ? this.topLeftSegment(selectedModelLabel, reviewLabel) : "";
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

		const contextParts = this.bottomLeftProvider?.();
		const usageLabel = contextParts?.usage;
		const costLabel = contextParts?.cost;
		const statusLabel = this.bottomLeftStatusProvider?.();
		const networkLabel = this.bottomLeftNetworkProvider?.();
		const subagentLabel = this.bottomLeftSubagentProvider?.();
		// Full border context is usage + cost; the usage meter always stays on the border.
		const combinedContext =
			hasVisibleText(usageLabel) && hasVisibleText(costLabel)
				? `${usageLabel}${contextParts?.separator ?? " · "}${costLabel}`
				: usageLabel || costLabel;
		const fullLeftSegment = this.bottomLeftSegment(combinedContext, statusLabel, networkLabel, subagentLabel);
		const scrollSegment = hiddenLineCount > 0 ? this.borderColor(` ↓ ${hiddenLineCount} more `) : "";
		// The unsent-message size uses the paste-expanded text, which is what pi
		// actually sends (submit expands paste markers, then trims).
		const messageLabel = this.bottomRightProvider?.(this.getExpandedText());
		const messageSegment = hasVisibleText(messageLabel)
			? `${this.borderColor(FRAME_LABEL_OPEN)}${sanitizeStatusText(messageLabel)}${this.borderColor(FRAME_RIGHT_CORNER_CLOSE)}`
			: "";
		// Mode word disabled for now; the dim frame + hidden cursor carry the signal.
		// Keep for later:
		// const modeSegment = this.isInputInactive()
		// 	? `${this.labelColor(FRAME_LABEL_OPEN)}${this.labelColor("NORMAL")}${this.labelColor(FRAME_LABEL_CLOSE)}`
		// 	: "";
		const rightSegment = `${scrollSegment}${messageSegment}`;
		const borderColor = (text: string) => this.borderColor(text);

		// On a narrow frame the cost no longer fits. Keep the usage meter on the border
		// and relocate only the prices to status line 2.
		const costRelocated = hasVisibleText(costLabel) && visibleWidth(fullLeftSegment) >= width;
		const leftSegment = this.bottomLeftSegment(
			costRelocated ? usageLabel : combinedContext,
			statusLabel,
			networkLabel,
			subagentLabel,
		);
		if (this.relocatedLabels) {
			this.relocatedLabels.contextLabel = costRelocated ? costLabel : undefined;
		}

		if (!leftSegment) {
			return renderBorderLine(width, "", rightSegment, borderColor);
		}

		if (visibleWidth(leftSegment) + visibleWidth(rightSegment) < width) {
			return renderBorderLine(width, leftSegment, rightSegment, borderColor);
		}
		if (visibleWidth(leftSegment) < width) {
			return renderBorderLine(width, leftSegment, "", borderColor);
		}
		if (rightSegment && visibleWidth(rightSegment) < width) {
			return renderBorderLine(width, "", rightSegment, borderColor);
		}

		return renderBorderLine(width, "", "", borderColor);
	}

	/**
	 * Combined bottom-left segment. Safe mode and the effective network token
	 * share one label joined by exactly ` · `; context info follows after the
	 * tapered border bridge: `━╾ SMART · 󰅟 ✓? · 󰚩 ✓ ╼━╾ 15.9% 210k `. The bridge keeps
	 * its light halves on the label sides, so it reads as one line either way.
	 * Composition (including safe-mode recoloring) lives in the pure
	 * `composeBorderBottomLeft` helper.
	 */
	private bottomLeftSegment(
		contextLabel?: string,
		statusLabel?: string,
		networkLabel?: string,
		subagentLabel?: string,
	): string {
		return composeBorderBottomLeft({
			contextLabel,
			statusLabel,
			networkLabel,
			subagentLabel,
			borderColor: (text) => this.borderColor(text),
			accentColor: this.subduedColor,
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

// Subagents run with `--no-session`, so their cost is only durable in the parent
// session. Blocking runs land as `toolResult` messages; async completions are
// persisted as `custom_message` entries (`customType: "subagent-completion"`),
// so both shapes must be read. Children may spawn their own subagents, so recurse
// through the child messages as well.
function collectSubagentCost(ctx: ExtensionContext): number {
	let cost = 0;
	for (const entry of ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>) {
		if (entry.type === "message") {
			cost += collectSubagentCostFromMessage(entry.message);
			continue;
		}
		if (entry.type === "custom_message" && entry.customType === "subagent-completion") {
			cost += collectSubagentCostFromDetails(entry.details);
		}
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
	firstBucket?: (text: string) => string,
): string {
	if (percent <= 20) return firstBucket ? firstBucket(label) : theme.fg("muted", label);
	if (percent <= 30) return theme.fg("text", label);
	if (percent <= 50) return theme.fg("warning", label);
	return theme.fg("error", label);
}

// How far the subdued indicators move from the thinking color toward black.
// Higher values are darker; tweak this one constant to taste.
const DARK_ACCENT_MIX = 0.4;

// Subdued accent for the border's "default color" indicators (zero git stats,
// neutral network, top-level subagent depth, low context usage): the thinking
// color blended toward black so they recede instead of drawing the eye. Falls
// back to the raw theme color when the ANSI escape cannot be parsed.
export function styleDarkAccent(
	theme: { fg: (token: ThemeColor, text: string) => string; getFgAnsi: (token: ThemeColor) => string },
	text: string,
): string {
	const base = parseAnsiRgb(theme.getFgAnsi("thinkingOff"));
	if (!base) return theme.fg("thinkingOff", text);
	return fgRgb(mixRgb(base, { r: 0, g: 0, b: 0 }, DARK_ACCENT_MIX), text);
}

// Border (top-left) model label: "provider/model-id · EFFORT" with alias tables
// applied, id-only when provider is missing. The effort is always the full
// thinking level name.
function buildBorderModelLabel(
	ctx: ExtensionContext,
	providerAliases: NeoBarAliasMap,
	modelAliases: NeoBarAliasMap,
	thinkingLevel: string | undefined,
): string | undefined {
	const model = ctx.model;
	if (!model?.id) return undefined;
	const modelLabel = modelAliases[model.id] ?? model.id;
	const providerLabel = model.provider ? (providerAliases[model.provider] ?? model.provider) : undefined;
	const base = providerLabel ? `${providerLabel}/${modelLabel}` : modelLabel;
	if (typeof thinkingLevel !== "string" || !thinkingLevel.trim()) return `${MODEL_DISPLAY_GLYPH}${base}`;
	return `${MODEL_DISPLAY_GLYPH}${base} · ${formatThinkingLevel(thinkingLevel)}`;
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
	modelAliases: NeoBarAliasMap = {},
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

// First-line token breakdown (new display mode), colored like the neo-bar context items.
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

// How many leading bytes of an image file are read to parse its header. Deep
// enough for JPEG frame headers in normal files; huge metadata can exceed it.
const IMAGE_HEADER_BYTES = 256 * 1024;

// Path -> DeepSeek image token estimate (0 when unreadable/unsupported). Pasted
// images are immutable temp files, so caching by resolved path is safe and keeps
// file I/O off the render path after the first sighting.
const imageTokenCache = new Map<string, number>();

function readImageTokens(filePath: string): number {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(filePath, "r");
		const buffer = Buffer.alloc(IMAGE_HEADER_BYTES);
		const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
		const dimensions = parseImageDimensions(buffer.subarray(0, bytesRead));
		return dimensions ? deepseekImageTokens(dimensions.width, dimensions.height) : 0;
	} catch {
		return 0;
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// Best effort; the label must never fail a render.
			}
		}
	}
}

/**
 * Sum the DeepSeek image-token estimate for every local image path in the
 * editor text. Unreadable or unsupported paths contribute 0.
 */
export function collectImageTokens(text: string, cwd: string): number {
	let total = 0;
	for (const candidate of findImagePaths(text)) {
		const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
		let tokens = imageTokenCache.get(absolute);
		if (tokens === undefined) {
			tokens = readImageTokens(absolute);
			imageTokenCache.set(absolute, tokens);
		}
		total += tokens;
	}
	return total;
}

// Unsent-message token size for the border's bottom-right corner, e.g. `󰍡 1.2k`.
// Returns undefined for an empty editor so the corner stays clear. Text uses
// pi's conservative chars/4 estimate on the paste-expanded input; `imageTokens`
// adds the DeepSeek image estimate for any pasted image paths.
export function buildMessageSizeLabel(
	text: string,
	theme: { fg: (token: ThemeColor, text: string) => string },
	imageTokens = 0,
): string | undefined {
	const tokens = estimateMessageTokens(text) + Math.max(0, Math.floor(imageTokens));
	if (tokens <= 0) return undefined;
	return theme.fg("text", `${BORDER_MESSAGE_ICON}${formatTokens(tokens)}`);
}

interface FirstLineEntry {
	content: string;
	section: NeoBarSection;
	priority: number;
	order: number;
}

interface RowEntry {
	content: string;
	order: number;
}

function isSetPayload(value: unknown): value is NeoBarSetPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<NeoBarSetPayload>;
	return typeof maybe.id === "string" && typeof maybe.content === "string";
}

function isClearPayload(value: unknown): value is NeoBarClearPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<NeoBarClearPayload>;
	return typeof maybe.id === "string";
}

function isFirstLineSetPayload(value: unknown): value is NeoBarFirstLineSetPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<NeoBarFirstLineSetPayload>;
	if (typeof maybe.id !== "string") return false;
	if (typeof maybe.content !== "string") return false;
	if (maybe.section !== undefined && maybe.section !== "left" && maybe.section !== "center" && maybe.section !== "right") {
		return false;
	}
	if (maybe.priority !== undefined && typeof maybe.priority !== "number") return false;
	return true;
}

function isFirstLineClearPayload(value: unknown): value is NeoBarFirstLineClearPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<NeoBarFirstLineClearPayload>;
	return typeof maybe.id === "string";
}

function isRewireSetPayload(value: unknown): value is NeoBarRewireSetPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<NeoBarRewireSetPayload>;
	return (
		typeof maybe.model === "string" &&
		maybe.model.trim().length > 0 &&
		typeof maybe.thinkingLevel === "string" &&
		maybe.thinkingLevel.trim().length > 0 &&
		(maybe.inherit === undefined || typeof maybe.inherit === "boolean") &&
		(maybe.inheritAll === undefined || typeof maybe.inheritAll === "boolean")
	);
}

function isSubagentDepthSetPayload(value: unknown): value is NeoBarSubagentDepthSetPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<NeoBarSubagentDepthSetPayload>;
	return typeof maybe.depth === "number" && Number.isInteger(maybe.depth) && maybe.depth >= -1;
}

function renderSubagentDepthLabel(depth: number, theme: ExtensionContext["ui"]["theme"]): string {
	const value = depth < 0 ? "×" : depth === 0 ? "✓" : depth;
	const text = `${SUBAGENT_DEPTH_ICON} ${value}`;
	if (depth < 0) return theme.fg("muted", text);
	if (depth === 0) return theme.fg("text", text);
	return theme.fg("warning", text);
}

export function isReviewLevelSetPayload(value: unknown): value is NeoBarReviewLevelSetPayload {
	if (!value || typeof value !== "object") return false;
	const level = (value as Partial<NeoBarReviewLevelSetPayload>).level;
	return typeof level === "string" && Object.hasOwn(REVIEW_LEVEL_ICONS, level);
}

export function isInputModeSetPayload(value: unknown): value is NeoBarInputModeSetPayload {
	if (!value || typeof value !== "object") return false;
	const mode = (value as Partial<NeoBarInputModeSetPayload>).mode;
	return typeof mode === "string" && (NEO_BAR_INPUT_MODES as readonly string[]).includes(mode);
}

export function formatReviewLevelLabel(level: NeoBarReviewLevel): string | undefined {
	// Keep the Auto glyph mapping above: we may make the implicit/default state visible again later.
	if (level === "auto") return undefined;
	return `${REVIEW_LEVEL_ICONS[level]} `;
}

function isPingPayload(value: unknown): value is NeoBarPingPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<NeoBarPingPayload>;
	return typeof maybe.id === "string";
}

function isRowSetPayload(value: unknown): value is NeoBarRowSetPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<NeoBarRowSetPayload>;
	if (typeof maybe.id !== "string") return false;
	if (typeof maybe.content !== "string") return false;
	if (maybe.order !== undefined && typeof maybe.order !== "number") return false;
	return true;
}

function isRowClearPayload(value: unknown): value is NeoBarRowClearPayload {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<NeoBarRowClearPayload>;
	return typeof maybe.id === "string";
}

function parseSetArgs(args: string): NeoBarSetPayload | undefined {
	const input = args.trim();
	if (!input) return undefined;
	const firstSpace = input.indexOf(" ");
	if (firstSpace === -1) return undefined;
	const id = input.slice(0, firstSpace).trim();
	const content = input.slice(firstSpace + 1);
	if (!id) return undefined;
	return { id, content };
}

function parseClearArgs(args: string): NeoBarClearPayload | undefined {
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

function isDisplayMode(value: unknown): value is NeoBarDisplayMode {
	return typeof value === "string" && (NEO_BAR_DISPLAY_MODES as readonly string[]).includes(value);
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

function normalizeAliasMap(value: unknown): NeoBarAliasMap {
	const aliases: NeoBarAliasMap = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return aliases;
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw === "string" && raw.trim()) aliases[key] = raw.trim();
	}
	return aliases;
}

// Exact-name alias tables (no pattern matching). Configured under
// `providerAliases` / `modelAliases` in ~/.pi/agent/status-bar.json.
function loadAliases(): NeoBarAliasConfig {
	const settings = readSettingsFile();
	return {
		providerAliases: normalizeAliasMap(settings.providerAliases),
		modelAliases: normalizeAliasMap(settings.modelAliases),
	};
}

function normalizeDisplayMode(value: unknown): NeoBarDisplayMode | undefined {
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

function normalizeFrameCornerStyle(value: unknown): FrameCornerStyle | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return (FRAME_CORNER_STYLES as readonly string[]).includes(normalized)
		? (normalized as FrameCornerStyle)
		: undefined;
}

function loadFrameCornerStyle(): FrameCornerStyle {
	return normalizeFrameCornerStyle(process.env.PI_STATUS_BAR_FRAME_CORNERS) ?? FRAME_CORNER_STYLE;
}

function loadDisplayMode(): NeoBarDisplayMode {
	const fromEnv = normalizeDisplayMode(process.env.PI_STATUS_BAR_DISPLAY_MODE);
	if (fromEnv) return fromEnv;

	try {
		const parsed = JSON.parse(readFileSync(STATUS_BAR_SETTINGS_PATH, "utf-8")) as { displayMode?: unknown } | null;
		const fromFile = normalizeDisplayMode(parsed?.displayMode);
		if (fromFile) return fromFile;
	} catch {
		// Missing or invalid settings file: fall back to the default.
	}

	return DEFAULT_NEO_BAR_DISPLAY_MODE;
}

function saveDisplayMode(mode: NeoBarDisplayMode): { ok: true } | { ok: false; error: string } {
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

interface NeoBarContractSettingItem {
	id: string;
	label: string;
	value: string;
	description?: string;
}

function formatAliasSummary(aliases: NeoBarAliasMap): string {
	const entries = Object.entries(aliases);
	if (entries.length === 0) return "(none)";
	return entries.map(([from, to]) => `${from}->${to}`).join(", ");
}

async function showNeoBarContractUI(
	ctx: ExtensionContext,
	displayMode: NeoBarDisplayMode,
	aliases: NeoBarAliasConfig,
): Promise<void> {
	if (!ctx.hasUI) return;

	const layout = displayMode === "new" ? BORDER_PRIORITY_NEO_BAR_LAYOUT : DEFAULT_NEO_BAR_LAYOUT;

	const items: NeoBarContractSettingItem[] = [
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
			value: JSON.stringify(NEO_BAR_JOIN_SEPARATOR),
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
	let rewireTarget: NeoBarRewireSetPayload | undefined;
	let subagentDepth: number | undefined;
	let reviewLevel: NeoBarReviewLevel | undefined;
	let inputMode: NeoBarInputMode | undefined;
	let displayMode: NeoBarDisplayMode = loadDisplayMode();
	// Git dirty totals for the current cwd, collected internally. `undefined`
	// while the repo is clean or `ctx.cwd` is not inside a git repo.
	let gitStats: GitStats | undefined;
	// Unique `SKILL.md` files read this session, over the skills pi loaded.
	let skillStats: SkillStats | undefined;
	const workingAnimation = loadWorkingAnimation();
	const { providerAliases, modelAliases } = loadAliases();
	let lastContext: ExtensionContext | undefined;
	let footerOwnerContext: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let editorOwnerContext: ExtensionContext | undefined;
	let requestEditorRender: (() => void) | undefined;
	let frameEditor: FrameStatusEditor | undefined;
	// Filled by the editor frame when a border label must move to status line 2 on
	// a narrow frame; read by the footer in the same render pass.
	const relocatedBorderLabels: RelocatedBorderLabels = {};
	const ansiRgbCache = new Map<string, Rgb | undefined>();
	const ansiRgb = (ansi: string): Rgb | undefined => {
		if (ansiRgbCache.has(ansi)) return ansiRgbCache.get(ansi);
		const rgb = parseAnsiRgb(ansi);
		ansiRgbCache.set(ansi, rgb);
		return rgb;
	};
	let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let lockMode = false;
	pi.events.on("px:pi-ui:lock-state", (event: { locked: boolean }) => {
		lockMode = event.locked;
		frameEditor?.setLocked(lockMode);
	});

	const activeLayout = (): NeoBarLayout =>
		displayMode === "new" ? BORDER_PRIORITY_NEO_BAR_LAYOUT : DEFAULT_NEO_BAR_LAYOUT;

	const renderSection = (
		ids: string[],
		overrides?: Map<string, string | undefined>,
		joinSeparator: string = NEO_BAR_JOIN_SEPARATOR,
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

	// Git dirty totals live on the editor frame in `new` mode, so they are not
	// published on the first line (no duplication). In `legacy` mode the frame is
	// hidden and the counters return to the first line as an internally-owned
	// entry, ordered like a producer at the same priority. The skill counter
	// always lives on the first line.
	const internalFirstLineEntries = (): Array<[string, FirstLineEntry]> => {
		const entries: Array<[string, FirstLineEntry]> = [];
		if (displayMode === "legacy" && gitStats) {
			entries.push([
				GIT_STATS_ID,
				{
					// The footer only renders with a UI, so the label is always colorized.
					content: renderGitStatsLabel(gitStats, true),
					section: "right",
					priority: GIT_STATS_FIRST_LINE_PRIORITY,
					order: Number.MAX_SAFE_INTEGER,
				},
			]);
		}
		if (skillStats) {
			entries.push([
				SKILL_STATS_ID,
				{
					content: renderSkillStatsLabel(skillStats, true),
					section: "right",
					priority: SKILL_STATS_FIRST_LINE_PRIORITY,
					order: Number.MAX_SAFE_INTEGER,
				},
			]);
		}
		return entries;
	};

	const renderFirstLineSection = (
		section: NeoBarSection,
		joinSeparator: string = NEO_BAR_JOIN_SEPARATOR,
		attensionCoreSuffix?: string,
		rewireContent?: string,
	): string | undefined => {
		const entries = [...firstLineById.entries(), ...internalFirstLineEntries()];
		if (section === "right" && hasVisibleText(rewireContent)) {
			entries.push([
				REWIRE_STATUS_ID,
				{
					content: rewireContent,
					section: "right",
					priority: REWIRE_FIRST_LINE_PRIORITY,
					order: Number.MAX_SAFE_INTEGER,
				},
			]);
		}
		const items = entries
			.filter(
				([id, entry]) =>
					!SUPERSEDED_FIRST_LINE_IDS.has(id) && entry.section === section && hasVisibleText(entry.content),
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
		if (rewireTarget) return true;
		const entries = [...firstLineById.entries(), ...internalFirstLineEntries()];
		return entries.some(([id, entry]) => !SUPERSEDED_FIRST_LINE_IDS.has(id) && hasVisibleText(entry.content));
	};

	const requestRender = (): void => {
		requestFooterRender?.();
		requestEditorRender?.();
	};

	// Git dirty totals live inside the status bar (single consumer), so the
	// watcher feeds local state instead of a first-line producer contract.
	const gitStatsWatcher = new GitStatsWatcher((stats) => {
		gitStats = stats;
		requestRender();
	});

	// Skill read counter lives here too, for the same reason: nothing else
	// consumes the first-line event it used to publish.
	const skillStatsTracker = new SkillStatsTracker((stats) => {
		skillStats = stats;
		requestRender();
	});

	// Live cache of the effective network state from permissions-core. `current`
	// is `undefined` when the core is absent, so no token is rendered. Live
	// `changed` events win over slower in-flight queries (see network.ts).
	const networkStore = new NetworkStateStore({ events: pi.events, onChange: requestRender });

	// Live cache of the hub aggregate progress snapshot. The observer sanitizes
	// and formats untrusted text in progress.ts; here we only apply the resulting
	// row and request a render after an effective change. The footer prefers to
	// append it to the status bar's first line and otherwise renders it as leading
	// footer lines, between the input and the status bar.
	let progressRow: string | undefined;
	const progressStore = new ProgressObserver({
		events: pi.events,
		onChange: (row) => {
			progressRow = row;
			requestRender();
		},
	});

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
						const firstLineJoinSeparator = theme.fg("muted", NEO_BAR_JOIN_SEPARATOR);
						const hasAttensionCore = hasVisibleText(firstLineById.get(ATTENSION_CORE_ID)?.content);
						const attensionCoreSuffix = hasAttensionCore ? defaultFirstLine : undefined;
						const producerLeft = renderFirstLineSection("left", firstLineJoinSeparator, attensionCoreSuffix);
						const left = producerLeft ?? (hasAttensionCore ? undefined : defaultFirstLine);
						const center = renderFirstLineSection("center", firstLineJoinSeparator, attensionCoreSuffix);
						const rewireContent = rewireTarget
							? theme.fg(
									"error",
									formatRewireStatusLabel(
										rewireTarget.model,
										rewireTarget.thinkingLevel,
										providerAliases,
										modelAliases,
										rewireTarget.inherit,
										rewireTarget.inheritAll,
									),
								)
							: undefined;
						const producerRight = renderFirstLineSection(
							"right",
							firstLineJoinSeparator,
							attensionCoreSuffix,
							rewireContent,
						);
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

					// Progress: its own line(s) directly above the status bar's first line
					// (line -1). The color matches the editor frame border (purple in the
					// default style).
					let progressBefore: string[] = [];
					if (hasVisibleText(progressRow)) {
						const progressColor = activeCtx.ui.theme.getThinkingBorderColor(pi.getThinkingLevel());
						progressBefore = progressFooterLines({
							width,
							full: progressRow,
							compact: formatProgressRow(progressStore.current, { compact: true }),
						}).map((line) => centerProgressLine(progressColor(line), width));
					}

					const layout = activeLayout();
					const contextOverrides =
						layout.right.length > 0 ? getContextWatcherOverrides(activeCtx, theme, modelAliases) : undefined;

					let joinSeparator = theme.fg("muted", NEO_BAR_JOIN_SEPARATOR);
					// Network token: on the status line in `legacy` mode, on the border in
					// `new` mode. Exactly one surface renders it, so there is no duplication.
					const networkResolution = resolveNetworkStatus({ displayMode, state: networkStore.current, theme });
					const networkStatusLabel =
						networkResolution?.surface === "status-line" ? networkResolution.label : undefined;
					const subagentStatusLabel =
						subagentDepth === undefined ? undefined : renderSubagentDepthLabel(subagentDepth, theme);
					// Policy indicators share one item joined by exactly ` · ` (here
					// `networkSeparator`), so a crowded line switching to the compact separator
					// cannot collapse those dots.
					const renderLeft = (
						itemSeparator: string,
						extraOverrides?: Map<string, string | undefined>,
					): string | undefined =>
						composeLegacyLeftSection({
							ids: layout.left,
							getContent: (id) => contentById.get(id),
							networkLabel: networkStatusLabel,
							subagentLabel: subagentStatusLabel,
							networkSeparator: theme.fg("muted", NEO_BAR_JOIN_SEPARATOR),
							itemSeparator,
							safeModeId: SAFE_MODE_ID,
							overrides: extraOverrides,
						});
					let left = renderLeft(joinSeparator);
					let center = renderSection(layout.center, undefined, joinSeparator);
					let right = renderSection(layout.right, contextOverrides, joinSeparator);

					// On a narrow frame the editor frame relocates the cost label (usage stays on
					// the border) and the git dirty totals to status line 2 (left and right).
					// Merge them into the section content here so crowding accounts for them.
					const relocatedContext = displayMode === "new" ? relocatedBorderLabels.contextLabel : undefined;
					const relocatedGitStats = displayMode === "new" ? relocatedBorderLabels.gitStats : undefined;
					const relocatedGit = relocatedGitStats
						? decorateBorderGitStats(relocatedGitStats, {
								mute: (value) => styleDarkAccent(theme, value),
								separator: (value) => theme.fg("thinkingOff", value),
							})
						: undefined;
					const mergeRelocated = (
						base: string | undefined,
						extra: string | undefined,
						separator: string,
					): string | undefined => {
						if (!hasVisibleText(extra)) return base;
						return hasVisibleText(base) ? `${base}${separator}${extra}` : extra;
					};
					left = mergeRelocated(left, relocatedContext, joinSeparator);
					right = mergeRelocated(right, relocatedGit, joinSeparator);

					if (isCrowded(width, left, center, right)) {
						joinSeparator = theme.fg("muted", COMPACT_ITEM_JOIN_SEPARATOR);
						left = renderLeft(joinSeparator);
						center = renderSection(layout.center, undefined, joinSeparator);
						right = renderSection(layout.right, contextOverrides, joinSeparator);
						left = mergeRelocated(left, relocatedContext, joinSeparator);
						right = mergeRelocated(right, relocatedGit, joinSeparator);
					}

					const hasThinkingSection = layout.left.includes(SWITCH_THINKING_ID);
					const activeThinking = contentById.get(SWITCH_THINKING_ACTIVE_ID);
					const needCompactThinking = hasThinkingSection && hasVisibleText(activeThinking) && isCrowded(width, left, center, right);

					if (needCompactThinking) {
						left = renderLeft(joinSeparator, new Map([[SWITCH_THINKING_ID, activeThinking]]));
						left = mergeRelocated(left, relocatedContext, joinSeparator);
					}

					const line2 = renderThreeSectionLine(width, left, center, right);
					const lines = [...progressBefore, ...(line2.length > 0 ? [line1, line2] : [line1])];
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
			bottomLeft: () => buildFrameContextParts(activeContext(), activeContext().ui.theme),
			bottomLeftStatus: () => contentById.get(SAFE_MODE_ID),
			bottomLeftNetwork: () => {
				const resolution = resolveNetworkStatus({
					displayMode,
					state: networkStore.current,
					theme: activeContext().ui.theme,
				});
				return resolution?.surface === "border" ? resolution.label : undefined;
			},
			bottomLeftSubagent: () =>
				subagentDepth === undefined ? undefined : renderSubagentDepthLabel(subagentDepth, activeContext().ui.theme),
			topLeft: () =>
				buildBorderModelLabel(
					activeContext(),
					providerAliases,
					modelAliases,
					pi.getThinkingLevel(),
				),
			topLeftReview: () =>
				reviewLevel === undefined ? undefined : formatReviewLevelLabel(reviewLevel),
			topRightGitStats: () => gitStats,
			bottomRight: (text) =>
				buildMessageSizeLabel(text, activeContext().ui.theme, collectImageTokens(text, activeContext().cwd)),
			relocatedLabels: relocatedBorderLabels,
			getWorkingAnimation: () => workingAnimation,
			interruptConfirmation: new InterruptConfirmationGuard({
				getOperationToken: () => activeContext().signal,
				confirm: () => showInterruptConfirmation(activeContext()),
			}),
			subduedColor: (text) => styleDarkAccent(activeContext().ui.theme, text),
			dimColor: (text) => activeContext().ui.theme.fg("dim", text),
			lockedStripeColor: (text) => activeContext().ui.theme.fg("dim", text),
			lockedRuleColor: (text) => activeContext().ui.theme.fg("muted", text),
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
			frameEditor.setLocked(lockMode);
			frameEditor.setInputMode(inputMode);
			return frameEditor;
		});
		if (!frameEditor) throw new Error("neo-bar: pi did not create the editor synchronously");
		frameEditor.protectInterrupt();

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
		// Only an active session may apply live network/progress `changed` events.
		networkStore.activate();
		progressStore.activate();
		skillStatsTracker.startSession(countSessionSkills(ctx));
		bindContextAndRender(ctx);
		// Refresh in the background; a live `changed` event also updates state.
		void networkStore.refresh();
		void progressStore.refresh();
	});

	pi.on("session_tree", async (_event, ctx) => {
		networkStore.activate();
		progressStore.activate();
		bindContextAndRender(ctx);
		void networkStore.refresh();
		void progressStore.refresh();
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

	// The working tree can change at any of these points; the watcher debounces
	// and only re-renders when the counters actually changed.
	const refreshGitStats = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		gitStatsWatcher.schedule(ctx.cwd);
	};

	pi.on("session_start", refreshGitStats);
	pi.on("session_tree", refreshGitStats);
	pi.on("turn_start", refreshGitStats);
	pi.on("turn_end", refreshGitStats);
	pi.on("input", refreshGitStats);
	pi.on("user_bash", refreshGitStats);

	// Skill reads arrive as read tool results; the denominator is refreshed
	// before each agent run from the skills pi assembled for that run.
	pi.on("before_agent_start", async (event) => {
		skillStatsTracker.setLoaded(countLoadedSkills(event.systemPromptOptions));
	});

	pi.on("tool_result", async (event, ctx) => {
		skillStatsTracker.recordRead({
			toolName: event.toolName,
			isError: event.isError,
			input: event.input,
			cwd: ctx.cwd,
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		lockMode = false;
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
		// Drop stale network/progress state and deactivate so late `changed`
		// events after shutdown cannot restore the previous session's UI.
		networkStore.deactivate();
		progressStore.deactivate();
		subagentDepth = undefined;
		reviewLevel = undefined;
		inputMode = undefined;
		gitStatsWatcher.dispose();
		gitStats = undefined;
		skillStatsTracker.reset();
		skillStats = undefined;
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

	pi.events.on(STATUS_BAR_EVENTS.rewireSet, (payload) => {
		if (!isRewireSetPayload(payload)) return;
		rewireTarget = {
			model: payload.model.trim(),
			thinkingLevel: payload.thinkingLevel.trim(),
			...(payload.inherit ? { inherit: true } : {}),
			...(payload.inheritAll ? { inheritAll: true } : {}),
		};
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.rewireClear, () => {
		rewireTarget = undefined;
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.subagentDepthSet, (payload) => {
		if (!isSubagentDepthSetPayload(payload)) return;
		subagentDepth = payload.depth;
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.subagentDepthClear, () => {
		subagentDepth = undefined;
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.reviewLevelSet, (payload) => {
		if (!isReviewLevelSetPayload(payload)) return;
		reviewLevel = payload.level;
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.reviewLevelClear, () => {
		reviewLevel = undefined;
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.inputModeSet, (payload) => {
		if (!isInputModeSetPayload(payload)) return;
		inputMode = payload.mode;
		frameEditor?.setInputMode(inputMode);
		requestRender();
	});

	pi.events.on(STATUS_BAR_EVENTS.inputModeClear, () => {
		inputMode = undefined;
		frameEditor?.setInputMode(undefined);
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
			await showNeoBarContractUI(ctx, displayMode, { providerAliases, modelAliases });
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

	pi.registerCommand("px:status-bar-git-stats", {
		description: "Show the current git dirty totals rendered by the status bar",
		handler: async (_args, ctx) => {
			const snapshot = collectGitSnapshot(ctx.cwd);
			if (!ctx.hasUI) return;
			if (!snapshot) {
				ctx.ui.notify("git stats: current cwd is not a git repo", "warning");
				return;
			}
			const summary = dirtyStats(snapshot) ? formatGitStatsText(snapshot.stats) : "(clean)";
			ctx.ui.notify(
				`git stats: ${summary} (repo=${snapshot.repoRoot}, branch=${snapshot.branch}, dirty=${snapshot.isDirty})`,
				"info",
			);
		},
	});

	pi.registerCommand("px:status-bar-skill-stats", {
		description: "Show the counted SKILL.md paths and the loaded skill denominator",
		handler: async (_args, ctx) => {
			const paths = skillStatsTracker.readPathsList();
			const message = [
				`skill stats: ${skillStatsTracker.snapshot().read}/${skillStatsTracker.snapshot().loaded}`,
				paths.length > 0 ? paths.join("\n") : "No SKILL.md files counted yet.",
			].join("\n");
			if (ctx.hasUI) {
				ctx.ui.notify(message, "info");
			} else {
				console.log(message);
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
