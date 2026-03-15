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

type ApprovalDecision = "approve-once" | "approve-all-session" | "deny" | "steer";

const STATUS_BAR_ID = "safe-mode";
const STATUS_BAR_SET_EVENT = "status-bar:set";
const ESC = "\u001b";

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

function getExactBashCommand(input: Record<string, unknown>): string | undefined {
	if (typeof input.command !== "string") return undefined;
	if (input.command.trim().length === 0) return undefined;
	return input.command;
}

function formatApprovalPrompt(ctx: ExtensionContext, toolName: string, input: Record<string, unknown>): {
	title: string;
	message: string;
} {
	const theme = ctx.ui.theme;
	const title = theme.fg("muted", "Approve?");
	const toolLine = theme.fg("text", `[${toolName}]:`);
	const request = getToolRequestText(toolName, input)
		.split("\n")
		.map((line) => theme.bg("toolPendingBg", theme.fg("warning", theme.bold(line))))
		.join("\n");

	return {
		title,
		message: `\n${toolLine}\n${request}`,
	};
}

const APPROVAL_OPTIONS = ["[Y]es", "[N]o", "[A]ll for this session", "[Esc] to steer"] as const;

async function confirmApproval(ctx: ExtensionContext, title: string, message: string): Promise<ApprovalDecision> {
	const controller = new AbortController();
	let keyDecision: ApprovalDecision | undefined;

	const unsubscribe = ctx.ui.onTerminalInput((data) => {
		if (data === "y" || data === "Y") {
			keyDecision = "approve-once";
			controller.abort();
			return { consume: true };
		}

		if (data === "n" || data === "N") {
			keyDecision = "deny";
			controller.abort();
			return { consume: true };
		}

		if (data === "a" || data === "A") {
			keyDecision = "approve-all-session";
			controller.abort();
			return { consume: true };
		}

		if (data === ESC) {
			keyDecision = "steer";
			controller.abort();
			return { consume: true };
		}

		return undefined;
	});

	try {
		const selected = await ctx.ui.select(`${title}${message}`, [...APPROVAL_OPTIONS], { signal: controller.signal });
		if (keyDecision) return keyDecision;
		if (selected === "[Y]es") return "approve-once";
		if (selected === "[A]ll for this session") return "approve-all-session";
		if (selected === "[N]o") return "deny";
		if (selected === "[Esc] to steer") return "steer";
		return "steer";
	} finally {
		unsubscribe();
	}
}

export default function safeModeExtension(pi: ExtensionAPI): void {
	let mode: SafeMode = DEFAULT_SAFE_MODE;
	const autoApprovedBashCommandsForSession = new Set<string>();

	function resetSessionApprovals(): void {
		autoApprovedBashCommandsForSession.clear();
	}

	function persistMode(): void {
		pi.appendEntry<SafeModeState>("safe-mode", { mode });
	}

	function updateStatus(ctx: ExtensionContext): void {
		const content = ctx.hasUI ? styleMode(ctx, mode) : `[${mode.toUpperCase()}]`;
		pi.events.emit(STATUS_BAR_SET_EVENT, { id: STATUS_BAR_ID, content });
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

	pi.registerCommand("safe-mode-list", {
		description: "List exact bash commands auto-approved for this session",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (autoApprovedBashCommandsForSession.size === 0) {
				ctx.ui.notify("safe-mode: no session auto-approved bash commands", "info");
				return;
			}

			const lines = [...autoApprovedBashCommandsForSession].map((command, index) => `${index + 1}. ${command}`);
			ctx.ui.notify(`safe-mode auto-approved bash commands:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Cycle safe mode",
		handler: async (ctx) => {
			setMode(cycleSafeMode(mode), ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		resetSessionApprovals();
		setMode(resolveMode(ctx), ctx, { persist: false, notify: false });
	});

	pi.on("session_tree", async (_event, ctx) => {
		resetSessionApprovals();
		setMode(resolveMode(ctx), ctx, { persist: false, notify: false });
	});

	pi.on("session_fork", async (_event, ctx) => {
		resetSessionApprovals();
		setMode(resolveMode(ctx), ctx, { persist: false, notify: false });
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		const exactBashCommand = event.toolName === "bash" ? getExactBashCommand(input) : undefined;

		if (exactBashCommand && autoApprovedBashCommandsForSession.has(exactBashCommand)) {
			return;
		}

		const decision = decideToolCall({
			mode,
			toolName: event.toolName,
			input,
			projectRoot: ctx.cwd,
		});

		if (decision.action === "allow") return;
		if (decision.action === "block") {
			return { block: true, reason: decision.reason ?? "Blocked by approval policy" };
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Approval required, but no UI is available: ${decision.summary}`,
			};
		}

		const prompt = formatApprovalPrompt(ctx, event.toolName, input);
		const approval = await confirmApproval(ctx, prompt.title, prompt.message);
		if (approval === "approve-all-session") {
			if (exactBashCommand) {
				autoApprovedBashCommandsForSession.add(exactBashCommand);
				ctx.ui.notify("safe-mode: remembered exact bash command for this session", "info");
			}
			return;
		}

		if (approval === "approve-once") {
			return;
		}

		if (approval === "steer") {
			const steerText = await ctx.ui.input("How should I proceed instead?", "Describe the safer approach");
			if (typeof steerText === "string" && steerText.trim().length > 0) {
				pi.sendUserMessage(steerText, { deliverAs: "steer" });
				ctx.ui.notify("safe-mode: steering message sent.", "info");
				return { block: true, reason: "Stopped for user steering: using updated user instructions instead." };
			}

			ctx.ui.notify("safe-mode: blocked. Type a follow-up message to steer the agent.", "info");
			return { block: true, reason: "Stopped for user steering." };
		}

		return {
			block: true,
			reason: "Blocked by user approval",
		};
	});
}
