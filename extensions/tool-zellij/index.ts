import { StringEnum, Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ZELLIJ_ACTIONS = ["help", "version"] as const;

type ZellijAction = (typeof ZELLIJ_ACTIONS)[number];

type ZellijToolParams = {
	action: ZellijAction;
};

const ZellijToolSchema = Type.Object({
	action: StringEnum(ZELLIJ_ACTIONS, {
		description: "Sub-tool to run. Start with 'help'.",
	}),
});

function buildHelpText(): string {
	return [
		"zellij bridge sub-tools:",
		"- help: show all currently supported bridge sub-tools.",
		"- version: display installed zellij version using `zellij --version`.",
		"",
		"Use `help` first whenever you need guidance on available sub-tools.",
	].join("\n");
}

export default function toolZellijExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "zellij",
		label: "Zellij",
		description:
			"Bridge for controlling zellij/tmux sessions. Check help for available sub-tools and usage.",
		promptSnippet: "Control zellij/tmux sessions via a bridge tool.",
		promptGuidelines: ["Call zellij with action='help' first to see supported sub-tools."],
		parameters: ZellijToolSchema,
		async execute(_toolCallId, params, signal) {
			const input = params as ZellijToolParams;

			if (input.action === "help") {
				return {
					content: [{ type: "text", text: buildHelpText() }],
					details: {
						action: "help",
						supportedActions: [...ZELLIJ_ACTIONS],
					},
				};
			}

			try {
				const result = await pi.exec("zellij", ["--version"], {
					signal,
					timeout: 8000,
				});
				const stdout = (result.stdout ?? "").trim();
				const stderr = (result.stderr ?? "").trim();
				const output = stdout || stderr;

				if ((result.code ?? 1) !== 0) {
					throw new Error(output || `zellij --version failed with exit code ${result.code}`);
				}

				return {
					content: [{ type: "text", text: output || "zellij --version returned no output." }],
					details: {
						action: "version",
						command: "zellij --version",
						exitCode: result.code,
						stdout,
						stderr,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Unable to read zellij version: ${message}`);
			}
		},
	});
}
