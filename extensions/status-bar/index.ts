import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_STATUS_BAR_LAYOUT,
	STATUS_BAR_EVENTS,
	STATUS_BAR_JOIN_SEPARATOR,
	type StatusBarClearPayload,
	type StatusBarFirstLineClearPayload,
	type StatusBarFirstLineSetPayload,
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

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function collectUsage(ctx: ExtensionContext): { input: number; output: number; cacheRead: number } {
	let input = 0;
	let output = 0;
	let cacheRead = 0;

	for (const entry of ctx.sessionManager.getBranch() as Array<Record<string, unknown>>) {
		if (entry.type !== "message") continue;
		const message = entry.message as Record<string, unknown> | undefined;
		if (!message || message.role !== "assistant") continue;
		const usage = message.usage as Record<string, unknown> | undefined;
		if (!usage) continue;
		input += typeof usage.input === "number" ? usage.input : 0;
		output += typeof usage.output === "number" ? usage.output : 0;
		cacheRead += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
	}

	return { input, output, cacheRead };
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
	const usage = collectUsage(ctx);
	const modelName = ctx.model?.id ?? "no-model";
	const tokenLabel = `↑${formatTokens(usage.input)}/↓${formatTokens(usage.output)}/${formatTokens(usage.cacheRead)}`;
	const percentLabel = `${roundedPercent.toFixed(1)}%`;

	overrides.set(CONTEXT_WATCHER_IDS.tokens, styleContextLabel(theme, roundedPercent, tokenLabel));
	overrides.set(CONTEXT_WATCHER_IDS.model, styleContextLabel(theme, roundedPercent, modelName));
	overrides.set(CONTEXT_WATCHER_IDS.percent, styleContextLabel(theme, roundedPercent, percentLabel));

	return overrides;
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

async function showStatusBarContractUI(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const items: StatusBarContractSettingItem[] = [
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
			value: DEFAULT_STATUS_BAR_LAYOUT.left.join(", "),
			description: "Producer IDs rendered in the left section.",
		},
		{
			id: "layout-center",
			label: "Layout: center",
			value: DEFAULT_STATUS_BAR_LAYOUT.center.join(", ") || "(empty)",
			description: "Producer IDs rendered in the center section.",
		},
		{
			id: "layout-right",
			label: "Layout: right",
			value: DEFAULT_STATUS_BAR_LAYOUT.right.join(", "),
			description: "Producer IDs rendered in the right section.",
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
	let lastContext: ExtensionContext | undefined;
	let footerOwnerContext: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;

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

					let line1: string;
					if (hasFirstLineContent()) {
						const firstLineJoinSeparator = theme.fg("muted", STATUS_BAR_JOIN_SEPARATOR);
						const hasAttensionCore = hasVisibleText(firstLineById.get(ATTENSION_CORE_ID)?.content);
						const attensionCoreSuffix = hasAttensionCore ? defaultFirstLine : undefined;
						const producerLeft = renderFirstLineSection("left", firstLineJoinSeparator, attensionCoreSuffix);
						const left = producerLeft ?? (hasAttensionCore ? undefined : defaultFirstLine);
						const center = renderFirstLineSection("center", firstLineJoinSeparator, attensionCoreSuffix);
						const right = renderFirstLineSection("right", firstLineJoinSeparator, attensionCoreSuffix);
						line1 = renderThreeSectionLine(width, left, center, right);
					} else {
						line1 = truncateToWidth(defaultFirstLine, width, theme.fg("dim", "..."));
					}

					const contextOverrides = getContextWatcherOverrides(activeCtx, theme);

					let joinSeparator = theme.fg("muted", STATUS_BAR_JOIN_SEPARATOR);
					let left = renderSection(DEFAULT_STATUS_BAR_LAYOUT.left, undefined, joinSeparator);
					let center = renderSection(DEFAULT_STATUS_BAR_LAYOUT.center, undefined, joinSeparator);
					let right = renderSection(DEFAULT_STATUS_BAR_LAYOUT.right, contextOverrides, joinSeparator);

					if (isCrowded(width, left, center, right)) {
						joinSeparator = theme.fg("muted", COMPACT_ITEM_JOIN_SEPARATOR);
						left = renderSection(DEFAULT_STATUS_BAR_LAYOUT.left, undefined, joinSeparator);
						center = renderSection(DEFAULT_STATUS_BAR_LAYOUT.center, undefined, joinSeparator);
						right = renderSection(DEFAULT_STATUS_BAR_LAYOUT.right, contextOverrides, joinSeparator);
					}

					const hasThinkingSection = DEFAULT_STATUS_BAR_LAYOUT.left.includes(SWITCH_THINKING_ID);
					const activeThinking = contentById.get(SWITCH_THINKING_ACTIVE_ID);
					const needCompactThinking = hasThinkingSection && hasVisibleText(activeThinking) && isCrowded(width, left, center, right);

					if (needCompactThinking) {
						const leftOverrides = new Map<string, string | undefined>([[SWITCH_THINKING_ID, activeThinking]]);
						left = renderSection(DEFAULT_STATUS_BAR_LAYOUT.left, leftOverrides, joinSeparator);
					}

					const line2 = renderThreeSectionLine(width, left, center, right);
					return [line1, line2];
				},
			};
		});

		footerOwnerContext = ctx;
	};

	const bindContextAndRender = (ctx: ExtensionContext): void => {
		lastContext = ctx;
		if (ctx.hasUI) installFooter(ctx);
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
			await showStatusBarContractUI(ctx);
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
