import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

/**
 * POC: collapse the transcript down to your messages and the agent's text.
 *
 * Alt+E cycles two modes:
 *   normal  - everything visible
 *   all     - tool calls and thinking hidden
 *
 * In `all`, every contiguous run of invisible entries becomes one muted,
 * centered `─── N tool calls hidden ───` line.
 *
 * Also available as `/px:hide-tools`.
 *
 * Mechanism: capture the live TUI via `setWidget`, walk the layout tree to the
 * chat container, set `ToolExecutionComponent.hideComponent`, override
 * `render()` on thinking-only assistant components, and drop the thinking
 * MouseRegion from assistant messages that also carry text. pi rebuilds these
 * components on every update, so the state is re-applied from a wrapped
 * `tui.doRender`.
 *
 * State and the render hook live on `globalThis` so `/reload` swaps the logic
 * instead of leaving a stale wrapper behind.
 *
 * This pokes pi internals; it can break on pi upgrades. POC only.
 */

const TUI_KEY = "__px_hide_tools_tui_v1";
const THEME_KEY = "__px_hide_tools_theme_v1";
const STATE_KEY = "__px_hide_tools_state_v1";
const SYNC_KEY = "__px_hide_tools_sync_v1";
const SUMMARY_FLAG = "__px_hide_tools_summary";
const WRAPPED_FLAG = "__px_hide_tools_wrapped";
const WIDGET_KEY = "px:hide-tools-capture";
const TOGGLE_SHORTCUT = "alt+e";

type AnyRecord = Record<string, any>;

type HideMode = "normal" | "all";

/** Cycle order used by Alt+E, starting from `normal`. */
const MODES: readonly HideMode[] = ["normal", "all"];

const MODE_MESSAGES: Record<HideMode, string> = {
	normal: "hide-tools: normal",
	all: "hide-tools: tool calls and thinking hidden",
};

interface SummaryLine {
	[SUMMARY_FLAG]: true;
	render(width: number): string[];
	invalidate(): void;
}

interface HideToolsState {
	mode: HideMode;
	chat?: AnyRecord;
	/** Original `render` methods for components we replaced with an empty render. */
	hiddenRenders: WeakMap<object, (width: number) => string[]>;
	/** Assistant components whose thinking was stripped from their content container. */
	thinkingFiltered: WeakSet<object>;
}

function globalRecord(): AnyRecord {
	return globalThis as unknown as AnyRecord;
}

function debug(message: string): void {
	if (process.env.PI_HIDE_TOOLS_DEBUG !== "1") return;
	try {
		appendFileSync("/tmp/hide-tools-debug.log", `${new Date().toISOString()} ${message}\n`);
	} catch {
		/* ignore */
	}
}

function state(): HideToolsState {
	const global = globalRecord();
	let existing = global[STATE_KEY] as HideToolsState | undefined;
	if (!existing) {
		existing = { mode: "normal", hiddenRenders: new WeakMap(), thinkingFiltered: new WeakSet() };
		global[STATE_KEY] = existing;
	}
	if (!MODES.includes(existing.mode)) existing.mode = "normal";
	return existing;
}

function toolsHidden(): boolean {
	return state().mode !== "normal";
}

function thinkingHidden(): boolean {
	return state().mode === "all";
}

function className(candidate: unknown): string | undefined {
	return candidate && typeof candidate === "object" ? (candidate as AnyRecord).constructor?.name : undefined;
}

function isToolEntry(candidate: unknown): boolean {
	return className(candidate) === "ToolExecutionComponent";
}

function isAssistant(candidate: unknown): boolean {
	return className(candidate) === "AssistantMessageComponent";
}

function isMouseRegion(candidate: unknown): boolean {
	return className(candidate) === "MouseRegion";
}

function isSpacer(candidate: unknown): boolean {
	return className(candidate) === "Spacer";
}

function isSummary(candidate: unknown): boolean {
	return !!candidate && typeof candidate === "object" && (candidate as AnyRecord)[SUMMARY_FLAG] === true;
}

/** True when the assistant message has text worth showing (thinking does not count). */
function hasVisibleText(component: AnyRecord): boolean {
	const content = component.lastMessage?.content;
	if (!Array.isArray(content)) return false;
	return content.some(
		(block: AnyRecord) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
	);
}

/** A child that contributes nothing visible while tool calls are hidden. */
function isRunPart(candidate: unknown): boolean {
	if (toolsHidden() && isToolEntry(candidate)) return true;
	return thinkingHidden() && isAssistant(candidate) && !hasVisibleText(candidate as AnyRecord);
}

/** Depth-first search for the container that holds transcript tool entries. */
function findChatContainer(node: unknown, depth = 0): AnyRecord | undefined {
	if (!node || typeof node !== "object" || depth > 16) return undefined;
	const children = (node as AnyRecord).children;
	if (!Array.isArray(children)) return undefined;
	if (children.some(isToolEntry)) return node as AnyRecord;
	for (const child of children) {
		const found = findChatContainer(child, depth + 1);
		if (found) return found;
	}
	return undefined;
}

function findChat(tui: AnyRecord | undefined): AnyRecord | undefined {
	const current = state();
	if (!tui) return undefined;
	if (current.chat && Array.isArray(current.chat.children) && current.chat.children.some(isToolEntry)) {
		return current.chat;
	}
	current.chat = findChatContainer(tui.layoutRoot ?? tui);
	return current.chat;
}

/** Centered, dim `─── N tool calls hidden ───` line. */
function summaryLine(count: number, width: number): string {
	const label = count === 1 ? "1 tool call hidden" : `${count} tool calls hidden`;
	const plain = `─── ${label} ───`;
	const pad = Math.max(0, Math.floor((width - plain.length) / 2));
	let text = plain;
	const theme = globalRecord()[THEME_KEY] as AnyRecord | undefined;
	try {
		if (typeof theme?.fg === "function") text = theme.fg("dim", plain);
	} catch {
		/* keep plain */
	}
	return `${" ".repeat(pad)}${text}`;
}

function makeSummary(count: number): SummaryLine {
	return {
		[SUMMARY_FLAG]: true,
		render: (width: number) => ["", summaryLine(count, width)],
		invalidate: () => {},
	} as SummaryLine;
}

/** Replace a component's render with an empty one (reversible). */
function hideComponent(component: AnyRecord): void {
	const current = state();
	if (current.hiddenRenders.has(component)) return;
	if (typeof component.render !== "function") return;
	current.hiddenRenders.set(component, component.render);
	component.render = () => [];
}

function showComponent(component: AnyRecord): void {
	const current = state();
	const original = current.hiddenRenders.get(component);
	if (!original) return;
	component.render = original;
	current.hiddenRenders.delete(component);
}

/**
 * Remove the thinking block from an assistant message that also has text.
 * pi only ever wraps thinking in a `MouseRegion` inside `contentContainer`.
 */
function hideThinking(component: AnyRecord): void {
	const container = component.contentContainer;
	if (!container || !Array.isArray(container.children)) return;
	const children: unknown[] = container.children;
	if (!children.some(isMouseRegion)) return;

	const next: unknown[] = [];
	for (let index = 0; index < children.length; index += 1) {
		if (isMouseRegion(children[index])) {
			// The spacer pi adds after thinking has nothing left to separate.
			if (index + 1 < children.length && isSpacer(children[index + 1])) index += 1;
			continue;
		}
		next.push(children[index]);
	}
	container.children = next;
	state().thinkingFiltered.add(component);
}

function showAssistant(component: AnyRecord): void {
	const current = state();
	showComponent(component);
	if (current.thinkingFiltered.has(component)) {
		current.thinkingFiltered.delete(component);
		component.invalidate?.();
	}
}

/** Re-apply the current mode to the chat container. Runs before every frame. */
function sync(tui: AnyRecord | undefined): void {
	const container = findChat(tui);
	if (!container) return;

	if (container.children.some(isSummary)) {
		container.children = container.children.filter((child: unknown) => !isSummary(child));
	}
	const children: unknown[] = container.children;
	const hideTools = toolsHidden();
	const hideThinkingBlocks = thinkingHidden();

	for (const child of children) {
		if (isToolEntry(child)) {
			(child as AnyRecord).hideComponent = hideTools;
		} else if (isAssistant(child)) {
			const component = child as AnyRecord;
			if (hideThinkingBlocks && !hasVisibleText(component)) {
				hideComponent(component);
			} else {
				showAssistant(component);
				if (hideThinkingBlocks) hideThinking(component);
			}
		}
	}

	if (!hideTools) return;

	for (let index = 0; index < children.length; index += 1) {
		if (!isRunPart(children[index])) continue;
		let end = index;
		let count = 0;
		while (end < children.length && isRunPart(children[end])) {
			if (isToolEntry(children[end])) count += 1;
			end += 1;
		}
		if (count > 0) children.splice(index, 0, makeSummary(count));
		index = end;
	}
}

/**
 * Install the render hook once per TUI. The hook calls whatever `sync` the
 * newest extension load published, so `/reload` takes effect immediately.
 */
function wrap(tui: AnyRecord): void {
	globalRecord()[SYNC_KEY] = (target: AnyRecord) => sync(target);
	if (tui[WRAPPED_FLAG]) return;
	tui[WRAPPED_FLAG] = true;
	const originalDoRender = tui.doRender.bind(tui);
	tui.doRender = () => {
		const run = globalRecord()[SYNC_KEY] as ((target: AnyRecord) => void) | undefined;
		try {
			run?.(tui);
		} catch (error) {
			debug(`sync error: ${error instanceof Error ? error.stack : String(error)}`);
		}
		return originalDoRender();
	};
}

/** Grab the live TUI instance through a no-op widget factory. */
function capture(ctx: ExtensionContext): AnyRecord | undefined {
	if (!ctx.hasUI) return globalRecord()[TUI_KEY] as AnyRecord | undefined;
	globalRecord()[THEME_KEY] = ctx.ui.theme;
	ctx.ui.setWidget(WIDGET_KEY, (tui: any, theme: any) => {
		globalRecord()[TUI_KEY] = tui;
		globalRecord()[THEME_KEY] = theme;
		wrap(tui as AnyRecord);
		return { render: () => [], invalidate: () => {} };
	});
	return globalRecord()[TUI_KEY] as AnyRecord | undefined;
}

function applyMode(ctx: ExtensionContext, mode: HideMode): void {
	const tui = capture(ctx);
	const current = state();
	current.mode = mode;
	current.chat = undefined; // re-resolve in case the transcript was rebuilt
	try {
		sync(tui);
	} catch (error) {
		debug(`applyMode sync error: ${error instanceof Error ? error.stack : String(error)}`);
	}
	tui?.requestRender?.(true);
	if (ctx.hasUI) ctx.ui.notify(MODE_MESSAGES[mode], "info");
}

function cycleMode(ctx: ExtensionContext): void {
	const current = state().mode;
	const next = MODES[(MODES.indexOf(current) + 1) % MODES.length] ?? "normal";
	applyMode(ctx, next);
}

export default function hideToolsExtension(pi: ExtensionAPI): void {
	globalRecord()[SYNC_KEY] = (target: AnyRecord) => sync(target);

	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: "Cycle tool/thinking visibility in the transcript",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") return;
			cycleMode(ctx);
		},
	});

	pi.registerCommand("px:hide-tools", {
		description: "Cycle tool/thinking visibility in the transcript (POC)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("hide-tools: interactive TUI only", "warning");
				return;
			}
			cycleMode(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Keep the current mode across reload/resume; only drop the stale container.
		state().chat = undefined;
		capture(ctx);
	});
}
