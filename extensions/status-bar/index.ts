import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_STATUS_BAR_LAYOUT,
	STATUS_BAR_EVENTS,
	STATUS_BAR_JOIN_SEPARATOR,
	type StatusBarClearPayload,
	type StatusBarSetPayload,
} from "./contract";

const SECTION_DELIMITER = " · ";

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

export default function statusBarExtension(pi: ExtensionAPI): void {
	const contentById = new Map<string, string>();
	let lastContext: ExtensionContext | undefined;

	const renderStatus = (): void => {
		if (!lastContext?.hasUI) return;

		const renderSection = (ids: string[]): string => {
			const items = ids
				.map((id) => contentById.get(id))
				.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
			return `[${items.join(STATUS_BAR_JOIN_SEPARATOR)}]`;
		};

		const left = renderSection(DEFAULT_STATUS_BAR_LAYOUT.left);
		const center = renderSection(DEFAULT_STATUS_BAR_LAYOUT.center);
		const right = renderSection(DEFAULT_STATUS_BAR_LAYOUT.right);
		lastContext.ui.setStatus("status-bar", `${left}${SECTION_DELIMITER}${center}${SECTION_DELIMITER}${right}`);
	};

	const bindContextAndRender = (ctx: ExtensionContext): void => {
		lastContext = ctx;
		renderStatus();
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

	pi.events.on(STATUS_BAR_EVENTS.set, (payload) => {
		if (!isSetPayload(payload)) return;
		contentById.set(payload.id, payload.content);
		renderStatus();
	});

	pi.events.on(STATUS_BAR_EVENTS.clear, (payload) => {
		if (!isClearPayload(payload)) return;
		contentById.delete(payload.id);
		renderStatus();
	});

	pi.registerCommand("status-bar-contract", {
		description: "Show status-bar contract (events + join + default layout)",
		handler: async (_args, ctx) => {
			bindContextAndRender(ctx);
			if (!ctx.hasUI) return;
			ctx.ui.notify(
				`events: ${STATUS_BAR_EVENTS.set}, ${STATUS_BAR_EVENTS.clear} | join=\"${STATUS_BAR_JOIN_SEPARATOR}\" | layout left=[${DEFAULT_STATUS_BAR_LAYOUT.left.join(", ")}] center=[] right=[]`,
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
