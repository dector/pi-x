import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import {
	GLOBAL_STATE_PATH,
	THINKING_MODES,
	loadGlobalState,
	saveGlobalState,
	type ThinkingMode,
} from "./state";
import { showThinkingPicker } from "./ui";

function asModeSet(modes: ThinkingMode[]): Set<ThinkingMode> {
	return new Set(modes);
}

function orderedByCanonical(modes: ThinkingMode[]): ThinkingMode[] {
	const set = asModeSet(modes);
	return THINKING_MODES.filter((mode) => set.has(mode));
}

function uniqueModes(modes: ThinkingMode[]): ThinkingMode[] {
	return orderedByCanonical(modes);
}

function isReasoningDisabled(model: ExtensionContext["model"]): boolean {
	return model?.reasoning === false;
}

function getAvailableModes(model: ExtensionContext["model"]): ThinkingMode[] {
	if (isReasoningDisabled(model)) return ["off"];
	return [...THINKING_MODES];
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type !== "info") console.warn(`[switch-thinking] ${message}`);
}

const STATUS_BAR_ID = "switch-thinking";
const STATUS_BAR_SET_EVENT = "status-bar:set";
const STATUS_BAR_CLEAR_EVENT = "status-bar:clear";

export default function switchThinkingExtension(pi: ExtensionAPI) {
	let favorites: ThinkingMode[] = [];
	let pickerOpen = false;
	let detachTerminalInput: (() => void) | undefined;
	let deferredRefreshScheduled = false;

	const persistFavorites = (ctx: ExtensionContext): boolean => {
		const result = saveGlobalState({ version: 1, favorites });
		if (!result.ok) {
			notify(ctx, result.error, "error");
			return false;
		}
		return true;
	};

	let lastStatusMode: ThinkingMode | undefined;
	let lastStatusSignature: string | undefined;

	const updateStatus = (ctx: ExtensionContext) => {
		if (favorites.length === 0) {
			lastStatusMode = undefined;
			if (lastStatusSignature !== undefined) {
				pi.events.emit(STATUS_BAR_CLEAR_EVENT, { id: STATUS_BAR_ID });
				lastStatusSignature = undefined;
			}
			return;
		}

		const current = pi.getThinkingLevel();
		lastStatusMode = current;

		// Render favorites, but if current mode is not a favorite,
		// show it ephemerally in canonical position without persisting it.
		const displayModes = uniqueModes([...favorites, current]);
		const signature = `${displayModes.join(",")}|${current}`;
		if (signature === lastStatusSignature) return;
		lastStatusSignature = signature;

		const leftBar = ctx.hasUI ? ctx.ui.theme.fg("muted", "|") : "|";
		const rightBar = ctx.hasUI ? ctx.ui.theme.fg("muted", "|") : "|";
		const modes = displayModes.map((mode) => {
			if (!ctx.hasUI) return mode;
			return mode === current ? ctx.ui.theme.fg("accent", mode) : ctx.ui.theme.fg("muted", mode);
		});

		pi.events.emit(STATUS_BAR_SET_EVENT, {
			id: STATUS_BAR_ID,
			content: `${leftBar} ${modes.join(" ")} ${rightBar}`,
		});
	};

	const refreshStatusIfModeChanged = (ctx: ExtensionContext) => {
		if (favorites.length === 0) return;
		const current = pi.getThinkingLevel();
		if (current === lastStatusMode) return;
		updateStatus(ctx);
	};

	const scheduleDeferredStatusRefresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (deferredRefreshScheduled) return;
		deferredRefreshScheduled = true;
		setTimeout(() => {
			deferredRefreshScheduled = false;
			refreshStatusIfModeChanged(ctx);
		}, 0);
	};

	const toggleFavorite = (mode: ThinkingMode, ctx: ExtensionContext) => {
		const alreadyFavorite = favorites.includes(mode);
		if (alreadyFavorite) {
			favorites = favorites.filter((favorite) => favorite !== mode);
		} else {
			favorites = uniqueModes([...favorites, mode]);
		}
		persistFavorites(ctx);
		updateStatus(ctx);
	};

	const applyThinkingMode = (mode: ThinkingMode, ctx: ExtensionContext) => {
		const before = pi.getThinkingLevel();
		pi.setThinkingLevel(mode);
		const applied = pi.getThinkingLevel();
		updateStatus(ctx);

		if (applied !== mode) {
			notify(ctx, `Requested thinking mode '${mode}' was clamped to '${applied}'.`, "warning");
			return;
		}

		if (before !== applied) {
			notify(ctx, `Thinking mode: ${applied}`, "info");
		}
	};

	const getAvailableFavorites = (ctx: ExtensionContext): ThinkingMode[] => {
		const available = new Set(getAvailableModes(ctx.model));
		return orderedByCanonical(favorites.filter((mode) => available.has(mode)));
	};

	const cycleFavorites = (ctx: ExtensionContext) => {
		if (pickerOpen) return;

		if (favorites.length === 0) {
			notify(ctx, "No favorite thinking modes set. Use Ctrl+Alt+T and Space to add favorites.", "warning");
			return;
		}

		const availableFavorites = getAvailableFavorites(ctx);
		if (availableFavorites.length === 0) {
			notify(
				ctx,
				"All favorite thinking modes are unavailable for the current model. Try switching model or add 'off'.",
				"warning",
			);
			return;
		}

		const current = pi.getThinkingLevel();
		let target: ThinkingMode;

		if (availableFavorites.length === 1) {
			target = availableFavorites[0]!;
		} else {
			const currentIndex = availableFavorites.indexOf(current);
			target = currentIndex === -1 ? availableFavorites[0]! : availableFavorites[(currentIndex + 1) % availableFavorites.length]!;
		}

		applyThinkingMode(target, ctx);
	};

	const openPicker = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (pickerOpen) return;

		pickerOpen = true;
		try {
			await showThinkingPicker(ctx, {
				availableModes: getAvailableModes(ctx.model),
				getCurrentMode: () => pi.getThinkingLevel(),
				getFavorites: () => favorites,
				onSelect: (mode) => {
					applyThinkingMode(mode, ctx);
				},
				onToggleFavorite: (mode) => {
					toggleFavorite(mode, ctx);
				},
			});
		} finally {
			pickerOpen = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadGlobalState();
		favorites = uniqueModes(loaded.state.favorites);
		if (loaded.error) {
			notify(ctx, `${loaded.error}. Using empty favorites for this session.`, "warning");
		}

		if (ctx.hasUI && !detachTerminalInput) {
			detachTerminalInput = ctx.ui.onTerminalInput(() => {
				refreshStatusIfModeChanged(ctx);
				scheduleDeferredStatusRefresh(ctx);
				return undefined;
			});
		}

		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
		if (favorites.length === 0) return;
		if (getAvailableFavorites(ctx).length > 0) return;
		notify(ctx, `No favorite thinking modes are available on this model. Favorites file: ${GLOBAL_STATE_PATH}`, "warning");
	});

	const bindStatusRefresh = (eventName: "turn_start" | "turn_end" | "agent_start" | "agent_end" | "message_start" | "message_update" | "message_end" | "session_switch" | "session_fork" | "session_tree" | "input" | "user_bash") => {
		pi.on(eventName, async (_event, ctx) => {
			refreshStatusIfModeChanged(ctx);
		});
	};

	bindStatusRefresh("turn_start");
	bindStatusRefresh("turn_end");
	bindStatusRefresh("agent_start");
	bindStatusRefresh("agent_end");
	bindStatusRefresh("message_start");
	bindStatusRefresh("message_update");
	bindStatusRefresh("message_end");
	bindStatusRefresh("session_switch");
	bindStatusRefresh("session_fork");
	bindStatusRefresh("session_tree");
	bindStatusRefresh("input");
	bindStatusRefresh("user_bash");

	pi.on("session_shutdown", async () => {
		detachTerminalInput?.();
		detachTerminalInput = undefined;
		deferredRefreshScheduled = false;
	});

	pi.registerShortcut(Key.ctrlAlt("t"), {
		description: "Open thinking mode picker",
		handler: async (ctx) => {
			await openPicker(ctx);
		},
	});

	pi.registerShortcut(Key.ctrl("t"), {
		description: "Cycle favorite thinking modes",
		handler: async (ctx) => {
			cycleFavorites(ctx);
		},
	});
}
