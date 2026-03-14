import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_STATUS_BAR_LAYOUT,
	STATUS_BAR_EVENTS,
	STATUS_BAR_JOIN_SEPARATOR,
} from "./contract";

export default function statusBarExtension(pi: ExtensionAPI): void {
	// M1 only: contract + layout are frozen here.
	// Rendering/aggregation implementation is planned for later milestones.
	const PLACEHOLDER_STATUS = "[status-bar: no producer output yet]";

	const renderPlaceholder = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("status-bar", PLACEHOLDER_STATUS);
	};

	pi.on("session_start", async (_event, ctx) => {
		renderPlaceholder(ctx);
	});

	pi.registerCommand("status-bar-contract", {
		description: "Show status-bar M1 contract (events + join + default layout)",
		handler: async (_args, ctx) => {
			renderPlaceholder(ctx);
			if (!ctx.hasUI) return;
			ctx.ui.notify(
				`events: ${STATUS_BAR_EVENTS.set}, ${STATUS_BAR_EVENTS.clear} | join="${STATUS_BAR_JOIN_SEPARATOR}" | layout left=[${DEFAULT_STATUS_BAR_LAYOUT.left.join(", ")}] center=[] right=[]`,
				"info",
			);
		},
	});
}
