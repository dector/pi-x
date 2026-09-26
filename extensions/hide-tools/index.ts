import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * POC: control how much of the transcript you see.
 *
 * Alt+E cycles the modes (same as `/px:hide-tools`):
 *   full    - pi's default: tools and thinking visible
 *   compact - one custom `▸ tool  args` line per tool call, thinking hidden
 *   hidden  - tool runs collapse to a centered `─── N tool calls hidden ───`
 *
 * Click a compact line or a summary line to peek: the real tool call is shown
 * below it, and clicking again collapses it. Works in fullscreen mode only,
 * because regular mode leaves the mouse to the terminal.
 *
 * Mode and peek are saved to `~/.pi/agent/space.dector-hide-tools.json` and
 * reapplied on startup. `/px:hide-tools` also accepts explicit arguments; add
 * `-s` to apply for this session without saving.
 *
 * Mechanism: capture the live TUI via `setWidget`, walk the layout tree to the
 * chat container, then per mode set `ToolExecutionComponent.hideComponent`,
 * insert our own replacement lines, and drop the thinking MouseRegion from
 * assistant messages. pi rebuilds components on every update, so the state is
 * re-applied from a wrapped `tui.doRender`.
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
const LINE_FLAG = "__px_hide_tools_line";
const WRAPPED_FLAG = "__px_hide_tools_wrapped";
const WIDGET_KEY = "px:hide-tools-capture";
const TOGGLE_SHORTCUT = "alt+e";

type AnyRecord = Record<string, any>;

type HideMode = "full" | "compact" | "hidden";

/** Cycle order used by Alt+E, starting from `full`. */
const MODES: readonly HideMode[] = ["full", "compact", "hidden"];

const MODE_MESSAGES: Record<HideMode, string> = {
	full: "hide-tools: full",
	compact: "hide-tools: compact (one line per tool call)",
	hidden: "hide-tools: hidden (tool calls and thinking)",
};

interface MouseEventLike {
	type: string;
	button: string;
}

interface InsertedLine {
	[LINE_FLAG]: "summary" | "compact";
	render(width: number): string[];
	invalidate(): void;
	handleMouse?(event: MouseEventLike): { handled: boolean; render?: boolean } | undefined;
}

interface HideToolsState {
	mode: HideMode;
	/** Click-to-peek is enabled. */
	peek: boolean;
	chat?: AnyRecord;
	/** Tool call ids whose compact line is expanded. */
	revealedTools: Set<string>;
	/** Run keys (`toolCallId` of the first tool) whose run is expanded in hidden mode. */
	revealedRuns: Set<string>;
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

const CONFIG_FILE = "space.dector-hide-tools.json";

const USAGE = [
	"/px:hide-tools               cycle full / compact / hidden",
	"/px:hide-tools <mode>        set full, compact or hidden",
	"/px:hide-tools peek [on|off] toggle click-to-peek",
	"/px:hide-tools status        show the current settings",
	"",
	"add -s anywhere to apply without saving, for this session only",
].join("\n");

function configPath(): string {
	return process.env.PI_HIDE_TOOLS_CONFIG_PATH ?? join(homedir(), ".pi", "agent", CONFIG_FILE);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read the saved mode and peek flag. Missing file is not an error. */
function loadConfig(): { mode?: HideMode; peek?: boolean; error?: string } {
	const path = configPath();
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as { mode?: unknown; peek?: unknown };
		return {
			mode: MODES.includes(raw?.mode as HideMode) ? (raw.mode as HideMode) : undefined,
			peek: typeof raw?.peek === "boolean" ? raw.peek : undefined,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
		return { error: `hide-tools: failed to load ${path}: ${errorMessage(error)}` };
	}
}

function saveConfig(): { error?: string } {
	const path = configPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		const current = state();
		writeFileSync(path, `${JSON.stringify({ version: 1, mode: current.mode, peek: current.peek }, null, 2)}\n`);
		return {};
	} catch (error) {
		return { error: `hide-tools: failed to save ${path}: ${errorMessage(error)}` };
	}
}

function state(): HideToolsState {
	const global = globalRecord();
	let existing = global[STATE_KEY] as (HideToolsState & { mode?: string }) | undefined;
	if (!existing) {
		existing = {
			mode: "full",
			peek: true,
			revealedTools: new Set(),
			revealedRuns: new Set(),
			hiddenRenders: new WeakMap(),
			thinkingFiltered: new WeakSet(),
		};
		global[STATE_KEY] = existing;
	}
	existing.revealedTools ??= new Set();
	existing.revealedRuns ??= new Set();
	if (existing.peek === undefined) existing.peek = true;
	// Migrate the earlier two-mode values.
	const rawMode = (existing as { mode?: string }).mode;
	if (rawMode === "normal") existing.mode = "full";
	else if (rawMode === "all") existing.mode = "hidden";
	else if (!MODES.includes(rawMode as HideMode)) existing.mode = "full";
	return existing as HideToolsState;
}

function currentMode(): HideMode {
	return state().mode;
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

function isInsertedLine(candidate: unknown): boolean {
	return !!candidate && typeof candidate === "object" && (candidate as AnyRecord)[LINE_FLAG] !== undefined;
}

/** Stable id used as a peek key for a tool component. */
function toolId(component: AnyRecord): string | undefined {
	return typeof component.toolCallId === "string" ? component.toolCallId : undefined;
}

/** True when the assistant message has text worth showing (thinking does not count). */
function hasVisibleText(component: AnyRecord): boolean {
	const content = component.lastMessage?.content;
	if (!Array.isArray(content)) return false;
	return content.some(
		(block: AnyRecord) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
	);
}

/** A child that contributes nothing visible while in `hidden` mode. */
function isRunPart(candidate: unknown): boolean {
	if (isToolEntry(candidate)) return true;
	return isAssistant(candidate) && !hasVisibleText(candidate as AnyRecord);
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

function themed(color: string, text: string): string {
	const theme = globalRecord()[THEME_KEY] as AnyRecord | undefined;
	try {
		return typeof theme?.fg === "function" ? theme.fg(color, text) : text;
	} catch {
		return text;
	}
}

/** Centered, dim `─── N tool calls hidden ───` line. */
function summaryText(count: number, revealed: boolean, width: number): string {
	const what = count === 1 ? "1 tool call" : `${count} tool calls`;
	const label = revealed ? `${what} shown` : `${what} hidden`;
	const plain = `─── ${label} ───`;
	const pad = Math.max(0, Math.floor((width - plain.length) / 2));
	return `${" ".repeat(pad)}${themed("dim", plain)}`;
}

/** One dim line describing a single tool call. */
function compactText(component: AnyRecord, revealed: boolean, width: number): string {
	const name = typeof component.toolName === "string" && component.toolName ? component.toolName : "tool";
	const args = component.args;
	let detail = "";
	if (args && typeof args === "object") {
		if (typeof args.command === "string") detail = args.command;
		else if (typeof args.path === "string") detail = args.path;
		else if (typeof args.pattern === "string") detail = args.pattern;
		else detail = JSON.stringify(args);
	} else if (typeof args === "string") {
		detail = args;
	}
	let plain = `  ${revealed ? "▾" : "▸"} ${name}${detail ? `  ${detail}` : ""}`.replace(/\s+/g, " ");
	if (width > 0 && plain.length > width) plain = `${plain.slice(0, Math.max(0, width - 1))}…`;
	return themed("dim", plain);
}

/** Build an inserted line, optionally clickable to toggle a peek. */
function makeLine(
	kind: "summary" | "compact",
	render: (width: number) => string[],
	onActivate?: () => void,
): InsertedLine {
	const line: InsertedLine = { [LINE_FLAG]: kind, render, invalidate: () => {} };
	if (!onActivate || !state().peek) return line;
	line.handleMouse = (event) => {
		if (event.button !== "left") return undefined;
		// Claim the press so the TUI synthesizes a click on release.
		if (event.type === "press") return { handled: true };
		if (event.type === "click") {
			onActivate();
			return { handled: true, render: true };
		}
		return undefined;
	};
	return line;
}

function makeSummaryLine(count: number, runKey: string): InsertedLine {
	const revealed = state().revealedRuns.has(runKey);
	return makeLine(
		"summary",
		(width: number) => ["", summaryText(count, revealed, width)],
		() => toggleSet(state().revealedRuns, runKey),
	);
}

function makeCompactLine(component: AnyRecord): InsertedLine {
	const id = toolId(component);
	const revealed = id !== undefined && state().revealedTools.has(id);
	return makeLine(
		"compact",
		(width: number) => [compactText(component, revealed, width)],
		id === undefined ? undefined : () => toggleSet(state().revealedTools, id),
	);
}

function toggleSet(set: Set<string>, key: string): void {
	if (set.has(key)) set.delete(key);
	else set.add(key);
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

	if (container.children.some(isInsertedLine)) {
		container.children = container.children.filter((child: unknown) => !isInsertedLine(child));
	}
	const children: unknown[] = container.children;
	const current = state();
	const mode = current.mode;
	const toolsVisible = mode === "full";
	const thinkingVisible = mode === "full";

	for (const child of children) {
		if (isToolEntry(child)) {
			const component = child as AnyRecord;
			const id = toolId(component);
			// `hidden` visibility is resolved per run below; this only handles
			// `full` and per-tool reveals in `compact`.
			const revealed =
				toolsVisible || (mode === "compact" && id !== undefined && current.revealedTools.has(id));
			component.hideComponent = !revealed;
		} else if (isAssistant(child)) {
			const component = child as AnyRecord;
			if (!thinkingVisible && !hasVisibleText(component)) {
				hideComponent(component);
			} else {
				showAssistant(component);
				if (!thinkingVisible) hideThinking(component);
			}
		}
	}

	if (mode === "hidden") {
		for (let index = 0; index < children.length; index += 1) {
			if (!isRunPart(children[index])) continue;
			let end = index;
			let count = 0;
			let runKey: string | undefined;
			while (end < children.length && isRunPart(children[end])) {
				if (isToolEntry(children[end])) {
					count += 1;
					runKey ??= toolId(children[end] as AnyRecord);
				}
				end += 1;
			}
			if (count > 0 && runKey !== undefined) {
				const revealed = current.revealedRuns.has(runKey);
				if (revealed) {
					for (let entry = index; entry < end; entry += 1) {
						if (isToolEntry(children[entry])) (children[entry] as AnyRecord).hideComponent = false;
					}
				}
				children.splice(index, 0, makeSummaryLine(count, runKey));
			}
			index = end;
		}
	} else if (mode === "compact") {
		for (let index = 0; index < children.length; index += 1) {
			if (!isToolEntry(children[index])) continue;
			children.splice(index, 0, makeCompactLine(children[index] as AnyRecord));
			index += 1;
		}
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

function persist(ctx: ExtensionContext, session: boolean): void {
	if (session) return;
	const { error } = saveConfig();
	if (error && ctx.hasUI) ctx.ui.notify(error, "warning");
}

function applyMode(ctx: ExtensionContext, mode: HideMode, session = false): void {
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
	persist(ctx, session);
}

function cycleMode(ctx: ExtensionContext, session = false): void {
	const index = MODES.indexOf(currentMode());
	const next = MODES[(index + 1) % MODES.length] ?? "full";
	applyMode(ctx, next, session);
}

function setPeek(ctx: ExtensionContext, enabled: boolean, session = false): void {
	const tui = capture(ctx);
	state().peek = enabled;
	try {
		sync(tui);
	} catch (error) {
		debug(`setPeek sync error: ${error instanceof Error ? error.stack : String(error)}`);
	}
	tui?.requestRender?.(true);
	if (ctx.hasUI) ctx.ui.notify(`hide-tools: click-to-peek ${enabled ? "on" : "off"}`, "info");
	persist(ctx, session);
}

function showStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const current = state();
	ctx.ui.notify(
		`hide-tools: mode=${current.mode} peek=${current.peek ? "on" : "off"} · ${configPath()}`,
		"info",
	);
}

function handleCommand(args: string, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify("hide-tools: interactive TUI only", "warning");
		return;
	}

	const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
	const session = tokens.includes("-s") || tokens.includes("--session");
	const rest = tokens.filter((token) => token !== "-s" && token !== "--session");
	const [first, second] = rest;

	if (first === undefined) {
		cycleMode(ctx, session);
		return;
	}

	if (MODES.includes(first as HideMode)) {
		applyMode(ctx, first as HideMode, session);
		return;
	}

	if (first === "peek") {
		if (second === "on") setPeek(ctx, true, session);
		else if (second === "off") setPeek(ctx, false, session);
		else if (second === undefined || second === "toggle") setPeek(ctx, !state().peek, session);
		else if (ctx.hasUI) ctx.ui.notify(`hide-tools: expected "on" or "off", got "${second}"`, "warning");
		return;
	}

	if (first === "status") {
		showStatus(ctx);
		return;
	}

	if (ctx.hasUI) ctx.ui.notify(USAGE, "info");
}

export default function hideToolsExtension(pi: ExtensionAPI): void {
	globalRecord()[SYNC_KEY] = (target: AnyRecord) => sync(target);

	// Adopt the saved settings before the first frame is drawn.
	const loaded = loadConfig();
	if (loaded.mode !== undefined) state().mode = loaded.mode;
	if (loaded.peek !== undefined) state().peek = loaded.peek;
	if (loaded.error) debug(loaded.error);

	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: "Cycle transcript density (full / compact / hidden)",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") return;
			cycleMode(ctx);
		},
	});

	pi.registerCommand("px:hide-tools", {
		description: "Cycle or set transcript density; also toggles click-to-peek",
		handler: async (args, ctx) => {
			handleCommand(args ?? "", ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Keep the current mode and peeks across reload/resume.
		state().chat = undefined;
		capture(ctx);
	});
}
