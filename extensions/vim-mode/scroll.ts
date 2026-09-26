/**
 * Transcript scrolling and entry-jumping helpers for vim-mode (Phases 2-3).
 *
 * Ported minimally from `pi-ui`, but intentionally self-contained: vim-mode must
 * keep working when `pi-ui` is not installed. The transcript `ScrollView` only
 * exists in fullscreen (alt-screen) mode.
 */

/** The slice of pi-tui's `ScrollView` used to move the transcript. */
export interface ScrollViewLike {
	scrollTop: number;
	scrollBy(delta: number): void;
	scrollTo(top: number): void;
	child?: unknown;
	viewportHeight?: number;
	primary?: boolean;
	scrollToStart?(): void;
	scrollToEnd?(): void;
}

/** Maximum component-tree depth walked when the TUI has no direct accessor. */
const MAX_TREE_DEPTH = 8;

function isScrollViewLike(candidate: unknown): candidate is ScrollViewLike {
	if (!candidate || typeof candidate !== "object") return false;
	const record = candidate as Record<string, unknown>;
	return (
		typeof record.scrollTo === "function" &&
		typeof record.scrollBy === "function" &&
		typeof record.scrollTop === "number"
	);
}

function findPrimaryInTree(node: unknown, depth: number): ScrollViewLike | undefined {
	if (!node || typeof node !== "object" || depth > MAX_TREE_DEPTH) return undefined;
	const children = (node as { children?: unknown[] }).children;
	if (!Array.isArray(children)) return undefined;
	// Breadth-first over direct children, then recurse, so the shallowest
	// primary scroll view wins.
	for (const child of children) {
		if (isScrollViewLike(child) && child.primary === true) return child;
	}
	for (const child of children) {
		const found = findPrimaryInTree(child, depth + 1);
		if (found) return found;
	}
	return undefined;
}

/**
 * Locate the primary transcript scroll view (fullscreen alt-screen mode).
 *
 * Prefers the TUI's own `getPrimaryScrollView()` accessor; if that is missing
 * or returns something that is not a scroll view, walks `layoutRoot ?? tui`'s
 * component tree for the first scroll-view-like node flagged `primary`.
 */
export function getPrimaryScrollView(tui: unknown): ScrollViewLike | undefined {
	if (!tui || typeof tui !== "object") return undefined;
	const candidate = tui as {
		getPrimaryScrollView?: () => unknown;
		layoutRoot?: unknown;
		children?: unknown[];
	};
	if (typeof candidate.getPrimaryScrollView === "function") {
		const primary = candidate.getPrimaryScrollView();
		if (isScrollViewLike(primary)) return primary;
	}
	return findPrimaryInTree(candidate.layoutRoot ?? candidate, 0);
}

/**
 * Scroll the transcript by `delta` lines. Positive moves toward newer output
 * (down); negative toward older output (up). Returns whether the view moved.
 */
export function scrollReadingArea(tui: unknown, delta: number): boolean {
	const scrollView = getPrimaryScrollView(tui);
	if (!scrollView || !Number.isFinite(delta) || delta === 0) return false;
	const before = scrollView.scrollTop;
	// pi's real `ScrollView.scrollBy` returns the number of lines moved, but the
	// interface above types it as `void`; read it defensively.
	const maybeMoved: unknown = scrollView.scrollBy(delta);
	if (typeof maybeMoved === "number") return maybeMoved !== 0;
	return scrollView.scrollTop !== before;
}

/**
 * Phase 3: transcript entry jumping.
 *
 * `computeEntryPositions` walks the transcript's component tree and records the
 * document line (`top`) of every rendered entry, so a jump can scroll a target
 * entry flush to the top of the viewport.
 */

/** Component names pi uses for the transcript entries rendered in the chat. */
const TRANSCRIPT_ENTRY_COMPONENT_NAMES = new Set([
	"ToolExecutionComponent",
	"BashExecutionComponent",
	"CustomMessageComponent",
	"CustomEntryComponent",
	"CompactionSummaryMessageComponent",
	"BranchSummaryMessageComponent",
	"SkillInvocationMessageComponent",
	"AssistantMessageComponent",
	"UserMessageComponent",
]);

/** Transcript entries that carry the conversation itself (no tool noise). */
const MESSAGE_COMPONENT_NAMES = new Set(["UserMessageComponent", "AssistantMessageComponent"]);

/** The slice of a pi-tui component needed to place transcript entries. */
export interface TranscriptEntry {
	render?(width: number): string[];
	children?: unknown[];
	mouseLayout?: { width: number; children: Array<{ component: unknown; height: number }> };
	constructor?: { name?: string };
}

export interface EntryPosition {
	component: TranscriptEntry;
	top: number;
	height: number;
}

function componentClassName(component: object): string | undefined {
	return (component as { constructor?: { name?: string } }).constructor?.name;
}

/** True for the transcript entry components pi renders in the chat. */
export function isTranscriptEntry(component: unknown): component is TranscriptEntry {
	if (!component || typeof component !== "object") return false;
	const name = componentClassName(component);
	return name !== undefined && TRANSCRIPT_ENTRY_COMPONENT_NAMES.has(name);
}

function childRenderedHeight(component: TranscriptEntry, width: number): number {
	if (typeof component.render !== "function") return 0;
	try {
		return component.render(width).length;
	} catch {
		return 0;
	}
}

function recordedChildHeights(container: TranscriptEntry, width: number): number[] | undefined {
	const layout = container.mouseLayout;
	if (!layout || layout.width !== width || !Array.isArray(layout.children)) return undefined;
	return layout.children.map((child) => child.height);
}

function collectEntryPositions(
	container: TranscriptEntry,
	baseTop: number,
	width: number,
	out: EntryPosition[],
): void {
	const children = Array.isArray(container.children) ? container.children : [];
	if (children.length === 0) return;
	const recorded = recordedChildHeights(container, width);
	let y = 0;
	for (let index = 0; index < children.length; index += 1) {
		const child = children[index] as TranscriptEntry;
		const height = recorded?.[index] ?? childRenderedHeight(child, width);
		const top = baseTop + y;
		if (isTranscriptEntry(child)) {
			out.push({ component: child, top, height });
		} else {
			collectEntryPositions(child, top, width, out);
		}
		y += height;
	}
}

/** Display positions of transcript entries, top → bottom, in document lines. */
export function computeEntryPositions(root: unknown, width: number): EntryPosition[] {
	const positions: EntryPosition[] = [];
	if (!root || typeof root !== "object" || width <= 0) return positions;
	collectEntryPositions(root as TranscriptEntry, 0, width, positions);
	return positions;
}

/**
 * pi renders an assistant message that only requests tools as its hidden-thinking
 * placeholder (plus blank padding) while `hideThinkingBlock` is on, so the entry
 * has nothing the user can see or act on.
 */
function hasNavigableContent(entry: TranscriptEntry): boolean {
	const internals = entry as unknown as {
		hideThinkingBlock?: boolean;
		lastMessage?: { content?: Array<{ type?: string; text?: string }> };
	};
	if (internals.hideThinkingBlock !== true) return true;
	const content = internals.lastMessage?.content;
	if (!Array.isArray(content)) return true;
	return content.some(
		(block) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
	);
}

/** Entries the user can actually see: zero-height and placeholder-only ones are skipped. */
export function navigablePositions(positions: readonly EntryPosition[]): EntryPosition[] {
	return positions.filter((position) => position.height > 0 && hasNavigableContent(position.component));
}

/** Navigable positions narrowed to user and assistant messages only. */
export function messagePositions(positions: readonly EntryPosition[]): EntryPosition[] {
	return navigablePositions(positions).filter((position) => {
		const name = componentClassName(position.component);
		return name !== undefined && MESSAGE_COMPONENT_NAMES.has(name);
	});
}

/** Top offset of the first navigable entry strictly below `scrollTop`. */
export function findNextEntryTop(positions: readonly EntryPosition[], scrollTop: number): number | undefined {
	for (const position of positions) {
		if (position.top > scrollTop) return position.top;
	}
	return undefined;
}

/** Top offset of the last navigable entry strictly above `scrollTop`. */
export function findPreviousEntryTop(
	positions: readonly EntryPosition[],
	scrollTop: number,
): number | undefined {
	let previous: number | undefined;
	for (const position of positions) {
		if (position.top >= scrollTop) break;
		previous = position.top;
	}
	return previous;
}

/** Content width used to lay out entry heights; recorded width wins. */
function scrollContentWidth(scrollView: ScrollViewLike, tui: unknown): number {
	const content = scrollView.child as TranscriptEntry | undefined;
	const recorded = content?.mouseLayout?.width;
	if (typeof recorded === "number" && recorded > 0) return recorded;
	const columns = (tui as { terminal?: { columns?: number } } | undefined)?.terminal?.columns;
	return Math.max(1, (typeof columns === "number" ? columns : 80) - 1);
}

/** Which entries a jump considers. */
export type EntryScope = "all" | "messages";

/** Result of a transcript entry jump. */
export type EntryJumpOutcome =
	| { status: "moved"; top: number }
	/** No entry further in that direction; the key is still consumed. */
	| { status: "boundary" }
	/** A scroll view exists but holds no navigable entries. */
	| { status: "empty" }
	/** No fullscreen transcript scroll view is reachable. */
	| { status: "unavailable" };

/**
 * Jump to the next (`direction` 1) or previous (`direction` -1) entry and scroll
 * it to the top of the viewport. Does not wrap at either end.
 */
export function jumpToAdjacentEntry(
	tui: unknown,
	direction: 1 | -1,
	scope: EntryScope = "all",
): EntryJumpOutcome {
	const scrollView = getPrimaryScrollView(tui);
	if (!scrollView || !scrollView.child) return { status: "unavailable" };
	const positions = computeEntryPositions(scrollView.child, scrollContentWidth(scrollView, tui));
	const navigable = scope === "messages" ? messagePositions(positions) : navigablePositions(positions);
	if (navigable.length === 0) return { status: "empty" };

	const scrollTop = typeof scrollView.scrollTop === "number" ? scrollView.scrollTop : 0;
	const targetTop =
		direction === 1 ? findNextEntryTop(navigable, scrollTop) : findPreviousEntryTop(navigable, scrollTop);
	if (targetTop === undefined) return { status: "boundary" };

	scrollView.scrollTo(targetTop);
	return { status: "moved", top: targetTop };
}

/** Best-effort document height of the scroll view's content. */
function contentHeight(scrollView: ScrollViewLike, tui: unknown): number {
	const child = scrollView.child as
		| { render?(width: number): string[]; mouseLayout?: { height?: number } }
		| undefined;
	if (child?.mouseLayout && typeof child.mouseLayout.height === "number") return child.mouseLayout.height;
	if (typeof child?.render === "function") {
		try {
			return child.render(scrollContentWidth(scrollView, tui)).length;
		} catch {
			return 0;
		}
	}
	return 0;
}

/**
 * Scroll the transcript to its very top or bottom. Prefers the view's own
 * `scrollToStart`/`scrollToEnd`; falls back to computing the maximum offset.
 */
export function scrollToEdge(tui: unknown, edge: "top" | "bottom"): boolean {
	const scrollView = getPrimaryScrollView(tui);
	if (!scrollView) return false;

	if (edge === "top") {
		if (typeof scrollView.scrollToStart === "function") {
			scrollView.scrollToStart();
			return true;
		}
		scrollView.scrollTo(0);
		return true;
	}

	if (typeof scrollView.scrollToEnd === "function") {
		scrollView.scrollToEnd();
		return true;
	}
	const viewport = typeof scrollView.viewportHeight === "number" ? scrollView.viewportHeight : 0;
	scrollView.scrollTo(Math.max(0, contentHeight(scrollView, tui) - viewport));
	return true;
}
