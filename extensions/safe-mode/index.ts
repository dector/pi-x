import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
	outerAccess: boolean;
}

type ApprovalDecision = "approve-once" | "approve-all-session" | "approve-project" | "deny" | "steer";

type AllowlistScope = "project" | "session";

type AllowlistEntry = {
	command: string;
	scope: AllowlistScope;
};

const STATUS_BAR_ID = "safe-mode";
const STATUS_BAR_SET_EVENT = "status-bar:set";
const ESC = "\u001b";
const OUTER_ACCESS_FLAG = "safe-mode-outer-access";
const SMART_ALLOWLIST_RELATIVE_PATH = ".pi/memory/safe-mode/smart-allowlist.json";

type MaybeCustomEntry = {
	type?: string;
	customType?: string;
	data?: { mode?: unknown; outerAccess?: unknown };
};

function formatModeList(): string {
	return SAFE_MODES.join(" | ");
}

function parseBooleanLike(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "on" || normalized === "1") return true;
	if (normalized === "false" || normalized === "off" || normalized === "0") return false;
	return undefined;
}

function getSmartAllowlistPath(projectRoot: string): string {
	return resolve(projectRoot, SMART_ALLOWLIST_RELATIVE_PATH);
}

function normalizeAllowlistCommands(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const deduped = new Set<string>();
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const command = item.trim();
		if (command.length === 0) continue;
		deduped.add(command);
	}
	return [...deduped];
}

async function loadProjectSmartAllowlist(projectRoot: string): Promise<Set<string>> {
	const filePath = getSmartAllowlistPath(projectRoot);
	try {
		const raw = await readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			return new Set(normalizeAllowlistCommands(parsed));
		}

		if (parsed && typeof parsed === "object") {
			if ("allow" in parsed) {
				const commands = normalizeAllowlistCommands((parsed as { allow?: unknown }).allow);
				return new Set(commands);
			}

			if ("commands" in parsed) {
				const commands = normalizeAllowlistCommands((parsed as { commands?: unknown }).commands);
				return new Set(commands);
			}
		}

		return new Set();
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return new Set();
		throw error;
	}
}

async function saveProjectSmartAllowlist(projectRoot: string, commands: Set<string>): Promise<void> {
	const filePath = getSmartAllowlistPath(projectRoot);
	await mkdir(dirname(filePath), { recursive: true });
	const content = {
		allow: [...commands].sort((a, b) => a.localeCompare(b)),
		deny: [] as string[],
	};
	await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

function styleMode(ctx: ExtensionContext, mode: SafeMode, outerAccess: boolean): string {
	const suffix = mode !== "paranoid" && outerAccess ? "!" : "";
	const label = `[${mode.toUpperCase()}${suffix}]`;
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

function getPersistedStateFromBranch(ctx: ExtensionContext): Partial<SafeModeState> {
	let mode: SafeMode | undefined;
	let outerAccess: boolean | undefined;
	for (const entry of ctx.sessionManager.getBranch() as MaybeCustomEntry[]) {
		if (entry.type !== "custom" || entry.customType !== "safe-mode") continue;
		const parsedMode = parseSafeMode(entry.data?.mode);
		if (parsedMode) mode = parsedMode;
		const parsedOuter = parseBooleanLike(entry.data?.outerAccess);
		if (parsedOuter !== undefined) outerAccess = parsedOuter;
	}
	return { mode, outerAccess };
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

const BASE_APPROVAL_OPTIONS = ["[Y]es", "[N]o", "[A]ll for this session", "[Esc] to steer"] as const;
const PROJECT_APPROVAL_OPTION = "[P]ermanently allow";

async function confirmApproval(
	ctx: ExtensionContext,
	title: string,
	message: string,
	options?: { allowProjectApproval?: boolean },
): Promise<ApprovalDecision> {
	const allowProjectApproval = options?.allowProjectApproval ?? false;
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

		if (allowProjectApproval && (data === "p" || data === "P")) {
			keyDecision = "approve-project";
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
		const selectOptions = allowProjectApproval
			? [BASE_APPROVAL_OPTIONS[0], BASE_APPROVAL_OPTIONS[1], BASE_APPROVAL_OPTIONS[2], PROJECT_APPROVAL_OPTION, BASE_APPROVAL_OPTIONS[3]]
			: [...BASE_APPROVAL_OPTIONS];
		const selected = await ctx.ui.select(`${title}${message}`, selectOptions, { signal: controller.signal });
		if (keyDecision) return keyDecision;
		if (selected === "[Y]es") return "approve-once";
		if (selected === "[A]ll for this session") return "approve-all-session";
		if (selected === PROJECT_APPROVAL_OPTION) return "approve-project";
		if (selected === "[N]o") return "deny";
		if (selected === "[Esc] to steer") return "steer";
		return "steer";
	} finally {
		unsubscribe();
	}
}

async function showSafeModeListManager(args: {
	ctx: ExtensionContext;
	sessionCommands: Set<string>;
	projectCommands: Set<string>;
	canModifyProjectRules: boolean;
}): Promise<{ sessionCommands: Set<string>; projectCommands: Set<string> }> {
	const { ctx, canModifyProjectRules } = args;
	let projectCommands = [...args.projectCommands];
	let sessionCommands = [...args.sessionCommands].filter((command) => !args.projectCommands.has(command));

	type Entry = { key: string; command: string; scope: AllowlistScope };
	const toEntries = (): Entry[] => [
		...projectCommands.map((command) => ({ key: `project:${command}`, command, scope: "project" as const })),
		...sessionCommands.map((command) => ({ key: `session:${command}`, command, scope: "session" as const })),
	];

	if (toEntries().length === 0) {
		return { sessionCommands: new Set(), projectCommands: new Set() };
	}

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let selectedIndex = 0;
		const selectedEntries = new Set<string>();
		const removedStack: AllowlistEntry[] = [];
		let awaitingClearConfirmation = false;

		interface ListView {
			container: Container;
			list: SelectList;
			items: SelectItem[];
			entries: Entry[];
		}

		const getSelectedCountText = (entries: Entry[]): string => `${selectedEntries.size}/${entries.length} selected`;
		const getCurrentEntry = (entries: Entry[]): Entry | undefined => entries[selectedIndex];
		const isProjectLocked = (entry: Entry): boolean => entry.scope === "project" && !canModifyProjectRules;
		const entryToAllowlistEntry = (entry: Entry): AllowlistEntry => ({ command: entry.command, scope: entry.scope });

		const buildView = (): ListView => {
			const entries = toEntries();
			const items: SelectItem[] = entries.map((entry) => {
				const isSelected = selectedEntries.has(entry.key);
				const prefix = isSelected ? "[x]" : "[ ]";
				const label = `${prefix} ${entry.scope === "project" ? "(project) " : ""}${entry.command}`;
				return {
					value: entry.key,
					label: isProjectLocked(entry) ? theme.fg("muted", label) : label,
				};
			});

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
				container.addChild(new Text(theme.fg("warning", "Clear all session commands? [y/n]")));
			} else {
				container.addChild(new Text(theme.fg("dim", "j/k move • space select • d delete • D clear session • u undo • esc close")));
				if (!canModifyProjectRules) {
					container.addChild(new Text(theme.fg("muted", "(project) entries are read-only outside smart mode")));
				}
			}
			container.addChild(new Text(theme.fg("muted", getSelectedCountText(entries))));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return { container, list, items, entries };
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

		const toggleSelection = () => {
			const current = getCurrentEntry(view.entries);
			if (!current || isProjectLocked(current)) return;
			if (selectedEntries.has(current.key)) {
				selectedEntries.delete(current.key);
			} else {
				selectedEntries.add(current.key);
			}
			refresh();
		};

		const removeEntry = (entry: Entry) => {
			if (entry.scope === "project") {
				projectCommands = projectCommands.filter((command) => command !== entry.command);
			} else {
				sessionCommands = sessionCommands.filter((command) => command !== entry.command);
			}
			selectedEntries.delete(entry.key);
			removedStack.push(entryToAllowlistEntry(entry));
		};

		const deleteSelectedOrCurrent = () => {
			if (view.entries.length === 0) return;

			if (selectedEntries.size > 0) {
				for (const entry of view.entries) {
					if (!selectedEntries.has(entry.key) || isProjectLocked(entry)) continue;
					removeEntry(entry);
				}
			} else {
				const current = getCurrentEntry(view.entries);
				if (!current || isProjectLocked(current)) return;
				removeEntry(current);
			}

			const nextEntries = toEntries();
			selectedIndex = nextEntries.length === 0 ? 0 : Math.max(0, Math.min(selectedIndex, nextEntries.length - 1));
			refresh();
		};

		const clearAll = () => {
			if (sessionCommands.length === 0) return;
			for (const command of sessionCommands) {
				removedStack.push({ command, scope: "session" });
			}
			sessionCommands = [];
			selectedEntries.clear();
			selectedIndex = 0;
			refresh();
		};

		const undoLastRemoval = () => {
			const restored = removedStack.pop();
			if (!restored) return;
			if (restored.scope === "project") {
				projectCommands.splice(projectCommands.length, 0, restored.command);
			} else {
				sessionCommands.splice(sessionCommands.length, 0, restored.command);
			}
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

	return {
		sessionCommands: new Set(sessionCommands),
		projectCommands: new Set(projectCommands),
	};
}

export default function safeModeExtension(pi: ExtensionAPI): void {
	let mode: SafeMode = DEFAULT_SAFE_MODE;
	let outerAccess = false;
	let activeProjectRoot = "";
	const autoApprovedBashCommandsForSession = new Set<string>();
	const autoApprovedBashCommandsForProject = new Set<string>();

	function resetSessionApprovals(): void {
		autoApprovedBashCommandsForSession.clear();
	}

	async function loadProjectApprovals(ctx: ExtensionContext): Promise<void> {
		autoApprovedBashCommandsForProject.clear();
		activeProjectRoot = ctx.cwd;
		try {
			const loaded = await loadProjectSmartAllowlist(ctx.cwd);
			for (const command of loaded) {
				autoApprovedBashCommandsForProject.add(command);
			}
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(`safe-mode: failed to load project allowlist (${String(error)})`, "warning");
			}
		}
	}

	async function persistProjectApprovals(ctx: ExtensionContext): Promise<void> {
		const projectRoot = activeProjectRoot || ctx.cwd;
		await saveProjectSmartAllowlist(projectRoot, autoApprovedBashCommandsForProject);
	}

	function persistState(): void {
		pi.appendEntry<SafeModeState>("safe-mode", { mode, outerAccess });
	}

	function statusLabel(): string {
		const suffix = mode !== "paranoid" && outerAccess ? "!" : "";
		return `[${mode.toUpperCase()}${suffix}]`;
	}

	function updateStatus(ctx: ExtensionContext): void {
		const content = ctx.hasUI ? styleMode(ctx, mode, outerAccess) : statusLabel();
		pi.events.emit(STATUS_BAR_SET_EVENT, { id: STATUS_BAR_ID, content });
	}

	function setMode(nextMode: SafeMode, ctx: ExtensionContext, options?: { persist?: boolean; notify?: boolean }): void {
		const persist = options?.persist ?? true;
		const notify = options?.notify ?? true;
		const changed = nextMode !== mode;

		mode = nextMode;
		updateStatus(ctx);

		if (persist && changed) {
			persistState();
		}

		if (notify && ctx.hasUI) {
			ctx.ui.notify(`Safe mode: ${statusLabel()}`, "info");
		}
	}

	function setOuterAccess(nextOuterAccess: boolean, ctx: ExtensionContext, options?: { persist?: boolean; notify?: boolean }): void {
		const persist = options?.persist ?? true;
		const notify = options?.notify ?? true;
		const changed = nextOuterAccess !== outerAccess;

		outerAccess = nextOuterAccess;
		updateStatus(ctx);

		if (persist && changed) {
			persistState();
		}

		if (notify && ctx.hasUI) {
			ctx.ui.notify(`Safe mode outer access: ${outerAccess ? "on" : "off"}`, "info");
		}
	}

	function applyResolvedState(ctx: ExtensionContext): void {
		const persisted = getPersistedStateFromBranch(ctx);

		const modeFlagRaw = pi.getFlag("safe-mode");
		const modeFlag = parseSafeMode(modeFlagRaw);
		if (typeof modeFlagRaw === "string" && modeFlagRaw.trim().length > 0 && !modeFlag && ctx.hasUI) {
			ctx.ui.notify(
				`Ignoring invalid --safe-mode value '${modeFlagRaw}'. Expected one of: ${formatModeList()}`,
				"warning",
			);
		}

		const outerFlagRaw = pi.getFlag(OUTER_ACCESS_FLAG);
		const outerFlag = parseBooleanLike(outerFlagRaw);
		if (outerFlagRaw !== undefined && outerFlag === undefined && ctx.hasUI) {
			ctx.ui.notify(
				`Ignoring invalid --${OUTER_ACCESS_FLAG} value '${String(outerFlagRaw)}'. Expected true/false.`,
				"warning",
			);
		}

		mode = modeFlag ?? persisted.mode ?? DEFAULT_SAFE_MODE;
		outerAccess = outerFlag ?? persisted.outerAccess ?? false;
		updateStatus(ctx);
	}

	pi.registerFlag("safe-mode", {
		description: `Tool approval mode: ${formatModeList()}`,
		type: "string",
		default: DEFAULT_SAFE_MODE,
	});

	pi.registerFlag(OUTER_ACCESS_FLAG, {
		description: "Apply mode rules to paths outside the project root",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("safe-mode", {
		description: `Show or set safe mode (${formatModeList()})`,
		handler: async (args, ctx) => {
			const input = args?.trim() ?? "";

			if (input.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Current safe mode: ${statusLabel()} (outer access: ${outerAccess ? "on" : "off"}). Available: ${formatModeList()}`,
						"info",
					);
				}
				return;
			}

			const normalized = input.toLowerCase();
			if (normalized === "cycle") {
				setMode(cycleSafeMode(mode), ctx);
				return;
			}

			if (normalized.startsWith("outer")) {
				const parts = normalized.split(/\s+/);
				const action = parts[1];
				if (action === "toggle") {
					setOuterAccess(!outerAccess, ctx);
					return;
				}
				if (action === "on" || action === "true") {
					setOuterAccess(true, ctx);
					return;
				}
				if (action === "off" || action === "false") {
					setOuterAccess(false, ctx);
					return;
				}

				if (ctx.hasUI) {
					ctx.ui.notify("Invalid outer modifier. Use: /safe-mode outer on|off|toggle", "warning");
				}
				return;
			}

			const parsed = parseSafeMode(input);
			if (!parsed) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Invalid mode '${input}'. Use one of: ${formatModeList()}, 'cycle', or 'outer on|off|toggle'.`,
						"warning",
					);
				}
				return;
			}

			setMode(parsed, ctx);
		},
	});

	pi.registerCommand("safe-mode-list", {
		description: "Manage exact bash commands auto-approved for this session and project",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (activeProjectRoot !== ctx.cwd) {
				await loadProjectApprovals(ctx);
			}

			if (autoApprovedBashCommandsForSession.size === 0 && autoApprovedBashCommandsForProject.size === 0) {
				ctx.ui.notify("safe-mode: no auto-approved bash commands", "info");
				return;
			}

			const updated = await showSafeModeListManager({
				ctx,
				sessionCommands: autoApprovedBashCommandsForSession,
				projectCommands: autoApprovedBashCommandsForProject,
				canModifyProjectRules: mode === "smart",
			});

			autoApprovedBashCommandsForSession.clear();
			for (const command of updated.sessionCommands) {
				autoApprovedBashCommandsForSession.add(command);
			}

			autoApprovedBashCommandsForProject.clear();
			for (const command of updated.projectCommands) {
				autoApprovedBashCommandsForProject.add(command);
			}

			try {
				await persistProjectApprovals(ctx);
			} catch (error) {
				ctx.ui.notify(`safe-mode: failed to persist project allowlist (${String(error)})`, "warning");
			}
		},
	});

	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Cycle safe mode",
		handler: async (ctx) => {
			setMode(cycleSafeMode(mode), ctx);
		},
	});

	pi.registerShortcut(Key.ctrlShiftAlt("m"), {
		description: "Toggle safe mode outer access",
		handler: async (ctx) => {
			setOuterAccess(!outerAccess, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		resetSessionApprovals();
		applyResolvedState(ctx);
		await loadProjectApprovals(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		resetSessionApprovals();
		applyResolvedState(ctx);
		await loadProjectApprovals(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		resetSessionApprovals();
		applyResolvedState(ctx);
		await loadProjectApprovals(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		const exactBashCommand = event.toolName === "bash" ? getExactBashCommand(input) : undefined;

		if (exactBashCommand && autoApprovedBashCommandsForSession.has(exactBashCommand)) {
			return;
		}

		if (mode === "smart" && exactBashCommand && autoApprovedBashCommandsForProject.has(exactBashCommand)) {
			return;
		}

		const decision = decideToolCall({
			mode,
			toolName: event.toolName,
			input,
			projectRoot: ctx.cwd,
			outerAccess,
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
		const approval = await confirmApproval(ctx, prompt.title, prompt.message, {
			allowProjectApproval: mode === "smart" && Boolean(exactBashCommand),
		});
		if (approval === "approve-all-session") {
			if (exactBashCommand) {
				autoApprovedBashCommandsForSession.add(exactBashCommand);
				ctx.ui.notify("safe-mode: remembered exact bash command for this session", "info");
			}
			return;
		}

		if (approval === "approve-project") {
			if (mode === "smart" && exactBashCommand) {
				autoApprovedBashCommandsForProject.add(exactBashCommand);
				try {
					await persistProjectApprovals(ctx);
					ctx.ui.notify("safe-mode: remembered exact bash command for this project", "info");
				} catch (error) {
					ctx.ui.notify(`safe-mode: failed to persist project allowlist (${String(error)})`, "warning");
				}
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
