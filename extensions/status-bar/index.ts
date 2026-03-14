import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	DEFAULT_STATUS_BAR_LAYOUT,
	STATUS_BAR_EVENTS,
	STATUS_BAR_JOIN_SEPARATOR,
	type StatusBarClearPayload,
	type StatusBarSetPayload,
} from "./contract";

const SECTION_DELIMITER = "  ";
const SECTION_GAP = visibleWidth(SECTION_DELIMITER);

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

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

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
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

function collectUsageTotals(ctx: ExtensionContext): UsageTotals {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
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
		cacheWrite += typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;

		const costObj = usage.cost as Record<string, unknown> | undefined;
		if (costObj && typeof costObj.total === "number") {
			cost += costObj.total;
		}
	}

	return { input, output, cacheRead, cacheWrite, cost };
}

export default function statusBarExtension(pi: ExtensionAPI): void {
	const contentById = new Map<string, string>();
	let lastContext: ExtensionContext | undefined;
	let footerOwnerContext: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;

	const renderSection = (ids: string[]): string | undefined => {
		const items = ids
			.map((id) => contentById.get(id))
			.filter((value): value is string => hasVisibleText(value))
			.map((value) => sanitizeStatusText(value));
		if (items.length === 0) return undefined;
		return items.join(STATUS_BAR_JOIN_SEPARATOR);
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
					const model = activeCtx.model;
					const modelName = model?.id ?? "no-model";
					const thinking = pi.getThinkingLevel();
					const thinkingLabel = model?.reasoning ? (thinking === "off" ? "thinking off" : thinking) : undefined;
					const modelSummary = thinkingLabel ? `${modelName} • ${thinkingLabel}` : modelName;

					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = activeCtx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;
					const line1 = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

					const usage = collectUsageTotals(activeCtx);
					const contextUsage = activeCtx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
					const contextPercentValue =
						typeof contextUsage?.percent === "number" && Number.isFinite(contextUsage.percent)
							? contextUsage.percent
							: undefined;
					const contextPercentDisplay =
						typeof contextPercentValue === "number"
							? `${contextPercentValue.toFixed(1)}%/${formatTokens(contextWindow)}`
							: `?/${formatTokens(contextWindow)}`;
					const contextDisplay =
						typeof contextPercentValue === "number" && contextPercentValue > 90
							? theme.fg("error", contextPercentDisplay)
							: typeof contextPercentValue === "number" && contextPercentValue > 70
								? theme.fg("warning", contextPercentDisplay)
								: theme.fg("dim", contextPercentDisplay);

					const statsParts: string[] = [];
					if (usage.input) statsParts.push(theme.fg("dim", `↑${formatTokens(usage.input)}`));
					if (usage.output) statsParts.push(theme.fg("dim", `↓${formatTokens(usage.output)}`));
					if (usage.cacheRead) statsParts.push(theme.fg("dim", `R${formatTokens(usage.cacheRead)}`));
					if (usage.cacheWrite) statsParts.push(theme.fg("dim", `W${formatTokens(usage.cacheWrite)}`));
					if (usage.cost) statsParts.push(theme.fg("dim", `$${usage.cost.toFixed(3)}`));
					statsParts.push(contextDisplay);
					const statsLeft = statsParts.join(" ");
					const statsRight = theme.fg("dim", modelSummary);
					const line2 = renderThreeSectionLine(width, statsLeft, undefined, statsRight);

					const left = renderSection(DEFAULT_STATUS_BAR_LAYOUT.left);
					const center = renderSection(DEFAULT_STATUS_BAR_LAYOUT.center);
					const right = renderSection(DEFAULT_STATUS_BAR_LAYOUT.right);
					const line3 = renderThreeSectionLine(width, left, center, right);

					return [line1, line2, line3];
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

	pi.on("session_switch", async (_event, ctx) => {
		bindContextAndRender(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		bindContextAndRender(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
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

	pi.registerCommand("status-bar-contract", {
		description: "Show status-bar contract (events + item join + section separator + layout)",
		handler: async (_args, ctx) => {
			bindContextAndRender(ctx);
			if (!ctx.hasUI) return;
			ctx.ui.notify(
				`events: ${STATUS_BAR_EVENTS.set}, ${STATUS_BAR_EVENTS.clear} | item-join=\"${STATUS_BAR_JOIN_SEPARATOR}\" | section-separator=\"${SECTION_DELIMITER}\" | renderer=setFooter(custom) | layout left=[${DEFAULT_STATUS_BAR_LAYOUT.left.join(", ")}] center=[${DEFAULT_STATUS_BAR_LAYOUT.center.join(", ")}] right=[${DEFAULT_STATUS_BAR_LAYOUT.right.join(", ")}]`,
				"info",
			);
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
