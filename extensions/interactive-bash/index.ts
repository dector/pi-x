import { spawnSync } from "node:child_process";
import { createLocalBashOperations } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ParsedReadPrompt = {
	prompt: string;
	varName: string;
	tail: string;
};

function parseLeadingReadPrompt(command: string): ParsedReadPrompt | undefined {
	// Supported forms (at command start):
	//   read -p "Prompt" var
	//   read -r -p "Prompt" var
	//   read -p 'Prompt' var
	//   read var
	//   read -r var
	// with optional trailing shell tail, e.g. `&& echo $var`
	const doubleQuoted = command.match(
		/^\s*read\s+(?:-r\s+)?-p\s+"([^"]*)"\s+([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/,
	);
	if (doubleQuoted) {
		return {
			prompt: doubleQuoted[1] ?? "Input",
			varName: doubleQuoted[2] ?? "value",
			tail: doubleQuoted[3] ?? "",
		};
	}

	const singleQuoted = command.match(
		/^\s*read\s+(?:-r\s+)?-p\s+'([^']*)'\s+([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/,
	);
	if (singleQuoted) {
		return {
			prompt: singleQuoted[1] ?? "Input",
			varName: singleQuoted[2] ?? "value",
			tail: singleQuoted[3] ?? "",
		};
	}

	const noPrompt = command.match(/^\s*read\s+(?:-r\s+)?([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/);
	if (noPrompt) {
		const varName = noPrompt[1] ?? "value";
		return {
			prompt: `Enter ${varName}:`,
			varName,
			tail: noPrompt[2] ?? "",
		};
	}

	return undefined;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isLikelyInteractive(command: string): boolean {
	const c = command.trim().toLowerCase();

	// Common interactive/script input patterns
	return /\bsudo\b/.test(c) || /\bread\b/.test(c) || /\bpython(3)?\b/.test(c) || /\bnode\b/.test(c) || /\bbash\b/.test(c) || /\bsh\b/.test(c);
}

export default function (pi: ExtensionAPI) {
	pi.on("user_bash", async (event, ctx) => {
		let command = event.command.trim();
		let forceInteractive = false;

		// Use `!i <command>` to force interactive mode.
		if (command.startsWith("i ") || command.startsWith("i\t")) {
			forceInteractive = true;
			command = command.slice(2).trim();
		}

		// For simple read prompts, keep UX inside pi UI in normal mode.
		if (!forceInteractive) {
			const parsedRead = parseLeadingReadPrompt(command);
			if (parsedRead) {
				if (!ctx.hasUI) {
					return {
						result: {
							output: "Inline read prompt requested but no TUI is available.",
							exitCode: 1,
							cancelled: false,
							truncated: false,
						},
					};
				}

				const value = await ctx.ui.input(parsedRead.prompt, "");
				if (value === undefined) {
					return {
						result: {
							output: "(read prompt cancelled)",
							exitCode: 130,
							cancelled: true,
							truncated: false,
						},
					};
				}

				const rewritten = `${parsedRead.varName}=${shellQuote(value)}${parsedRead.tail}`;
				const local = createLocalBashOperations();

				return {
					operations: {
						exec: (_command, cwd, options) => local.exec(rewritten, cwd, options),
					},
				};
			}
		}

		const alwaysInteractive = process.env.PI_INTERACTIVE_BASH_ALL === "1";
		const shouldRunInteractive = forceInteractive || alwaysInteractive || isLikelyInteractive(command);
		if (!shouldRunInteractive) return;

		if (!ctx.hasUI) {
			return {
				result: {
					output:
						"Interactive command requested but no TUI is available. Re-run in interactive mode or disable interactive detection.",
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}

		const exitCode = await ctx.ui.custom<number>((tui, _theme, _kb, done) => {
			tui.stop();
			process.stdout.write("\x1b[2J\x1b[H");

			const shell = process.env.SHELL || "/bin/bash";
			const result = spawnSync(shell, ["-lc", command], {
				cwd: event.cwd,
				stdio: "inherit",
				env: process.env,
			});

			tui.start();
			tui.requestRender(true);

			done(result.status ?? (result.signal ? 130 : 1));
			return { render: () => [], invalidate: () => {} };
		});

		return {
			result: {
				output:
					exitCode === 0
						? "(interactive command completed successfully)"
						: `(interactive command exited with code ${exitCode})`,
				exitCode,
				cancelled: false,
				truncated: false,
			},
		};
	});
}
