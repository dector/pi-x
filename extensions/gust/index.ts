import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ThreadsDialog } from "./dialog.ts";
import { gustClient } from "./gust.ts";

/**
 * Gust comment browser.
 *
 * `/px:gust` opens a two-pane browser backed by `gust ctl comments`. The
 * client auto-detects `gust` on PATH or `go tool gust`, and finds the socket
 * from the current directory (override with GUST_SOCKET).
 */

async function openThreads(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("gust: the thread browser requires an interactive session", "warning");
		return;
	}
	await ctx.ui.custom<null>((tui, theme, _keybindings, done) =>
		new ThreadsDialog(tui, theme, gustClient, () => done(null)),
	);
}

export default function gustExtension(pi: ExtensionAPI): void {
	pi.registerCommand("px:gust", {
		description: "Browse Gust comment threads (TUI prototype, fake data)",
		handler: async (_args, ctx) => {
			await openThreads(ctx);
		},
	});
}
