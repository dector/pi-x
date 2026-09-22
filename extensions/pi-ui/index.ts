import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, Loader, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PATCH_FLAG = "__pi_ui_working_loader_patch_v6";
const WORKING_INSTANCE_FLAG = "__pi_ui_working_loader_instance";
const GLOBAL_MIN_TRACK_LENGTH_KEY = "__pi_ui_working_min_track_length";
const GLOBAL_HUE_STEP_KEY = "__pi_ui_working_hue_step_deg";
const GLOBAL_BELL_ENABLED_KEY = "__pi_ui_bell_enabled";
const GLOBAL_BELL_DEBOUNCE_MS_KEY = "__pi_ui_bell_debounce_ms";
const GLOBAL_BELL_LAST_RING_MS_KEY = "__pi_ui_bell_last_ring_ms";
const UI_INPUT_PATCH_FLAG = "__pi_ui_bell_ui_input_patch_v1";
const FRAME_TOKEN_PREFIX = "__pi_ui_frame_step:";
const SAFE_MODE_TOGGLE_READER_EVENT = "px:safe-mode:toggle-reader";
const SAFE_MODE_TOGGLE_OUTER_EVENT = "px:safe-mode:toggle-outer";
const SAFE_MODE_SET_YOLO_PLUS_EVENT = "px:safe-mode:set-yolo-plus";
const PROMPT_STASH_STASH_EVENT = "px:prompt-stash:stash";
const PROMPT_STASH_POP_EVENT = "px:prompt-stash:pop";
const PROMPT_STASH_LIST_EVENT = "px:prompt-stash:list";
const PROMPT_STASH_CLEAR_ALL_EVENT = "px:prompt-stash:clear-all";
const NOTES_OPEN_EVENT = "px:notes:open";
const NOTES_LIST_EVENT = "px:notes:list";
const SUBAGENT_REWIRE_TOGGLE_EVENT = "px:subagent:rewire:toggle";
const SUBAGENT_REWIRE_MENU_EVENT = "px:subagent:rewire:menu";
const SUBAGENT_MANAGER_MENU_EVENT = "px:subagent:manager:menu";
const STATUS_BAR_REWIRE_SET_EVENT = "px:status-bar:rewire:set";
const STATUS_BAR_REWIRE_CLEAR_EVENT = "px:status-bar:rewire:clear";
const ACTION_DIALOG_TOGGLE_SHORTCUT = Key.ctrl(",");
const TOGGLE_NEWEST_SHORTCUT = Key.alt("o");
const NAV_NEXT_SHORTCUT = Key.alt("j");
const NAV_PREVIOUS_SHORTCUT = Key.alt("k");

const EXPANDABLE_REGISTRY_KEY = "__pi_ui_expandable_registry_v1";
const EXPANDABLE_PATCHED_METHODS_KEY = "__pi_ui_expandable_patched_methods_v1";
const TUI_REFERENCE_KEY = "__pi_ui_tui_reference_v1";
const TUI_CAPTURE_WIDGET_KEY = "px:pi-ui-tui-capture";
const MAX_TRACKED_EXPANDABLES = 1000;

/**
 * Transcript entry components pi renders, used to recognise them by class name.
 * `isExpandable()` in interactive mode only checks for `setExpanded()`, which is
 * not enough to tell entries apart from the startup header.
 */
const TRACKED_ENTRY_COMPONENT_NAMES = new Set([
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

/** Tracked entries pi can collapse and expand. */
const EXPANDABLE_ENTRY_COMPONENT_NAMES = new Set([
	"ToolExecutionComponent",
	"BashExecutionComponent",
	"CustomMessageComponent",
	"CustomEntryComponent",
	"CompactionSummaryMessageComponent",
	"BranchSummaryMessageComponent",
	"SkillInvocationMessageComponent",
]);

const RESET_FG = "\x1b[39m";
const BELL_CHAR = "\x07";
const ESC = "\u001b";

// Thick pipe phases inside a single terminal cell: left, center, right.
const PIPE_PHASE_CHARS = ["▌", "┃", "▐"] as const;

const DEFAULT_MIN_TRACK_LENGTH = 15;
const MIN_TRACK_LENGTH = 15;
const MAX_TRACK_LENGTH = 400;

// Faster defaults
const DEFAULT_INTERVAL_MS = 16;
const DEFAULT_HUE_STEP_DEG = 8;
const DEFAULT_BELL_ENABLED = true;
const DEFAULT_BELL_DEBOUNCE_MS = 250;
const MIN_BELL_DEBOUNCE_MS = 0;
const MAX_BELL_DEBOUNCE_MS = 5_000;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function parseIntEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return parsed;
}

function parseFloatEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed)) return fallback;
	return parsed;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (!value) return fallback;
	const raw = value.trim().toLowerCase();
	if (raw.length === 0) return fallback;
	if (["1", "true", "yes", "on", "y"].includes(raw)) return true;
	if (["0", "false", "no", "off", "n"].includes(raw)) return false;
	return fallback;
}

function parseTrackLength(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(parsed)) return undefined;
	if (parsed < MIN_TRACK_LENGTH || parsed > MAX_TRACK_LENGTH) return undefined;
	return parsed;
}

function setGlobalMinTrackLength(length: number): void {
	(globalThis as Record<string, unknown>)[GLOBAL_MIN_TRACK_LENGTH_KEY] = length;
}

function getGlobalMinTrackLength(): number {
	const value = (globalThis as Record<string, unknown>)[GLOBAL_MIN_TRACK_LENGTH_KEY];
	return typeof value === "number" && Number.isFinite(value)
		? clamp(Math.floor(value), MIN_TRACK_LENGTH, MAX_TRACK_LENGTH)
		: DEFAULT_MIN_TRACK_LENGTH;
}

function setGlobalHueStep(stepDeg: number): void {
	(globalThis as Record<string, unknown>)[GLOBAL_HUE_STEP_KEY] = stepDeg;
}

function getGlobalHueStep(): number {
	const value = (globalThis as Record<string, unknown>)[GLOBAL_HUE_STEP_KEY];
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_HUE_STEP_DEG;
	return clamp(value, 0.2, 60);
}

function setGlobalBellEnabled(enabled: boolean): void {
	(globalThis as Record<string, unknown>)[GLOBAL_BELL_ENABLED_KEY] = enabled;
}

function getGlobalBellEnabled(): boolean {
	const value = (globalThis as Record<string, unknown>)[GLOBAL_BELL_ENABLED_KEY];
	return typeof value === "boolean" ? value : DEFAULT_BELL_ENABLED;
}

function setGlobalBellDebounceMs(debounceMs: number): void {
	(globalThis as Record<string, unknown>)[GLOBAL_BELL_DEBOUNCE_MS_KEY] = debounceMs;
}

function getGlobalBellDebounceMs(): number {
	const value = (globalThis as Record<string, unknown>)[GLOBAL_BELL_DEBOUNCE_MS_KEY];
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BELL_DEBOUNCE_MS;
	return clamp(Math.floor(value), MIN_BELL_DEBOUNCE_MS, MAX_BELL_DEBOUNCE_MS);
}

function getGlobalLastBellRingMs(): number {
	const value = (globalThis as Record<string, unknown>)[GLOBAL_BELL_LAST_RING_MS_KEY];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function setGlobalLastBellRingMs(ms: number): void {
	(globalThis as Record<string, unknown>)[GLOBAL_BELL_LAST_RING_MS_KEY] = ms;
}

function ringBell(force = false): void {
	if (!getGlobalBellEnabled()) return;
	if (!process.stdout.isTTY) return;

	const now = Date.now();
	if (!force) {
		const elapsed = now - getGlobalLastBellRingMs();
		if (elapsed >= 0 && elapsed < getGlobalBellDebounceMs()) return;
	}

	setGlobalLastBellRingMs(now);
	process.stdout.write(BELL_CHAR);
}

function encodeFrameStep(step: number): string {
	return `${FRAME_TOKEN_PREFIX}${step}`;
}

function decodeFrameStep(message: string): number | undefined {
	if (!message.startsWith(FRAME_TOKEN_PREFIX)) return undefined;
	const raw = message.slice(FRAME_TOKEN_PREFIX.length);
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.max(0, parsed);
}

function resolveTrackLength(width: number, _minimumLength: number): number {
	if (width <= 0) return 0;
	return width;
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
	const hue = ((h % 360) + 360) % 360;
	const c = v * s;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = v - c;

	let rPrime = 0;
	let gPrime = 0;
	let bPrime = 0;

	if (hue < 60) {
		rPrime = c;
		gPrime = x;
	} else if (hue < 120) {
		rPrime = x;
		gPrime = c;
	} else if (hue < 180) {
		gPrime = c;
		bPrime = x;
	} else if (hue < 240) {
		gPrime = x;
		bPrime = c;
	} else if (hue < 300) {
		rPrime = x;
		bPrime = c;
	} else {
		rPrime = c;
		bPrime = x;
	}

	return {
		r: Math.round((rPrime + m) * 255),
		g: Math.round((gPrime + m) * 255),
		b: Math.round((bPrime + m) * 255),
	};
}

function smoothPipeColor(step: number): string {
	const hue = step * getGlobalHueStep();
	const { r, g, b } = hsvToRgb(hue, 0.85, 1);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function phasedPositionForStep(step: number, length: number, phaseCount: number): { position: number; phase: number } {
	if (length <= 1) return { position: 0, phase: Math.floor(phaseCount / 2) };

	const safePhaseCount = Math.max(1, phaseCount);
	const travelUnits = (length - 1) * safePhaseCount;
	if (travelUnits <= 0) return { position: 0, phase: Math.floor(safePhaseCount / 2) };

	const cycle = travelUnits * 2;
	const raw = step % cycle;
	const unit = raw <= travelUnits ? raw : cycle - raw;

	const position = Math.max(0, Math.min(length - 1, Math.floor(unit / safePhaseCount)));
	const phase = unit % safePhaseCount;
	return { position, phase };
}

function frameForStep(step: number, length: number): string {
	const { position, phase } = phasedPositionForStep(step, length, PIPE_PHASE_CHARS.length);
	const marker = PIPE_PHASE_CHARS[phase] ?? PIPE_PHASE_CHARS[1];
	const color = smoothPipeColor(step);
	const left = " ".repeat(position);
	const right = " ".repeat(Math.max(0, length - position - 1));
	return `${left}${color}${marker}${RESET_FG}${right}`;
}

function centerLine(width: number, text: string): string {
	if (width <= 0) return "";
	const finalText = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	const textWidth = visibleWidth(finalText);
	const leftPad = Math.max(0, Math.floor((width - textWidth) / 2));
	const rightPad = Math.max(0, width - leftPad - textWidth);
	return `${" ".repeat(leftPad)}${finalText}${" ".repeat(rightPad)}`;
}

function padToVisibleWidth(text: string, width: number): string {
	if (width <= 0) return "";
	const finalText = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	const textWidth = visibleWidth(finalText);
	if (textWidth >= width) return finalText;
	return `${finalText}${" ".repeat(width - textWidth)}`;
}

interface TrackedEntry {
	setExpanded?(expanded: boolean): void;
	invalidate?(): void;
	render?(width: number): string[];
	children?: unknown[];
	mouseLayout?: { width: number; children: Array<{ component: unknown; height: number }> };
	constructor?: { name?: string };
}

interface EntryRegistry {
	entries: TrackedEntry[];
	seen: WeakSet<object>;
}

/** The slice of pi-tui's `ScrollView` used to move the transcript. */
export interface ScrollViewLike {
	scrollTop: number;
	viewportHeight: number;
	scrollTo(top: number): void;
	child?: unknown;
	children?: unknown[];
	primary?: boolean;
}

export interface EntryPosition {
	component: TrackedEntry;
	top: number;
	height: number;
}

function getEntryRegistry(): EntryRegistry {
	const globalAny = globalThis as Record<string, unknown>;
	const existing = globalAny[EXPANDABLE_REGISTRY_KEY] as EntryRegistry | undefined;
	if (existing) return existing;
	const created: EntryRegistry = { entries: [], seen: new WeakSet() };
	globalAny[EXPANDABLE_REGISTRY_KEY] = created;
	return created;
}

function componentClassName(component: object): string | undefined {
	return (component as { constructor?: { name?: string } }).constructor?.name;
}

/** True for the transcript entry components pi renders in the chat container. */
export function isTrackedEntry(component: unknown): component is TrackedEntry {
	if (!component || typeof component !== "object") return false;
	const name = componentClassName(component);
	return name !== undefined && TRACKED_ENTRY_COMPONENT_NAMES.has(name);
}

/** True for tracked entries with a collapsed/expanded state. */
export function isExpandableEntry(component: unknown): component is TrackedEntry {
	if (!isTrackedEntry(component)) return false;
	if (typeof component.setExpanded !== "function") return false;
	const name = componentClassName(component);
	return name !== undefined && EXPANDABLE_ENTRY_COMPONENT_NAMES.has(name);
}

function registerEntry(component: unknown): void {
	if (!isTrackedEntry(component)) return;
	const registry = getEntryRegistry();
	if (registry.seen.has(component)) return;
	registry.seen.add(component);
	registry.entries.push(component);
	const overflow = registry.entries.length - MAX_TRACKED_EXPANDABLES;
	if (overflow > 0) registry.entries.splice(0, overflow);
}

function registerEntries(components: readonly unknown[]): void {
	for (const component of components) registerEntry(component);
}

function unregisterEntries(components: readonly unknown[]): void {
	const registry = getEntryRegistry();
	if (registry.entries.length === 0) return;
	const dropped = new Set(components.filter(isTrackedEntry));
	if (dropped.size === 0) return;
	for (const entry of dropped) registry.seen.delete(entry);
	registry.entries = registry.entries.filter((entry) => !dropped.has(entry));
}

/** Forget tracked entries. */
export function resetEntryTracking(): void {
	const globalAny = globalThis as Record<string, unknown>;
	globalAny[EXPANDABLE_REGISTRY_KEY] = { entries: [], seen: new WeakSet() } satisfies EntryRegistry;
}

/**
 * Track transcript entries in display order.
 *
 * pi keeps expansion state and transcript positions internally but only exposes
 * a single global toggle to extensions, so entries are observed as containers
 * add, drop, and render their children. Rendering is what backfills entries that
 * already existed when this extension loaded (startup, session restore, `/reload`).
 */
export function installEntryTracking(): void {
	const globalAny = globalThis as Record<string, unknown>;
	const installedRaw = globalAny[EXPANDABLE_PATCHED_METHODS_KEY];
	const installed = installedRaw instanceof Set ? (installedRaw as Set<string>) : new Set<string>();
	globalAny[EXPANDABLE_PATCHED_METHODS_KEY] = installed;

	type PatchableContainer = {
		addChild(component: unknown): void;
		removeChild(component: unknown): void;
		clear(): void;
		render(width: number): string[];
	};

	const prototype = Container.prototype as unknown as PatchableContainer;

	if (!installed.has("addChild")) {
		const originalAddChild = prototype.addChild;
		prototype.addChild = function patchedAddChild(this: unknown, component: unknown) {
			registerEntry(component);
			return originalAddChild.call(this, component);
		};
		installed.add("addChild");
	}

	if (!installed.has("removeChild")) {
		const originalRemoveChild = prototype.removeChild;
		prototype.removeChild = function patchedRemoveChild(this: unknown, component: unknown) {
			unregisterEntries([component]);
			return originalRemoveChild.call(this, component);
		};
		installed.add("removeChild");
	}

	if (!installed.has("clear")) {
		const originalClear = prototype.clear;
		prototype.clear = function patchedClear(this: unknown) {
			const children = (this as { children?: unknown[] }).children;
			if (Array.isArray(children) && children.length > 0) unregisterEntries(children);
			return originalClear.call(this);
		};
		installed.add("clear");
	}

	if (!installed.has("render")) {
		const originalRender = prototype.render;
		prototype.render = function patchedRender(this: unknown, width: number) {
			const children = (this as { children?: unknown[] }).children;
			if (Array.isArray(children) && children.length > 0) registerEntries(children);
			return originalRender.call(this, width);
		};
		installed.add("render");
	}
}

function isEntryExpanded(entry: TrackedEntry): boolean {
	const record = entry as unknown as Record<string, unknown>;
	if (typeof record.expanded === "boolean") return record.expanded;
	if (typeof record._expanded === "boolean") return record._expanded;
	return false;
}

/** Class names of tracked entries, oldest → newest (debug helper). */
export function listTrackedEntries(): string[] {
	return getEntryRegistry().entries.map((entry) => componentClassName(entry) ?? "entry");
}

/** Toggle the newest tracked expandable entry, the same way clicking it would. */
export function toggleNewestExpandable(): { name: string; expanded: boolean } | undefined {
	const registry = getEntryRegistry();
	for (let index = registry.entries.length - 1; index >= 0; index -= 1) {
		const entry = registry.entries[index];
		if (!isExpandableEntry(entry)) continue;
		const expanded = !isEntryExpanded(entry);
		entry.setExpanded?.(expanded);
		entry.invalidate?.();
		return { name: componentClassName(entry) ?? "entry", expanded };
	}
	return undefined;
}

function childRenderedHeight(component: TrackedEntry, width: number): number {
	if (typeof component.render !== "function") return 0;
	try {
		return component.render(width).length;
	} catch {
		return 0;
	}
}

function recordedChildHeights(container: TrackedEntry, width: number): number[] | undefined {
	const layout = container.mouseLayout;
	if (!layout || layout.width !== width || !Array.isArray(layout.children)) return undefined;
	return layout.children.map((child) => child.height);
}

function collectEntryPositions(
	container: TrackedEntry,
	baseTop: number,
	width: number,
	out: EntryPosition[],
): void {
	const children = Array.isArray(container.children) ? container.children : [];
	if (children.length === 0) return;
	const recorded = recordedChildHeights(container, width);
	let y = 0;
	for (let index = 0; index < children.length; index += 1) {
		const child = children[index] as TrackedEntry;
		const height = recorded?.[index] ?? childRenderedHeight(child, width);
		const top = baseTop + y;
		if (isTrackedEntry(child)) {
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
	collectEntryPositions(root as TrackedEntry, 0, width, positions);
	return positions;
}

/** Top offset of the first entry below the given scroll offset. */
export function findNextEntryTop(positions: readonly EntryPosition[], scrollTop: number): number | undefined {
	for (const position of positions) {
		if (position.top > scrollTop) return position.top;
	}
	return undefined;
}

/** Top offset of the last entry above the given scroll offset. */
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

/** The TUI reference captured from a widget factory (see captureTuiReference). */
export function getTuiReference(): unknown {
	return (globalThis as Record<string, unknown>)[TUI_REFERENCE_KEY];
}

/**
 * Capture the live TUI instance through `setWidget`, whose factory receives it.
 * The widget renders nothing; it only exists to obtain the reference.
 */
export function captureTuiReference(ctx: ExtensionContext): unknown {
	if (ctx.hasUI) {
		ctx.ui.setWidget(TUI_CAPTURE_WIDGET_KEY, (tui) => {
			(globalThis as Record<string, unknown>)[TUI_REFERENCE_KEY] = tui;
			return { render: () => [], invalidate: () => {} };
		});
	}
	return getTuiReference();
}

function isScrollViewLike(candidate: unknown): candidate is ScrollViewLike {
	if (!candidate || typeof candidate !== "object") return false;
	const record = candidate as Record<string, unknown>;
	return (
		typeof record.scrollTo === "function" &&
		typeof record.scrollBy === "function" &&
		typeof record.scrollTop === "number"
	);
}

function findScrollViewLike(node: unknown, depth: number): ScrollViewLike | undefined {
	if (!node || typeof node !== "object" || depth > 6) return undefined;
	const children = (node as { children?: unknown[] }).children;
	if (!Array.isArray(children)) return undefined;
	for (const child of children) {
		if (isScrollViewLike(child) && child.primary) return child;
	}
	for (const child of children) {
		const found = findScrollViewLike(child, depth + 1);
		if (found) return found;
	}
	return undefined;
}

/** Locate the primary transcript scroll view (fullscreen alt-screen mode). */
export function getTranscriptScrollView(tui: unknown): ScrollViewLike | undefined {
	if (!tui || typeof tui !== "object") return undefined;
	const candidate = tui as { getPrimaryScrollView?: () => unknown; layoutRoot?: unknown; children?: unknown[] };
	if (typeof candidate.getPrimaryScrollView === "function") {
		const primary = candidate.getPrimaryScrollView();
		if (isScrollViewLike(primary)) return primary;
	}
	return findScrollViewLike(candidate.layoutRoot ?? candidate, 0);
}

function scrollContentWidth(scrollView: ScrollViewLike, tui: unknown): number {
	const content = scrollView.child as TrackedEntry | undefined;
	const recorded = content?.mouseLayout?.width;
	if (typeof recorded === "number" && recorded > 0) return recorded;
	const columns = (tui as { terminal?: { columns?: number } } | undefined)?.terminal?.columns;
	return Math.max(1, (typeof columns === "number" ? columns : 80) - 1);
}

/**
 * Move the transcript so the next (direction 1) or previous (direction -1) entry
 * starts at the top of the viewport. Clamps to the document start and end.
 */
export function scrollToEntry(
	tui: unknown,
	direction: 1 | -1,
): { index: number; total: number; name: string; top: number } | undefined {
	const scrollView = getTranscriptScrollView(tui);
	if (!scrollView || !scrollView.child) return undefined;
	const positions = computeEntryPositions(scrollView.child, scrollContentWidth(scrollView, tui));
	if (positions.length === 0) return undefined;

	const currentTop = typeof scrollView.scrollTop === "number" ? scrollView.scrollTop : 0;
	const target = direction === 1 ? findNextEntryTop(positions, currentTop) : findPreviousEntryTop(positions, currentTop);
	const top = target ?? (direction === 1 ? Number.MAX_SAFE_INTEGER : 0);
	scrollView.scrollTo(top);

	const index = positions.findIndex((position) => position.top === target);
	if (index >= 0) {
		return {
			index,
			total: positions.length,
			name: componentClassName(positions[index]?.component ?? {}) ?? "entry",
			top: target ?? top,
		};
	}
	return { index: -1, total: positions.length, name: "start/end", top };
}

function patchLoaderWorkingSpinner(): void {
	const globalAny = globalThis as Record<string, unknown>;
	if (globalAny[PATCH_FLAG]) return;

	type LoaderPrivate = Loader & {
		start: (...args: unknown[]) => unknown;
		render: (width: number) => string[];
		updateDisplay?: (...args: unknown[]) => unknown;
		message?: string;
		frames?: string[];
		currentFrame?: number;
		paddingX?: number;
		setText: (text: string) => void;
		ui?: { requestRender?: () => void };
		[WORKING_INSTANCE_FLAG]?: boolean;
	};

	const loaderPrototype = Loader.prototype as unknown as LoaderPrivate;
	const originalStart = loaderPrototype.start;
	const originalRender = loaderPrototype.render;
	const originalUpdateDisplay = loaderPrototype.updateDisplay;

	loaderPrototype.start = function patchedStart(this: Loader, ...args: unknown[]) {
		const self = this as unknown as LoaderPrivate;
		const message = typeof self.message === "string" ? self.message : "";
		if (message.startsWith("Working...")) {
			self[WORKING_INSTANCE_FLAG] = true;
			self.frames = [""];
			self.currentFrame = 0;
			self.paddingX = 0;
		}
		return originalStart.apply(this, args as []);
	};

	loaderPrototype.render = function patchedRender(this: Loader, width: number) {
		const self = this as unknown as LoaderPrivate;
		if (self[WORKING_INSTANCE_FLAG]) {
			const message = typeof self.message === "string" ? self.message : "";
			const step = decodeFrameStep(message);

			const content =
				typeof step === "number"
					? frameForStep(step, resolveTrackLength(width, getGlobalMinTrackLength()))
					: message;

			return ["", centerLine(width, content)];
		}
		return originalRender.call(this, width);
	};

	if (typeof originalUpdateDisplay === "function") {
		loaderPrototype.updateDisplay = function patchedUpdateDisplay(this: Loader, ...args: unknown[]) {
			const self = this as unknown as LoaderPrivate;
			if (self[WORKING_INSTANCE_FLAG]) {
				const message = typeof self.message === "string" ? self.message : "";
				self.setText(message);
				self.ui?.requestRender?.();
				return;
			}
			return originalUpdateDisplay.apply(this, args as []);
		};
	}

	globalAny[PATCH_FLAG] = true;
}

function notify(ctx: ExtensionContext, message: string): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, "info");
}

type BellPatchableUIContext = ExtensionContext["ui"] & {
	[UI_INPUT_PATCH_FLAG]?: boolean;
};

function patchUiInputBell(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const ui = ctx.ui as BellPatchableUIContext;
	if (ui[UI_INPUT_PATCH_FLAG]) return;

	const wrapPromptMethod = (methodName: "select" | "confirm" | "input" | "editor" | "custom") => {
		const original = ui[methodName];
		ui[methodName] = (async (...args: unknown[]) => {
			ringBell();
			return await (original as (...innerArgs: unknown[]) => Promise<unknown>).apply(ui, args);
		}) as BellPatchableUIContext[typeof methodName];
	};

	wrapPromptMethod("select");
	wrapPromptMethod("confirm");
	wrapPromptMethod("input");
	wrapPromptMethod("editor");
	wrapPromptMethod("custom");
	ui[UI_INPUT_PATCH_FLAG] = true;
}

function notifyInputExpected(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	patchUiInputBell(ctx);
	ringBell();
}

function notifyInputExpectedIfReady(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (!ctx.isIdle()) return;
	if (ctx.hasPendingMessages()) return;
	notifyInputExpected(ctx);
}

type SessionEntry = {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
	};
};

type ContentBlock = {
	type?: string;
	text?: string;
	textSignature?: string;
};

function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") {
		return content.trim() ? [content] : [];
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const maybeText = block as ContentBlock;
		if (maybeText.type !== "text") continue;
		if (typeof maybeText.text !== "string") continue;
		if (!maybeText.text.trim()) continue;
		parts.push(maybeText.text);
	}

	return parts;
}

function getUserPrompts(ctx: ExtensionContext): string[] {
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	const prompts: string[] = [];

	for (const entry of branch) {
		if (entry?.type !== "message") continue;
		if (entry.message?.role !== "user") continue;
		const text = extractTextParts(entry.message.content).join("\n").trim();
		if (!text) continue;
		prompts.push(text);
	}

	return prompts;
}

function isCommentaryTextBlock(block: ContentBlock): boolean {
	if (!block.textSignature) return false;
	try {
		const signature = JSON.parse(block.textSignature) as { phase?: unknown };
		return signature.phase === "commentary";
	} catch {
		return false;
	}
}

function extractFinalAssistantText(message: SessionEntry["message"]): string | undefined {
	if (!message || message.role !== "assistant" || message.stopReason !== "stop") return undefined;
	if (!Array.isArray(message.content)) return undefined;
	if (message.content.some((block) => block && typeof block === "object" && (block as ContentBlock).type === "toolCall")) {
		return undefined;
	}

	const parts: string[] = [];
	for (const block of message.content) {
		if (!block || typeof block !== "object") continue;
		const textBlock = block as ContentBlock;
		if (textBlock.type !== "text" || typeof textBlock.text !== "string") continue;
		if (isCommentaryTextBlock(textBlock) || !textBlock.text.trim()) continue;
		parts.push(textBlock.text);
	}
	const text = parts.join("\n").trim();
	return text || undefined;
}

function getFinalAssistantResponses(ctx: ExtensionContext): string[] {
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	const responses: string[] = [];
	let turnResponse: string | undefined;
	let hasUserPrompt = false;

	for (const entry of branch) {
		if (entry?.type !== "message") continue;
		if (entry.message?.role === "user") {
			if (hasUserPrompt && turnResponse) responses.push(turnResponse);
			hasUserPrompt = true;
			turnResponse = undefined;
			continue;
		}
		if (!hasUserPrompt) continue;
		const finalText = extractFinalAssistantText(entry.message);
		if (finalText) turnResponse = finalText;
	}
	if (hasUserPrompt && turnResponse) responses.push(turnResponse);
	return responses;
}

function sanitizePreviewText(input: string): string {
	// Strip ANSI escape sequences and control chars that can break layout width.
	const withoutAnsi = input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1B[@-_]/g, "");
	return withoutAnsi.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function wrapLineSoft(line: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const input = sanitizePreviewText(line).replace(/\t/g, "  ");
	if (input.length === 0) return [""];

	const out: string[] = [];
	let current = "";
	let currentWidth = 0;

	for (const ch of input) {
		const chWidth = Math.max(0, visibleWidth(ch));
		if (currentWidth + chWidth > safeWidth && current.length > 0) {
			out.push(current);
			current = "";
			currentWidth = 0;
		}
		current += ch;
		currentWidth += chWidth;
	}

	if (current.length > 0 || out.length === 0) out.push(current);
	return out;
}

function previewLinesSoftWrapped(text: string | undefined, maxLines: number, lineWidth: number): string[] {
	if (maxLines <= 0) return [];
	if (!text) return ["(none)"];

	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const sourceLines = normalized.split("\n");
	const wrapped: string[] = [];

	for (const sourceLine of sourceLines) {
		if (wrapped.length >= maxLines) break;
		for (const chunk of wrapLineSoft(sourceLine, lineWidth)) {
			if (wrapped.length >= maxLines) break;
			wrapped.push(chunk);
		}
	}

	return wrapped.length > 0 ? wrapped : ["(empty)"];
}

async function showPromptPreviewDialog(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const prompts = getUserPrompts(ctx);
	const responses = getFinalAssistantResponses(ctx);
	type PromptTab = "prompts" | "first" | "responses";
	const tabs: Array<{ id: PromptTab; label: string }> = [
		{ id: "prompts", label: "User prompts" },
		{ id: "first", label: "First prompt" },
		{ id: "responses", label: "Agent responses" },
	];

	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			let closed = false;
			let activeTabIndex = 1;
			let promptOffset = 0;
			let responseOffset = 0;
			const textScroll: Record<PromptTab, number> = { prompts: 0, first: 0, responses: 0 };
			const closeDialog = (): void => {
				if (closed) return;
				closed = true;
				done();
			};
			const activeTab = (): PromptTab => tabs[activeTabIndex]?.id ?? "first";
			const moveHistory = (delta: number): void => {
				const tab = activeTab();
				if (tab === "prompts") {
					const nextOffset = clamp(promptOffset + delta, 0, Math.max(0, prompts.length - 1));
					if (nextOffset !== promptOffset) textScroll.prompts = 0;
					promptOffset = nextOffset;
				} else if (tab === "responses") {
					const nextOffset = clamp(responseOffset + delta, 0, Math.max(0, responses.length - 1));
					if (nextOffset !== responseOffset) textScroll.responses = 0;
					responseOffset = nextOffset;
				}
			};

			return {
				render(width: number) {
					const maxDialogHeight = Math.floor(tui.terminal.rows * 0.85);
					if (width < 12 || maxDialogHeight < 10) return [];
					const frameWidth = Math.max(1, width - 2);
					const contentWidth = Math.max(1, frameWidth - 2);
					const border = (text: string): string => theme.fg("thinkingHigh", text);
					const fit = (text: string): string => padToVisibleWidth(truncateToWidth(text, contentWidth, ""), contentWidth);
					const frame = (text: string): string => ` ${border("┃")}${fit(text)}${border("┃")} `;
					const titleText = truncateToWidth(" Prompt history ", Math.max(1, contentWidth - 3), "");
					const topFill = "━".repeat(Math.max(0, contentWidth - visibleWidth(titleText) - 3));
					const top = ` ${border("╭━╾")}${border(theme.bold(titleText))}${border(`╼${topFill}╮`)} `;
					const tabText = tabs
						.map((tab, index) => {
							const label = ` ${tab.label} `;
							return index === activeTabIndex ? border(theme.bold(`╾${label}╼`)) : theme.fg("dim", label);
						})
						.join("   ");

					const tab = activeTab();
					let selectedText: string | undefined;
					let heading = "First user prompt";
					let position = prompts.length > 0 ? "1 of 1" : "0 of 0";
					if (tab === "prompts") {
						selectedText = prompts[prompts.length - 1 - promptOffset];
						heading = promptOffset === 0 ? "Latest user prompt" : `User prompt -${promptOffset}`;
						position = prompts.length > 0 ? `${promptOffset + 1} of ${prompts.length}` : "0 of 0";
					} else if (tab === "responses") {
						selectedText = responses[responses.length - 1 - responseOffset];
						heading = responseOffset === 0 ? "Latest agent response" : `Agent response -${responseOffset}`;
						position = responses.length > 0 ? `${responseOffset + 1} of ${responses.length}` : "0 of 0";
					} else {
						selectedText = prompts[0];
					}

					const maxBodyLines = Math.max(0, maxDialogHeight - 10);
					const textWidth = Math.max(1, contentWidth - 4);
					const allBodyLines = previewLinesSoftWrapped(selectedText, Number.MAX_SAFE_INTEGER, textWidth);
					const maxScroll = Math.max(0, allBodyLines.length - maxBodyLines);
					textScroll[tab] = clamp(textScroll[tab], 0, maxScroll);
					const bodyLines = allBodyLines.slice(textScroll[tab], textScroll[tab] + maxBodyLines);
					const scrollPosition =
						allBodyLines.length > maxBodyLines && maxBodyLines > 0
							? ` · lines ${textScroll[tab] + 1}-${textScroll[tab] + bodyLines.length}/${allBodyLines.length}`
							: "";
					return [
						" ".repeat(width),
						top,
						frame(centerLine(contentWidth, tabText)),
						` ${border(`┣${"━".repeat(contentWidth)}┫`)} `,
						frame(` ${theme.bold(heading)}${" ".repeat(Math.max(1, contentWidth - visibleWidth(heading) - visibleWidth(position) - 2))}${theme.fg("dim", position)} `),
						frame(""),
						...bodyLines.map((line) => frame(`  ${theme.italic(line)}`)),
						frame(""),
						frame(theme.fg("dim", ` ←/→ tabs · ↑/PgUp older · ↓/PgDn newer · j/k scroll 5 lines${scrollPosition} · Esc/Enter/q close`)),
						` ${border(`╰${"━".repeat(contentWidth)}╯`)} `,
						" ".repeat(width),
					];
				},
				invalidate() {},
				handleInput(data: string) {
					if (
						matchesKey(data, Key.escape) || data === ESC ||
						matchesKey(data, Key.enter) || matchesKey(data, Key.return) ||
						data === "q" || data === "Q" || matchesKey(data, ACTION_DIALOG_TOGGLE_SHORTCUT)
					) {
						closeDialog();
						return;
					}
					if (matchesKey(data, Key.left) || data === "h" || data === "H") {
						activeTabIndex = (activeTabIndex - 1 + tabs.length) % tabs.length;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.right) || data === "l" || data === "L") {
						activeTabIndex = (activeTabIndex + 1) % tabs.length;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp)) {
						moveHistory(1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) {
						moveHistory(-1);
						tui.requestRender();
						return;
					}
					if (data === "k" || data === "K") {
						const tab = activeTab();
						textScroll[tab] = Math.max(0, textScroll[tab] - 5);
						tui.requestRender();
						return;
					}
					if (data === "j" || data === "J") {
						const tab = activeTab();
						textScroll[tab] += 5;
						tui.requestRender();
					}
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "100%",
				minWidth: 40,
				maxHeight: "85%",
				margin: 1,
			},
		},
	);
}

async function showHiDialog(
	ctx: ExtensionContext,
	handlers: {
		onToggleReader: () => void;
		onToggleOuter: () => void;
		onSetYoloPlus: () => void;
		onShowPromptPreviews: () => Promise<void>;
		onPromptStashStash: () => void;
		onPromptStashPop: () => void;
		onPromptStashList: () => void;
		onPromptStashClearAll: () => void;
		onOpenNote: () => Promise<void>;
		onListNotes: () => Promise<void>;
		onToggleAgentsRewire: () => void;
		onOpenAgentsRewire: () => void;
		onOpenAgentsManager: () => void;
		isAgentsRewireEnabled: () => boolean;
	},
	dialogLifecycle: {
		isShown: () => boolean;
		onShown: (requestClose: () => void) => void;
		onHidden: () => void;
	},
): Promise<void> {
	if (!ctx.hasUI) return;
	if (dialogLifecycle.isShown()) return;

	let closeFromInside: (() => void) | undefined;
	let closeRequestedBeforeInit = false;
	const requestClose = () => {
		if (closeFromInside) {
			closeFromInside();
			return;
		}
		closeRequestedBeforeInit = true;
	};
	dialogLifecycle.onShown(requestClose);

	try {
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const {
					onToggleReader,
					onToggleOuter,
					onSetYoloPlus,
					onShowPromptPreviews,
					onPromptStashStash,
					onPromptStashPop,
					onPromptStashList,
					onPromptStashClearAll,
					onOpenNote,
					onListNotes,
					onToggleAgentsRewire,
					onOpenAgentsRewire,
					onOpenAgentsManager,
					isAgentsRewireEnabled,
				} = handlers;
				let selectedIndex = 0;
				let closed = false;
				const closeDialog = (): void => {
					if (closed) return;
					closed = true;
					done();
				};
				closeFromInside = closeDialog;
				if (closeRequestedBeforeInit) {
					closeDialog();
				}
				type DialogState = { readerOn: boolean; outerOn: boolean; yoloPlusOn: boolean };
				type DialogGroup = "PROMPTS & NOTES" | "AGENTS" | "ACCESS & SAFETY";
				type DialogAction = {
					hotkey: string;
					hotkeyAliases?: string[];
					hotkeyLabel?: string;
					label: string;
					group?: DialogGroup;
					toggleSeverity?: "none" | "warning" | "danger";
					showStatusBadge?: boolean;
					opensMenu?: boolean;
					searchable?: boolean;
					isEnabled: (state: DialogState) => boolean;
					run: () => void | Promise<void>;
					runWithKey?: (key: string) => void | Promise<void>;
					closeAfterRun?: boolean;
				};
				type DialogMenu = "main" | "stash";
				type SearchAction = {
					action: DialogAction;
					menu: DialogMenu;
					label?: string;
					hotkeyLabel?: string;
					executeKey?: string;
				};

				const getSafeModeUiState = (): DialogState => {
					type MaybeSafeModeEntry = {
						type?: string;
						customType?: string;
						data?: { mode?: unknown; outerAccess?: unknown };
					};

					let mode = "smart";
					let outerAccess = false;
					for (const entry of ctx.sessionManager.getBranch() as MaybeSafeModeEntry[]) {
						if (entry.type !== "custom" || entry.customType !== "safe-mode") continue;
						const nextMode = entry.data?.mode;
						if (typeof nextMode === "string") mode = nextMode.trim().toLowerCase();
						const nextOuterAccess = entry.data?.outerAccess;
						if (typeof nextOuterAccess === "boolean") outerAccess = nextOuterAccess;
					}

					return {
						readerOn: mode === "reader",
						outerOn: mode !== "paranoid" && outerAccess,
						yoloPlusOn: mode === "yolo" && outerAccess,
					};
				};

				let activeMenu: DialogMenu = "main";
				let searchMode = false;
				let searchQuery = "";
				let searchReturnIndex = 0;

				const runAfterClose = (fn: () => void): void => {
					closeDialog();
					setTimeout(fn, 0);
				};

				const setMenu = (menu: DialogMenu): void => {
					activeMenu = menu;
					searchMode = false;
					searchQuery = "";
					selectedIndex = 0;
					tui.requestRender();
				};

				const dialogGroupOrder: DialogGroup[] = ["PROMPTS & NOTES", "AGENTS", "ACCESS & SAFETY"];
				const mainActions: DialogAction[] = [
					{
						hotkey: "s",
						hotkeyAliases: ["S"],
						label: "Prompt stash…",
						group: "PROMPTS & NOTES",
						showStatusBadge: false,
						opensMenu: true,
						isEnabled: () => true,
						closeAfterRun: false,
						run: () => setMenu("stash"),
					},
					{
						hotkey: "a",
						hotkeyAliases: ["A"],
						label: "Subagents…",
						group: "AGENTS",
						showStatusBadge: false,
						opensMenu: true,
						isEnabled: () => true,
						closeAfterRun: false,
						run: () => runAfterClose(onOpenAgentsManager),
					},
					{
						hotkey: Key.ctrlShift("r"),
						hotkeyLabel: "Ctrl+R",
						label: "Agents rewiring…",
						group: "AGENTS",
						showStatusBadge: false,
						opensMenu: true,
						isEnabled: () => true,
						closeAfterRun: false,
						run: () => runAfterClose(onOpenAgentsRewire),
					},
					{
						hotkey: Key.ctrl("r"),
						hotkeyLabel: "Ctrl+r",
						label: "Rewire agents",
						group: "AGENTS",
						toggleSeverity: "danger",
						isEnabled: () => isAgentsRewireEnabled(),
						closeAfterRun: false,
						run: () => runAfterClose(onToggleAgentsRewire),
					},
					{
						hotkey: "r",
						hotkeyAliases: ["R"],
						label: "Reader mode",
						group: "ACCESS & SAFETY",
						toggleSeverity: "none",
						isEnabled: (state) => state.readerOn,
						run: onToggleReader,
					},
					{
						hotkey: "+",
						label: "Outer access",
						group: "ACCESS & SAFETY",
						toggleSeverity: "warning",
						isEnabled: (state) => state.outerOn,
						run: onToggleOuter,
					},
					{
						hotkey: "!",
						label: "YOLO+",
						group: "ACCESS & SAFETY",
						toggleSeverity: "danger",
						isEnabled: (state) => state.yoloPlusOn,
						run: onSetYoloPlus,
					},
					{
						hotkey: "p",
						hotkeyAliases: ["P"],
						label: "Prompt history…",
						group: "PROMPTS & NOTES",
						showStatusBadge: false,
						opensMenu: true,
						isEnabled: () => true,
						closeAfterRun: false,
						run: async () => {
							closeDialog();
							await new Promise((resolve) => setTimeout(resolve, 0));
							await onShowPromptPreviews();
						},
					},
					{
						hotkey: "n",
						hotkeyAliases: ["N"],
						hotkeyLabel: "n/N",
						label: "New note / browse notes…",
						group: "PROMPTS & NOTES",
						showStatusBadge: false,
						opensMenu: true,
						isEnabled: () => true,
						closeAfterRun: false,
						run: () => runAfterClose(() => void onOpenNote()),
						runWithKey: (key) => runAfterClose(() => void (key === "N" ? onListNotes() : onOpenNote())),
					},
				];
				mainActions.sort(
					(left, right) => dialogGroupOrder.indexOf(left.group!) - dialogGroupOrder.indexOf(right.group!),
				);

				const stashActions: DialogAction[] = [
					{
						hotkey: "s",
						hotkeyAliases: ["S"],
						label: "Stash prompt draft",
						showStatusBadge: false,
						isEnabled: () => true,
						closeAfterRun: false,
						run: () => runAfterClose(onPromptStashStash),
					},
					{
						hotkey: "o",
						hotkeyAliases: ["O"],
						label: "Pop newest prompt stash",
						showStatusBadge: false,
						isEnabled: () => true,
						closeAfterRun: false,
						run: () => runAfterClose(onPromptStashPop),
					},
					{
						hotkey: "l",
						hotkeyAliases: ["L"],
						label: "List and restore stashes…",
						showStatusBadge: false,
						opensMenu: true,
						isEnabled: () => true,
						closeAfterRun: false,
						run: () => runAfterClose(onPromptStashList),
					},
					{
						hotkey: "x",
						hotkeyAliases: ["X"],
						label: "Clear all stashes",
						showStatusBadge: false,
						isEnabled: () => true,
						closeAfterRun: false,
						run: () => runAfterClose(onPromptStashClearAll),
					},
					{
						hotkey: "<-",
						hotkeyAliases: [Key.backspace],
						hotkeyLabel: "←",
						label: "Back",
						showStatusBadge: false,
						searchable: false,
						isEnabled: () => true,
						closeAfterRun: false,
						run: () => setMenu("main"),
					},
				];

				const searchableActions: SearchAction[] = [
					...mainActions.flatMap((action): SearchAction[] =>
						action.hotkeyLabel === "n/N"
							? [
									{ action, menu: "main", label: "New note…", hotkeyLabel: "n", executeKey: "n" },
									{ action, menu: "main", label: "Browse notes…", hotkeyLabel: "N", executeKey: "N" },
								]
							: [{ action, menu: "main" }],
					),
					...stashActions
						.filter((action) => action.searchable !== false)
						.map((action) => ({ action, menu: "stash" as const })),
				];
				const getActions = (): DialogAction[] => (activeMenu === "stash" ? stashActions : mainActions);
				const getSearchActions = (): SearchAction[] => {
					const query = searchQuery.trim().toLowerCase();
					if (!query) return [];
					const terms = query.split(/\s+/).filter(Boolean);
					return searchableActions.filter(({ action, menu, label, hotkeyLabel }) => {
						const haystack = [
							label ?? action.label,
							hotkeyLabel ?? action.hotkeyLabel ?? action.hotkey,
							...(action.hotkeyAliases ?? []),
							menu === "stash" ? "prompt stash" : "",
						]
							.join(" ")
							.toLowerCase();
						return terms.every((term) => haystack.includes(term));
					});
				};

				const executeAction = (action: DialogAction | undefined, key?: string): void => {
					if (!action) return;
					searchMode = false;
					searchQuery = "";
					void (async () => {
						try {
							if (key !== undefined && action.runWithKey) {
								await action.runWithKey(key);
							} else {
								await action.run();
							}
						} finally {
							if (action.closeAfterRun === false) return;
							closeDialog();
						}
					})();
				};

				const matchesActionKey = (data: string, key: string): boolean => data === key || matchesKey(data, key);
				const matchActionForInput = (data: string): { action: DialogAction; key: string } | undefined => {
					for (const action of getActions()) {
						if (matchesActionKey(data, action.hotkey)) return { action, key: action.hotkey };
						const alias = action.hotkeyAliases?.find((candidate) => matchesActionKey(data, candidate));
						if (alias !== undefined) return { action, key: alias };
					}
					return undefined;
				};

				const enterSearch = (): void => {
					searchReturnIndex = selectedIndex;
					searchMode = true;
					searchQuery = "";
					selectedIndex = 0;
					tui.requestRender();
				};
				const exitSearch = (): void => {
					searchMode = false;
					searchQuery = "";
					selectedIndex = Math.min(searchReturnIndex, Math.max(0, getActions().length - 1));
					tui.requestRender();
				};

				return {
					render(width: number) {
						if (width <= 6) return [];
						// The overlay spans the terminal, while the compact dialog stays centered.
						// The surrounding cells use terminal background.
						const maxFrameWidth = activeMenu === "main" && !searchMode ? 38 : 37;
						const frameWidth = Math.min(Math.max(1, width - 2), maxFrameWidth);
						const contentWidth = Math.max(1, frameWidth - 2);
						const outerWidth = Math.max(0, width - frameWidth);
						const outerLeft = " ".repeat(Math.floor(outerWidth / 2));
						const outerRight = " ".repeat(Math.ceil(outerWidth / 2));
						const state = getSafeModeUiState();
						const border = (text: string): string => theme.fg("thinkingHigh", text);
						const outerLine = " ".repeat(width);
						const fit = (text: string): string => {
							const clipped = truncateToWidth(text, contentWidth, "");
							return `${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}`;
						};
						const frame = (text: string): string => `${border("┃")}${fit(text)}${border("┃")}`;
						const title = searchMode
							? "Quick actions / Search"
							: activeMenu === "stash"
								? "Quick actions / Prompt stash"
								: "Quick actions";
						const titleText = truncateToWidth(` ${title} `, Math.max(1, contentWidth - 4), "");
						const topFill = "━".repeat(Math.max(0, contentWidth - visibleWidth(titleText) - 3));
						const top = `${border("╭━╾")}${border(theme.bold(titleText))}${border(`╼${topFill}╮`)}`;

						const actionLine = (
							action: DialogAction,
							isSelected: boolean,
							overrides?: { label?: string; hotkeyLabel?: string },
						): string => {
							const enabled = action.isEnabled(state);
							const label = overrides?.label ?? action.label;
							const shortcut = overrides?.hotkeyLabel ?? action.hotkeyLabel ?? action.hotkey;
							const statusText = action.showStatusBadge === false ? "" : enabled ? "●" : "○";
							const markerText = action.opensMenu ? "→" : statusText;
							const rightText = [shortcut, markerText].filter(Boolean).join(" ");
							const prefix = isSelected ? " › " : "   ";
							const availableLeft = Math.max(1, contentWidth - visibleWidth(rightText) - 1);
							const leftText = truncateToWidth(`${prefix}${label}`, availableLeft, "");
							const gap = " ".repeat(Math.max(1, contentWidth - visibleWidth(leftText) - visibleWidth(rightText)));
							const left = isSelected ? border(theme.bold(leftText)) : leftText;
							const styledShortcut = isSelected ? border(shortcut) : theme.fg("dim", shortcut);
							let marker = "";
							if (action.opensMenu) marker = isSelected ? border("→") : theme.fg("muted", "→");
							else if (statusText) {
								const color =
									action.toggleSeverity === "danger"
										? "error"
										: action.toggleSeverity === "warning"
											? "warning"
											: "success";
								marker = theme.fg(color, enabled ? theme.bold(statusText) : statusText);
							}
							return fit(`${left}${gap}${styledShortcut}${marker ? ` ${marker}` : ""}`);
						};

						const searchActions = searchMode ? getSearchActions() : [];
						const searchWindowStart = Math.floor(selectedIndex / 8) * 8;
						const visibleSearchActions = searchActions.slice(searchWindowStart, searchWindowStart + 8);
						const lines: string[] = [top];
						if (searchMode) {
							lines.push(frame(` ${theme.fg("accent", "/")} ${searchQuery}${theme.fg("accent", "▌")}`));
							lines.push(border(`┣${"━".repeat(contentWidth)}┫`));
							if (visibleSearchActions.length === 0) {
								lines.push(frame(theme.fg("dim", searchQuery ? "   No matching actions" : "   Type to search all actions")));
							}
						} else {
							lines.push(frame(""));
						}
						if (searchMode) {
							lines.push(
								...visibleSearchActions.map((item, index) =>
									frame(
										actionLine(item.action, searchWindowStart + index === selectedIndex, {
											label: item.label,
											hotkeyLabel: item.hotkeyLabel,
										}),
									),
								),
							);
						} else {
							let previousGroup: DialogGroup | undefined;
							getActions().forEach((action, index) => {
								if (action.group && action.group !== previousGroup) {
									if (previousGroup) lines.push(frame(""));
									lines.push(frame(theme.fg("dim", `  ${action.group}`)));
									previousGroup = action.group;
								}
								lines.push(frame(actionLine(action, index === selectedIndex)));
							});
						}
						lines.push(frame(""));
						const footer = searchMode
							? `${searchActions.length} result${searchActions.length === 1 ? "" : "s"} · ↑/↓ · Enter · Esc`
							: activeMenu === "stash"
								? "← · ↑/↓ · Enter · / · Esc"
								: "↑/↓ · Enter · / search · Esc";
						lines.push(frame(theme.fg("dim", ` ${footer}`)));
						lines.push(border(`╰${"━".repeat(contentWidth)}╯`));
						return [outerLine, ...lines.map((line) => `${outerLeft}${line}${outerRight}`), outerLine];
					},
					invalidate() {},
					handleInput(data: string) {
						if (matchesKey(data, ACTION_DIALOG_TOGGLE_SHORTCUT)) {
							closeDialog();
							return;
						}
						if (searchMode) {
							if (matchesKey(data, Key.escape) || data === ESC) {
								exitSearch();
								return;
							}
							if (matchesKey(data, Key.backspace)) {
								if (!searchQuery) {
									exitSearch();
								} else {
									searchQuery = Array.from(searchQuery).slice(0, -1).join("");
									selectedIndex = 0;
									tui.requestRender();
								}
								return;
							}
							const results = getSearchActions();
							if (matchesKey(data, Key.up)) {
								if (results.length > 0) selectedIndex = (selectedIndex - 1 + results.length) % results.length;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, Key.down)) {
								if (results.length > 0) selectedIndex = (selectedIndex + 1) % results.length;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
								const result = results[selectedIndex];
								executeAction(result?.action, result?.executeKey);
								return;
							}
							if (/^[^\x00-\x1f\x7f]+$/.test(data)) {
								searchQuery += data;
								selectedIndex = 0;
								tui.requestRender();
							}
							return;
						}

						if (matchesKey(data, Key.escape) || data === ESC) {
							closeDialog();
							return;
						}
						if (data === "/") {
							enterSearch();
							return;
						}
						if (matchesKey(data, Key.backspace)) {
							if (activeMenu === "main") closeDialog();
							else setMenu("main");
							return;
						}
						if (matchesKey(data, Key.up) || data === "k" || data === "K") {
							const actionCount = getActions().length;
							selectedIndex = (selectedIndex - 1 + actionCount) % actionCount;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.down) || data === "j" || data === "J") {
							const actionCount = getActions().length;
							selectedIndex = (selectedIndex + 1) % actionCount;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
							executeAction(getActions()[selectedIndex]);
							return;
						}
						const match = matchActionForInput(data);
						if (match) executeAction(match.action, match.key);
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "100%",
					minWidth: 40,
					maxHeight: "85%",
					margin: 1,
				},
			},
		);
	} finally {
		dialogLifecycle.onHidden();
	}
}

export default function piUiExtension(pi: ExtensionAPI): void {
	// Disabled: use pi's default busy indicator instead of pi-ui custom loader.
	// patchLoaderWorkingSpinner();
	installEntryTracking();

	let minimumTrackLength = clamp(
		parseIntEnv("PI_UI_WORKING_LENGTH", DEFAULT_MIN_TRACK_LENGTH),
		MIN_TRACK_LENGTH,
		MAX_TRACK_LENGTH,
	);
	setGlobalMinTrackLength(minimumTrackLength);

	const intervalMs = Math.max(5, parseIntEnv("PI_UI_WORKING_INTERVAL_MS", DEFAULT_INTERVAL_MS));
	setGlobalHueStep(parseFloatEnv("PI_UI_WORKING_HUE_STEP_DEG", DEFAULT_HUE_STEP_DEG));

	let bellEnabled = parseBooleanEnv("PI_UI_BELL", DEFAULT_BELL_ENABLED);
	setGlobalBellEnabled(bellEnabled);
	setGlobalBellDebounceMs(
		clamp(
			parseIntEnv("PI_UI_BELL_DEBOUNCE_MS", DEFAULT_BELL_DEBOUNCE_MS),
			MIN_BELL_DEBOUNCE_MS,
			MAX_BELL_DEBOUNCE_MS,
		),
	);

	let frame = 0;
	let timer: NodeJS.Timeout | undefined;
	let activeContext: ExtensionContext | undefined;
	let pendingInteractiveInputSerial = 0;
	let agentRunning = false;
	let isActionDialogShown = false;
	let requestActionDialogClose: (() => void) | undefined;
	let agentsRewireEnabled = false;

	pi.events.on(STATUS_BAR_REWIRE_SET_EVENT, () => {
		agentsRewireEnabled = true;
	});
	pi.events.on(STATUS_BAR_REWIRE_CLEAR_EVENT, () => {
		agentsRewireEnabled = false;
	});

	const ensureUiBellPatched = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		patchUiInputBell(ctx);
	};

	const pushFrame = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage(encodeFrameStep(frame));
		frame += 1;
	};

	const stopAnimation = (ctx?: ExtensionContext) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		const target = ctx ?? activeContext;
		if (target?.hasUI) {
			target.ui.setWorkingMessage();
		}
		activeContext = undefined;
	};

	const startAnimation = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		stopAnimation(ctx);
		activeContext = ctx;
		frame = 0;
		pushFrame(ctx);
		timer = setInterval(() => {
			if (!activeContext?.hasUI) return;
			pushFrame(activeContext);
		}, intervalMs);
	};

	const restartIfActive = () => {
		if (!activeContext?.hasUI) return;
		startAnimation(activeContext);
	};

	pi.on("session_start", async (_event, ctx) => {
		captureTuiReference(ctx);
		ensureUiBellPatched(ctx);
		notifyInputExpectedIfReady(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		captureTuiReference(ctx);
		ensureUiBellPatched(ctx);
		notifyInputExpectedIfReady(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		ensureUiBellPatched(ctx);
		pendingInteractiveInputSerial = 0;
	});

	pi.on("input", async (event, ctx) => {
		ensureUiBellPatched(ctx);
		if (event.source !== "interactive") return;

		const serial = ++pendingInteractiveInputSerial;
		setTimeout(() => {
			if (pendingInteractiveInputSerial !== serial) return;
			if (agentRunning) return;
			notifyInputExpectedIfReady(ctx);
		}, 0);
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentRunning = true;
		pendingInteractiveInputSerial = 0;
		// Disabled: keep pi default busy indicator.
		// startAnimation(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentRunning = false;
		// Disabled: keep pi default busy indicator.
		// stopAnimation(ctx);
		notifyInputExpectedIfReady(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		pendingInteractiveInputSerial = 0;
		agentRunning = false;
		agentsRewireEnabled = false;
		// Disabled: keep pi default busy indicator.
		// stopAnimation(ctx);
	});

	pi.registerCommand("px:pi-ui-working-length", {
		description: `Set minimum working indicator length (${MIN_TRACK_LENGTH}-${MAX_TRACK_LENGTH}) [full-width mode keeps using terminal width]`,
		handler: async (args, ctx) => {
			ensureUiBellPatched(ctx);
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				notify(
					ctx,
					`pi-ui minimum working length: ${minimumTrackLength} (full-width mode active: effective length = terminal width; env: PI_UI_WORKING_LENGTH)`,
				);
				return;
			}

			const next = parseTrackLength(trimmed);
			if (next === undefined) {
				notify(ctx, `Usage: /px:pi-ui-working-length <${MIN_TRACK_LENGTH}-${MAX_TRACK_LENGTH}>`);
				return;
			}

			minimumTrackLength = next;
			setGlobalMinTrackLength(minimumTrackLength);
			restartIfActive();
			notify(ctx, `pi-ui minimum working length set to ${minimumTrackLength} (full-width mode active)`);
		},
	});

	pi.registerCommand("px:pi-ui-bell", {
		description: "Control bell notifications when pi waits for user input: /px:pi-ui-bell [on|off|toggle|status]",
		handler: async (args, ctx) => {
			ensureUiBellPatched(ctx);
			const trimmed = (args ?? "").trim().toLowerCase();

			if (!trimmed || trimmed === "status") {
				notify(
					ctx,
					`pi-ui bell: ${bellEnabled ? "on" : "off"} (env: PI_UI_BELL, debounce: ${getGlobalBellDebounceMs()}ms via PI_UI_BELL_DEBOUNCE_MS)`,
				);
				return;
			}

			if (trimmed === "on") {
				bellEnabled = true;
			} else if (trimmed === "off") {
				bellEnabled = false;
			} else if (trimmed === "toggle") {
				bellEnabled = !bellEnabled;
			} else {
				notify(ctx, "Usage: /px:pi-ui-bell [on|off|toggle|status]");
				return;
			}

			setGlobalBellEnabled(bellEnabled);
			notify(ctx, `pi-ui bell ${bellEnabled ? "enabled" : "disabled"}`);
			if (bellEnabled) ringBell(true);
		},
	});

	pi.registerShortcut(TOGGLE_NEWEST_SHORTCUT, {
		description: "Toggle the newest expandable transcript entry (same as clicking it)",
		handler: async (ctx) => {
			const result = toggleNewestExpandable();
			if (!result) notify(ctx, "pi-ui: no expandable entry to toggle");
		},
	});

	pi.registerShortcut(NAV_NEXT_SHORTCUT, {
		description: "Scroll the transcript to the next entry",
		handler: async (ctx) => {
			const result = scrollToEntry(captureTuiReference(ctx), 1);
			if (!result) notify(ctx, "pi-ui: transcript navigation unavailable");
		},
	});

	pi.registerShortcut(NAV_PREVIOUS_SHORTCUT, {
		description: "Scroll the transcript to the previous entry",
		handler: async (ctx) => {
			const result = scrollToEntry(captureTuiReference(ctx), -1);
			if (!result) notify(ctx, "pi-ui: transcript navigation unavailable");
		},
	});

	pi.registerCommand("px:pi-ui-expandable", {
		description: "Show tracked transcript entries and scroll-view status: /px:pi-ui-expandable",
		handler: async (_args, ctx) => {
			const tracked = listTrackedEntries();
			const recent = tracked.slice(-5);
			const suffix = recent.length > 0 ? ` (newest: ${recent.join(", ")})` : "";
			const scrollView = getTranscriptScrollView(captureTuiReference(ctx));
			const scrollInfo = scrollView ? `scroll view ok (top ${Math.round(scrollView.scrollTop)})` : "no scroll view";
			notify(ctx, `pi-ui entries: ${tracked.length} tracked${suffix} · ${scrollInfo}`);
		},
	});

	pi.registerShortcut(ACTION_DIALOG_TOGGLE_SHORTCUT, {
		description: "Toggle pi-ui dialog",
		handler: async (ctx) => {
			ensureUiBellPatched(ctx);
			if (isActionDialogShown) {
				requestActionDialogClose?.();
				return;
			}
			await showHiDialog(
				ctx,
				{
					onToggleReader: () => {
						pi.events.emit(SAFE_MODE_TOGGLE_READER_EVENT, { ctx });
					},
					onToggleOuter: () => {
						pi.events.emit(SAFE_MODE_TOGGLE_OUTER_EVENT, { ctx });
					},
					onSetYoloPlus: () => {
						pi.events.emit(SAFE_MODE_SET_YOLO_PLUS_EVENT, { ctx });
					},
					onShowPromptPreviews: async () => {
						await showPromptPreviewDialog(ctx);
					},
					onPromptStashStash: () => {
						pi.events.emit(PROMPT_STASH_STASH_EVENT, { ctx });
					},
					onPromptStashPop: () => {
						pi.events.emit(PROMPT_STASH_POP_EVENT, { ctx });
					},
					onPromptStashList: () => {
						pi.events.emit(PROMPT_STASH_LIST_EVENT, { ctx });
					},
					onPromptStashClearAll: () => {
						pi.events.emit(PROMPT_STASH_CLEAR_ALL_EVENT, { ctx });
					},
					onOpenNote: async () => {
						pi.events.emit(NOTES_OPEN_EVENT, { ctx });
					},
					onListNotes: async () => {
						pi.events.emit(NOTES_LIST_EVENT, { ctx });
					},
					onToggleAgentsRewire: () => {
						pi.events.emit(SUBAGENT_REWIRE_TOGGLE_EVENT, { ctx });
					},
					onOpenAgentsRewire: () => {
						pi.events.emit(SUBAGENT_REWIRE_MENU_EVENT, { ctx });
					},
					onOpenAgentsManager: () => {
						pi.events.emit(SUBAGENT_MANAGER_MENU_EVENT, { ctx });
					},
					isAgentsRewireEnabled: () => agentsRewireEnabled,
				},
				{
					isShown: () => isActionDialogShown,
					onShown: (requestClose) => {
						isActionDialogShown = true;
						requestActionDialogClose = requestClose;
					},
					onHidden: () => {
						isActionDialogShown = false;
						requestActionDialogClose = undefined;
					},
				},
			);
		},
	});
}
