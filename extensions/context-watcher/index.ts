import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_BAR_IDS = {
	tokens: "context-watcher-tokens",
	model: "context-watcher-model",
	percent: "context-watcher-percent",
} as const;

const STATUS_BAR_SET_EVENT = "status-bar:set";
const STATUS_BAR_CLEAR_EVENT = "status-bar:clear";

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

function formatTokenLabel(input: number, output: number, cacheRead: number): string {
	return `↑${formatTokens(input)}/↓${formatTokens(output)}/${formatTokens(cacheRead)}`;
}

function formatPercentLabel(percent: number): string {
	return `${percent.toFixed(1)}%`;
}

function styleLabel(ctx: ExtensionContext, percent: number, label: string): string {
	if (!ctx.hasUI) return label;
	if (percent <= 20) return ctx.ui.theme.fg("muted", label);
	if (percent <= 30) return ctx.ui.theme.fg("text", label);
	if (percent <= 50) return ctx.ui.theme.fg("warning", label);
	return ctx.ui.theme.fg("error", label);
}

export default function contextWatcherExtension(pi: ExtensionAPI): void {
	let lastSignature: string | undefined;

	const clearStatus = () => {
		if (lastSignature === undefined) return;
		lastSignature = undefined;
		for (const id of Object.values(STATUS_BAR_IDS)) {
			pi.events.emit(STATUS_BAR_CLEAR_EVENT, { id });
		}
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		const percent = ctx.getContextUsage()?.percent;
		if (typeof percent !== "number" || !Number.isFinite(percent)) {
			clearStatus();
			return;
		}

		const safePercent = Math.max(0, percent);
		const rounded = Number(safePercent.toFixed(1));
		const modelName = ctx.model?.id ?? "no-model";
		const usage = collectUsage(ctx);
		const tokenLabel = formatTokenLabel(usage.input, usage.output, usage.cacheRead);
		const percentLabel = formatPercentLabel(rounded);
		const bucket = rounded <= 20 ? "muted" : rounded <= 30 ? "text" : rounded <= 50 ? "warning" : "error";
		const signature = `${usage.input}|${usage.output}|${usage.cacheRead}|${modelName}|${rounded}|${bucket}|${ctx.hasUI ? "ui" : "noui"}`;
		if (signature === lastSignature) return;
		lastSignature = signature;

		pi.events.emit(STATUS_BAR_SET_EVENT, {
			id: STATUS_BAR_IDS.tokens,
			content: styleLabel(ctx, rounded, tokenLabel),
		});
		pi.events.emit(STATUS_BAR_SET_EVENT, {
			id: STATUS_BAR_IDS.model,
			content: styleLabel(ctx, rounded, modelName),
		});
		pi.events.emit(STATUS_BAR_SET_EVENT, {
			id: STATUS_BAR_IDS.percent,
			content: styleLabel(ctx, rounded, percentLabel),
		});
	};

	const bindRefresh = (
		eventName:
			| "session_start"
			| "session_switch"
			| "session_tree"
			| "session_fork"
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
			updateStatus(ctx);
		});
	};

	bindRefresh("session_start");
	bindRefresh("session_switch");
	bindRefresh("session_tree");
	bindRefresh("session_fork");
	bindRefresh("session_compact");
	bindRefresh("model_select");
	bindRefresh("turn_start");
	bindRefresh("turn_end");
	bindRefresh("agent_start");
	bindRefresh("agent_end");
	bindRefresh("message_start");
	bindRefresh("message_update");
	bindRefresh("message_end");
	bindRefresh("input");
	bindRefresh("user_bash");

	pi.on("session_shutdown", async () => {
		clearStatus();
	});
}
