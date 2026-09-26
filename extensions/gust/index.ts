import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ThreadsDialog } from "./dialog.ts";

/**
 * Gust comment browser — TUI prototype.
 *
 * `/px:gust` opens a two-pane browser for Gust threads. Data is currently fake
 * (./fixtures.ts) so we can polish the layout before wiring the real
 * `gust ctl comments` client.
 */

async function openThreads(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("gust: the thread browser requires an interactive session", "warning");
		return;
	}
	await ctx.ui.custom<null>((tui, theme, _keybindings, done) => new ThreadsDialog(tui, theme, () => done(null)));
}

export default function gustExtension(pi: ExtensionAPI): void {
	pi.registerCommand("px:gust", {
		description: "Browse Gust comment threads (TUI prototype, fake data)",
		handler: async (_args, ctx) => {
			await openThreads(ctx);
		},
	});
}
