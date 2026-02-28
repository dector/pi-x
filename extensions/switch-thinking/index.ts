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

export default function switchThinkingExtension(pi: ExtensionAPI) {
	let favorites: ThinkingMode[] = [];
	let pickerOpen = false;

	const persistFavorites = (ctx: ExtensionContext): boolean => {
		const result = saveGlobalState({ version: 1, favorites });
		if (!result.ok) {
			notify(ctx, result.error, "error");
			return false;
		}
		return true;
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (favorites.length === 0) {
			ctx.ui.setStatus("switch-thinking", undefined);
			return;
		}
		ctx.ui.setStatus(
			"switch-thinking",
			ctx.ui.theme.fg("accent", `🧠 fav:${favorites.join(",")}`),
		);
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
			notify(ctx, "No favorite thinking modes set. Use Ctrl+Shift+T and Space to add favorites.", "warning");
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
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
		if (favorites.length === 0) return;
		if (getAvailableFavorites(ctx).length > 0) return;
		notify(ctx, `No favorite thinking modes are available on this model. Favorites file: ${GLOBAL_STATE_PATH}`, "warning");
	});

	pi.registerShortcut(Key.ctrlShift("t"), {
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
