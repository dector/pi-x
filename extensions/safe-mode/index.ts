import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
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

async function showSafeModeListManager(ctx: ExtensionContext, commandsForSession: Set<string>): Promise<void> {
	let commands = [...commandsForSession];
	if (commands.length === 0) return;

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let selectedIndex = 0;
		const selectedCommands = new Set<string>();
		const removedStack: string[] = [];
		let awaitingClearConfirmation = false;

		interface ListView {
			container: Container;
			list: SelectList;
			items: SelectItem[];
		}

		const getSelectedCountText = (): string => `${selectedCommands.size}/${commands.length} selected`;

		const buildView = (): ListView => {
			const items: SelectItem[] = commands.map((command) => ({
				value: command,
				label: `${selectedCommands.has(command) ? "[x]" : "[ ]"} ${command}`,
			}));

			const clampedIndex = items.length === 0 ? 0 : Math.max(0, Math.min(selectedIndex, items.length - 1));
			selectedIndex = clampedIndex;

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("safe-mode auto-approved bash commands"))));

			const list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			if (items.length > 0) {
				list.setSelectedIndex(selectedIndex);
			}

			list.onSelectionChange = (item) => {
				const nextIndex = items.findIndex((candidate) => candidate.value === item.value);
				selectedIndex = nextIndex >= 0 ? nextIndex : 0;
			};
			list.onCancel = () => done();

			container.addChild(list);

			if (awaitingClearConfirmation) {
				container.addChild(new Text(theme.fg("warning", "Clear all commands? [y/n]")));
			} else {
				container.addChild(new Text(theme.fg("dim", "j/k move • space select • d delete • D clear all • u undo • esc close")));
			}
			container.addChild(new Text(theme.fg("muted", getSelectedCountText())));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return { container, list, items };
		};

		let view = buildView();

		const refresh = () => {
			view = buildView();
			tui.requestRender();
		};

		const moveSelection = (delta: number) => {
			if (view.items.length === 0) return;
			const nextIndex = Math.max(0, Math.min(view.items.length - 1, selectedIndex + delta));
			selectedIndex = nextIndex;
			view.list.setSelectedIndex(selectedIndex);
			tui.requestRender();
		};

		const currentCommand = (): string | undefined => commands[selectedIndex];

		const toggleSelection = () => {
			const current = currentCommand();
			if (!current) return;
			if (selectedCommands.has(current)) {
				selectedCommands.delete(current);
			} else {
				selectedCommands.add(current);
			}
			refresh();
		};

		const deleteSelectedOrCurrent = () => {
			if (commands.length === 0) return;

			if (selectedCommands.size > 0) {
				const toRemove = commands.filter((command) => selectedCommands.has(command));
				for (const command of toRemove) {
					removedStack.push(command);
				}
				commands = commands.filter((command) => !selectedCommands.has(command));
				selectedCommands.clear();
			} else {
				const current = currentCommand();
				if (!current) return;
				removedStack.push(current);
				commands.splice(selectedIndex, 1);
			}

			if (commands.length === 0) {
				selectedIndex = 0;
			} else {
				selectedIndex = Math.max(0, Math.min(selectedIndex, commands.length - 1));
			}
			refresh();
		};

		const clearAll = () => {
			if (commands.length === 0) return;
			for (const command of commands) {
				removedStack.push(command);
			}
			commands = [];
			selectedCommands.clear();
			selectedIndex = 0;
			refresh();
		};

		const undoLastRemoval = () => {
			const restored = removedStack.pop();
			if (!restored) return;
			const insertIndex = commands.length === 0 ? 0 : Math.max(0, Math.min(selectedIndex, commands.length));
			commands.splice(insertIndex, 0, restored);
			selectedIndex = insertIndex;
			selectedCommands.delete(restored);
			refresh();
		};

		return {
			render(width: number) {
				return view.container.render(width);
			},
			invalidate() {
				view.container.invalidate();
			},
			handleInput(data: string) {
				if (awaitingClearConfirmation) {
					if (data === "y" || data === "Y") {
						awaitingClearConfirmation = false;
						clearAll();
						return;
					}
					if (data === "n" || data === "N" || data === ESC) {
						awaitingClearConfirmation = false;
						refresh();
						return;
					}
					return;
				}

				if (data === ESC) {
					done();
					return;
				}

				if (matchesKey(data, "j") || data === "j") {
					moveSelection(1);
					return;
				}
				if (matchesKey(data, "k") || data === "k") {
					moveSelection(-1);
					return;
				}

				if (matchesKey(data, Key.space) || data === " ") {
					toggleSelection();
					return;
				}

				if (data === "d") {
					deleteSelectedOrCurrent();
					return;
				}

				if (data === "D") {
					awaitingClearConfirmation = true;
					refresh();
					return;
				}

				if (data === "u" || data === "U") {
					undoLastRemoval();
					return;
				}

				view.list.handleInput(data);
				const selectedItem = view.list.getSelectedItem();
				if (selectedItem) {
					const nextIndex = view.items.findIndex((item) => item.value === selectedItem.value);
					selectedIndex = nextIndex >= 0 ? nextIndex : selectedIndex;
				}
				tui.requestRender();
			},
		};
	});

	commandsForSession.clear();
	for (const command of commands) {
		commandsForSession.add(command);
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
		description: "Manage exact bash commands auto-approved for this session",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (autoApprovedBashCommandsForSession.size === 0) {
				ctx.ui.notify("safe-mode: no session auto-approved bash commands", "info");
				return;
			}

			await showSafeModeListManager(ctx, autoApprovedBashCommandsForSession);
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
