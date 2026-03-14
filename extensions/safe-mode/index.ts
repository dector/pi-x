import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import {
	DEFAULT_SAFE_MODE,
	SAFE_MODES,
	cycleSafeMode,
	decideToolCall,
	describeToolCall,
	parseSafeMode,
	type SafeMode,
} from "./policy";

interface SafeModeState {
	mode: SafeMode;
}

type MaybeCustomEntry = {
	type?: string;
	customType?: string;
	data?: { mode?: unknown };
};

function formatModeList(): string {
	return SAFE_MODES.join(" | ");
}

function styleMode(ctx: ExtensionContext, mode: SafeMode): string {
	const label = `[${mode.toUpperCase()}]`;
	switch (mode) {
		case "yolo":
			return ctx.ui.theme.fg("error", label);
		case "smart":
			return ctx.ui.theme.fg("text", label);
		case "reader":
			return ctx.ui.theme.fg("success", label);
		case "paranoid":
		default:
			return ctx.ui.theme.fg("muted", label);
	}
}

function getPersistedModeFromBranch(ctx: ExtensionContext): SafeMode | undefined {
	let persisted: SafeMode | undefined;
	for (const entry of ctx.sessionManager.getBranch() as MaybeCustomEntry[]) {
		if (entry.type !== "custom" || entry.customType !== "safe-mode") continue;
		const parsed = parseSafeMode(entry.data?.mode);
		if (parsed) persisted = parsed;
	}
	return persisted;
}

function getToolRequestText(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command.trim() : "";
		return command.length > 0 ? command : "(empty command)";
	}

	const summary = describeToolCall(toolName, input);
	const prefix = `${toolName}: `;
	if (summary.startsWith(prefix)) {
		return summary.slice(prefix.length);
	}

	if (summary !== toolName) {
		return summary;
	}

	return Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : "(no arguments)";
}

function formatApprovalPrompt(ctx: ExtensionContext, toolName: string, input: Record<string, unknown>): {
	title: string;
	message: string;
} {
	const theme = ctx.ui.theme;
	const promptLine = theme.fg("muted", "Approve? y/n");
	const toolLine = theme.fg("text", `[${toolName}]:`);
	const request = getToolRequestText(toolName, input)
		.split("\n")
		.map((line) => theme.bg("toolPendingBg", theme.fg("warning", theme.bold(line))))
		.join("\n");

	return {
		title: promptLine,
		message: `\n${toolLine}\n${request}`,
	};
}

async function confirmApproval(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
	const controller = new AbortController();
	let keyDecision: boolean | undefined;

	const unsubscribe = ctx.ui.onTerminalInput((data) => {
		if (data === "y") {
			keyDecision = true;
			controller.abort();
			return { consume: true };
		}

		if (data === "n" || data === "N") {
			keyDecision = false;
			controller.abort();
			return { consume: true };
		}

		return undefined;
	});

	try {
		const confirmed = await ctx.ui.confirm(title, message, { signal: controller.signal });
		return keyDecision ?? confirmed;
	} finally {
		unsubscribe();
	}
}

export default function safeModeExtension(pi: ExtensionAPI): void {
	let mode: SafeMode = DEFAULT_SAFE_MODE;

	function persistMode(): void {
		pi.appendEntry<SafeModeState>("safe-mode", { mode });
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("safe-mode", styleMode(ctx, mode));
	}

	function setMode(nextMode: SafeMode, ctx: ExtensionContext, options?: { persist?: boolean; notify?: boolean }): void {
		const persist = options?.persist ?? true;
		const notify = options?.notify ?? true;
		const changed = nextMode !== mode;

		mode = nextMode;
		updateStatus(ctx);

		if (persist && changed) {
			persistMode();
		}

		if (notify && ctx.hasUI) {
			ctx.ui.notify(`Safe mode: ${mode}`, "info");
		}
	}

	function resolveMode(ctx: ExtensionContext): SafeMode {
		const persisted = getPersistedModeFromBranch(ctx) ?? DEFAULT_SAFE_MODE;
		const flagRaw = pi.getFlag("safe-mode");
		const flagMode = parseSafeMode(flagRaw);

		if (typeof flagRaw === "string" && flagRaw.trim().length > 0 && !flagMode && ctx.hasUI) {
			ctx.ui.notify(
				`Ignoring invalid --safe-mode value '${flagRaw}'. Expected one of: ${formatModeList()}`,
				"warning",
			);
		}

		return flagMode ?? persisted;
	}

	pi.registerFlag("safe-mode", {
		description: `Tool approval mode: ${formatModeList()}`,
		type: "string",
		default: DEFAULT_SAFE_MODE,
	});

	pi.registerCommand("safe-mode", {
		description: `Show or set safe mode (${formatModeList()})`,
		handler: async (args, ctx) => {
			const input = args?.trim() ?? "";

			if (input.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Current safe mode: ${mode}. Available: ${formatModeList()}`, "info");
				}
				return;
			}

			if (input.toLowerCase() === "cycle") {
				setMode(cycleSafeMode(mode), ctx);
				return;
			}

			const parsed = parseSafeMode(input);
			if (!parsed) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Invalid mode '${input}'. Use one of: ${formatModeList()} or 'cycle'.`, "warning");
				}
				return;
			}

			setMode(parsed, ctx);
		},
	});

	pi.registerShortcut(Key.alt("m"), {
		description: "Cycle safe mode",
		handler: async (ctx) => {
			setMode(cycleSafeMode(mode), ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		setMode(resolveMode(ctx), ctx, { persist: false, notify: false });
	});

	pi.on("session_tree", async (_event, ctx) => {
		setMode(resolveMode(ctx), ctx, { persist: false, notify: false });
	});

	pi.on("session_fork", async (_event, ctx) => {
		setMode(resolveMode(ctx), ctx, { persist: false, notify: false });
	});

	pi.on("before_agent_start", async () => {
		if (mode === "yolo") return;
		return {
			message: {
				customType: "safe-mode-context",
				content: `[SAFE MODE: ${mode}]\nApply the configured tool safety policy. Prefer operations that are auto-allowed in this mode.`,
				display: false,
			},
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const decision = decideToolCall({
			mode,
			toolName: event.toolName,
			input: (event.input ?? {}) as Record<string, unknown>,
			projectRoot: ctx.cwd,
		});

		if (decision.action === "allow") return;
		if (decision.action === "block") {
			return { block: true, reason: decision.reason ?? `Blocked by safe mode (${mode})` };
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Safe mode (${mode}) requires approval, but no UI is available: ${decision.summary}`,
			};
		}

		const input = (event.input ?? {}) as Record<string, unknown>;
		const prompt = formatApprovalPrompt(ctx, event.toolName, input);
		const ok = await confirmApproval(ctx, prompt.title, prompt.message);
		if (!ok) {
			return {
				block: true,
				reason: `Blocked by user (safe mode: ${mode})`,
			};
		}
	});
}
