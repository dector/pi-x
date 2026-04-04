import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const GitToolParams = Type.Object({
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Git argv-style arguments. Supported: status, log.",
		}),
	),
});

type GitToolParamsInput = {
	args?: string[];
};

type GitRunResult = {
	ok: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	output: string;
	command: string;
};

const STATUS_ARGS = ["status", "--porcelain=v1", "-b"] as const;
const LOG_DEFAULT_MAX_COUNT = 30;
const LOG_MAX_COUNT_LIMIT = 200;

function normalizeArgs(args: string[] | undefined): string[] {
	if (!Array.isArray(args)) return [];
	return args.map((part) => String(part).trim()).filter((part) => part.length > 0);
}

function usageText(): string {
	return [
		"usage: git <subtool>",
		"",
		"subtools:",
		"  status",
		"  log [--oneline] [-n N|--max-count N] [--author NAME] [--since DATE] [--until DATE] [<rev-range> ...]",
	].join("\n");
}

function summarizeCall(args: string[] | undefined): string {
	const argv = normalizeArgs(args);
	if (argv.length === 0) return "(show usage)";
	if (argv[0] === "status") return "status";
	if (argv[0] === "log") return argv.join(" ");
	return argv.join(" ");
}

function clampLogCount(value: number): number {
	if (!Number.isFinite(value) || value < 1) return LOG_DEFAULT_MAX_COUNT;
	return Math.min(Math.floor(value), LOG_MAX_COUNT_LIMIT);
}

function parsePositiveInt(raw: string): number | null {
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return null;
	return parsed;
}

function parseLogArgs(argv: string[]): { ok: true; args: string[] } | { ok: false; error: string } {
	const args: string[] = ["log"];
	const passthroughFlags = new Set(["--oneline", "--no-merges", "--decorate", "--all"]);
	const valueFlags = new Set(["--author", "--since", "--until", "--grep"]);
	let hasMaxCount = false;
	let hasFormat = false;

	for (let i = 1; i < argv.length; i += 1) {
		const token = argv[i];

		if (token === "--") {
			args.push("--", ...argv.slice(i + 1));
			break;
		}

		if (token === "-n" || token === "--max-count") {
			const next = argv[i + 1];
			if (!next) return { ok: false, error: "git log: missing value for max-count" };
			const parsed = parsePositiveInt(next);
			if (parsed == null) return { ok: false, error: `git log: invalid max-count \`${next}\`` };
			args.push("--max-count", String(clampLogCount(parsed)));
			hasMaxCount = true;
			i += 1;
			continue;
		}

		if (/^-n\d+$/.test(token)) {
			const parsed = parsePositiveInt(token.slice(2));
			if (parsed == null) return { ok: false, error: `git log: invalid max-count \`${token}\`` };
			args.push(`--max-count=${clampLogCount(parsed)}`);
			hasMaxCount = true;
			continue;
		}

		if (token.startsWith("--max-count=")) {
			const parsed = parsePositiveInt(token.slice("--max-count=".length));
			if (parsed == null) return { ok: false, error: `git log: invalid max-count \`${token}\`` };
			args.push(`--max-count=${clampLogCount(parsed)}`);
			hasMaxCount = true;
			continue;
		}

		if (token === "--pretty" || token === "--format") {
			const next = argv[i + 1];
			if (!next) return { ok: false, error: `git log: missing value for \`${token}\`` };
			args.push(token, next);
			hasFormat = true;
			i += 1;
			continue;
		}

		if (token.startsWith("--pretty=") || token.startsWith("--format=")) {
			args.push(token);
			hasFormat = true;
			continue;
		}

		if (valueFlags.has(token)) {
			const next = argv[i + 1];
			if (!next) return { ok: false, error: `git log: missing value for \`${token}\`` };
			args.push(token, next);
			i += 1;
			continue;
		}

		if (token.includes("=") && valueFlags.has(token.slice(0, token.indexOf("=")))) {
			args.push(token);
			continue;
		}

		if (passthroughFlags.has(token)) {
			args.push(token);
			if (token === "--oneline") hasFormat = true;
			continue;
		}

		if (token.startsWith("-")) {
			return { ok: false, error: `git log: unsupported flag \`${token}\`` };
		}

		// rev / range / ref name
		args.push(token);
	}

	if (!hasFormat) {
		args.push("--oneline");
	}
	if (!hasMaxCount) {
		args.push("--max-count", String(LOG_DEFAULT_MAX_COUNT));
	}

	return { ok: true, args };
}

async function runGit(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string[],
	signal?: AbortSignal,
	timeout = 10000,
) {
	const result = await pi.exec("git", args, {
		cwd: ctx.cwd,
		signal,
		timeout,
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
		command: `git ${args.join(" ")}`,
	};
}

async function runGitStatus(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal) {
	return runGit(pi, ctx, [...STATUS_ARGS], signal);
}

async function runGitLog(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	argv: string[],
	signal?: AbortSignal,
): Promise<GitRunResult> {
	const parsed = parseLogArgs(argv);
	if (!parsed.ok) {
		return {
			ok: false,
			exitCode: 2,
			stdout: "",
			stderr: parsed.error,
			output: parsed.error,
			command: "git log",
		};
	}
	return runGit(pi, ctx, parsed.args, signal);
}

export default function gitExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "git",
		label: "Git",
		description: "Git helper tool (supports status and log).",
		promptSnippet: "Use git tool for git operations.",
		parameters: GitToolParams,
		renderCall(args, theme) {
			const input = args as GitToolParamsInput;
			let text = theme.fg("toolTitle", `${theme.bold("git")} `);
			text += theme.fg("muted", summarizeCall(input.args));
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as GitToolParamsInput;
			const argv = normalizeArgs(input.args);

			if (argv.length === 0) {
				return {
					content: [{ type: "text", text: usageText() }],
					details: {
						supported: ["status", "log"],
						receivedArgs: argv,
					},
				};
			}

			let runResult: GitRunResult;

			switch (argv[0]) {
				case "status": {
					if (argv.length !== 1) {
						return {
							content: [{ type: "text", text: "git status: this subtool does not accept extra args" }],
							details: { supported: ["status", "log"], receivedArgs: argv },
						};
					}
					runResult = await runGitStatus(pi, ctx, signal);
					break;
				}
				case "log": {
					runResult = await runGitLog(pi, ctx, argv, signal);
					break;
				}
				default:
					return {
						content: [{ type: "text", text: usageText() }],
						details: {
							supported: ["status", "log"],
							receivedArgs: argv,
						},
					};
			}

			return {
				content: [{ type: "text", text: runResult.output }],
				details: {
					command: runResult.command,
					cwd: ctx.cwd,
					exitCode: runResult.exitCode,
					stdout: runResult.stdout,
					stderr: runResult.stderr,
				},
			};
		},
	});

	pi.registerCommand("git", {
		description: "Run git status/log helpers",
		handler: async (args, ctx) => {
			const argv = normalizeArgs(args);
			if (argv.length === 0) {
				if (!ctx.hasUI) return;
				ctx.ui.notify(usageText(), "info");
				return;
			}

			let result: GitRunResult;

			switch (argv[0]) {
				case "status": {
					if (argv.length !== 1) {
						if (!ctx.hasUI) return;
						ctx.ui.notify("git status: this subtool does not accept extra args", "warning");
						return;
					}
					result = await runGitStatus(pi, ctx);
					break;
				}
				case "log": {
					result = await runGitLog(pi, ctx, argv);
					break;
				}
				default:
					if (!ctx.hasUI) return;
					ctx.ui.notify(usageText(), "info");
					return;
			}

			if (!ctx.hasUI) return;
			ctx.ui.notify(result.output, result.ok ? "info" : "warning");
		},
	});
}
