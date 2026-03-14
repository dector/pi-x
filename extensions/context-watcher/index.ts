import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_BAR_ID = "context-watcher";
const STATUS_BAR_SET_EVENT = "status-bar:set";
const STATUS_BAR_CLEAR_EVENT = "status-bar:clear";

function formatLabel(modelName: string, percent: number): string {
	return `${modelName}: ${percent.toFixed(1)}%`;
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
		pi.events.emit(STATUS_BAR_CLEAR_EVENT, { id: STATUS_BAR_ID });
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
		const label = formatLabel(modelName, rounded);
		const bucket = rounded <= 20 ? "muted" : rounded <= 30 ? "text" : rounded <= 50 ? "warning" : "error";
		const signature = `${modelName}|${rounded}|${bucket}|${ctx.hasUI ? "ui" : "noui"}`;
		if (signature === lastSignature) return;
		lastSignature = signature;

		pi.events.emit(STATUS_BAR_SET_EVENT, {
			id: STATUS_BAR_ID,
			content: styleLabel(ctx, rounded, label),
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
