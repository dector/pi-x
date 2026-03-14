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

	const renderStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;

		const renderSection = (ids: string[]): string => {
			const items = ids
				.map((id) => contentById.get(id))
				.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
			return `[${items.join(STATUS_BAR_JOIN_SEPARATOR)}]`;
		};

		const left = renderSection(DEFAULT_STATUS_BAR_LAYOUT.left);
		const center = renderSection(DEFAULT_STATUS_BAR_LAYOUT.center);
		const right = renderSection(DEFAULT_STATUS_BAR_LAYOUT.right);
		ctx.ui.setStatus("status-bar", `${left}${SECTION_DELIMITER}${center}${SECTION_DELIMITER}${right}`);
	};

	pi.on("session_start", async (_event, ctx) => {
		renderStatus(ctx);
	});

	pi.on(STATUS_BAR_EVENTS.set, async (event, ctx) => {
		if (!isSetPayload(event)) return;
		contentById.set(event.id, event.content);
		renderStatus(ctx);
	});

	pi.on(STATUS_BAR_EVENTS.clear, async (event, ctx) => {
		if (!isClearPayload(event)) return;
		contentById.delete(event.id);
		renderStatus(ctx);
	});

	pi.registerCommand("status-bar-contract", {
		description: "Show status-bar M1 contract (events + join + default layout)",
		handler: async (_args, ctx) => {
			renderStatus(ctx);
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
			contentById.set(parsed.id, parsed.content);
			renderStatus(ctx);
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
			contentById.delete(parsed.id);
			renderStatus(ctx);
		},
	});
}
