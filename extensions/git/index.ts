import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const GitToolParams = Type.Object({
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Git argv-style arguments. Currently supported: status.",
		}),
	),
});

type GitToolParamsInput = {
	args?: string[];
};

const STATUS_ARGS = ["status", "--porcelain=v1", "-b"] as const;

function normalizeArgs(args: string[] | undefined): string[] {
	if (!Array.isArray(args)) return [];
	return args.map((part) => String(part).trim()).filter((part) => part.length > 0);
}

function usageText(): string {
	return "usage: git status";
}

async function runGitStatus(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal) {
	const result = await pi.exec("git", [...STATUS_ARGS], {
		cwd: ctx.cwd,
		signal,
		timeout: 10000,
	});

	const stdout = (result.stdout ?? "").trim();
	const stderr = (result.stderr ?? "").trim();
	const exitCode = result.code ?? 1;
	const ok = exitCode === 0;

	return {
		ok,
		exitCode,
		stdout,
		stderr,
		output: stdout || stderr || "(no output)",
	};
}

export default function gitExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "git",
		label: "Git",
		description: "Git helper tool (currently supports status porcelain passthrough).",
		promptSnippet: "Use git tool for git operations.",
		parameters: GitToolParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as GitToolParamsInput;
			const argv = normalizeArgs(input.args);
			if (argv.length === 0 || argv[0] !== "status") {
				return {
					content: [{ type: "text", text: usageText() }],
					details: {
						supported: ["status"],
						receivedArgs: argv,
					},
				};
			}

			const status = await runGitStatus(pi, ctx, signal);
			return {
				content: [{ type: "text", text: status.output }],
				details: {
					command: "git status --porcelain=v1 -b",
					cwd: ctx.cwd,
					exitCode: status.exitCode,
					stdout: status.stdout,
					stderr: status.stderr,
				},
			};
		},
	});

	pi.registerCommand("git", {
		description: "Run `git status` porcelain passthrough",
		handler: async (args, ctx) => {
			const argv = normalizeArgs(args);
			if (argv.length === 0 || argv[0] !== "status") {
				if (!ctx.hasUI) return;
				ctx.ui.notify(usageText(), "info");
				return;
			}

			const status = await runGitStatus(pi, ctx);
			if (!ctx.hasUI) return;
			ctx.ui.notify(status.output, status.ok ? "info" : "warning");
		},
	});
}
