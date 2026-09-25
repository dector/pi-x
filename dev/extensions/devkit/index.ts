/**
 * devkit — local development helper, loaded only by `./pitest`.
 *
 * Does one thing: `Alt+Ctrl+R` reloads extensions, skills, prompts, and themes.
 *
 * A shortcut handler receives `ExtensionContext`, which cannot reload. Only
 * `ExtensionCommandContext` (given to commands) can, so the shortcut dispatches
 * the internal `devkit:reload` command.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const RELOAD_COMMAND = "devkit:reload";

export default function devkit(pi: ExtensionAPI): void {
	pi.registerCommand(RELOAD_COMMAND, {
		description: "Reload extensions, skills, prompts, and themes",
		handler: async (_args, ctx) => {
			// Reload replaces the extension runtime, so treat this as terminal.
			await ctx.reload();
		},
	});

	// `expandPromptTemplates` exists at runtime since pi 0.87 and makes pi run
	// the text as a command instead of sending it to the model. The bundled
	// types in this repo can lag behind, so describe the option locally.
	const dispatch = { expandPromptTemplates: true } as {
		deliverAs?: "steer" | "followUp";
		expandPromptTemplates?: boolean;
	};

	pi.registerShortcut(Key.altCtrl("r"), {
		description: "Reload extensions, skills, prompts, and themes",
		handler: () => {
			pi.sendUserMessage(`/${RELOAD_COMMAND}`, dispatch);
		},
	});
}
