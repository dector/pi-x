import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isViewportTUI, matchesKey, parseKey, type TUI } from "@earendil-works/pi-tui";
import {
	getPrimaryScrollView,
	jumpToAdjacentEntry,
	scrollReadingArea,
	scrollToEdge,
	type EntryScope,
} from "./scroll";

/**
 * Wire names intentionally keep the `px:status-bar:*` prefix: the extension was
 * renamed to `neo-bar`, but its event contract is unchanged.
 */
const INPUT_MODE_SET_EVENT = "px:status-bar:input-mode:set";
const INPUT_MODE_CLEAR_EVENT = "px:status-bar:input-mode:clear";
/** pi-ui lock mode owns the keyboard while active; vim-mode must stay out of it. */
const LOCK_STATE_EVENT = "px:pi-ui:lock-state";

/** `setWidget`'s factory hands us the live TUI; this key only exists for that. */
const TUI_CAPTURE_WIDGET_KEY = "px:vim-mode-tui-capture";
const TUI_REFERENCE_KEY = "__pi_vim_mode_tui_v1";

/** `a` appends at the end; this is pi's `tui.editor.cursorLineEnd` (Ctrl+E). */
const END_OF_LINE = "\x05";

/** Digits that start a motion count (`3j`, `10k`). `0` is handled separately. */
const COUNT_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

type InputMode = "normal" | "insert";

interface VimTui {
	addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	requestRender(): void;
	hasOverlay?(): boolean;
	/** Present on the fullscreen alt-screen TUI; preferred over tree walking. */
	getPrimaryScrollView?(): unknown;
	terminal?: { columns?: number };
}

/** A parsed key id carries an explicit modifier only when one is held. */
function hasModifier(data: string): boolean {
	const id = parseKey(data) ?? "";
	return id.includes("ctrl+") || id.includes("alt+") || id.includes("super+");
}

export default function vimModeExtension(pi: ExtensionAPI): void {
	/** User toggle from `/px:vim`; session-scoped. */
	let enabled = true;
	/** True only in fullscreen: normal-mode scrolling needs the alt-screen viewport. */
	let viewport = false;
	let mode: InputMode = "insert";
	let uiPromptOpen = false;
	let lockActive = false;
	let warnedRegular = false;
	let warnedNoScroll = false;
	let warnedNoEntries = false;
	/** Phase 4 pending state: accumulated digit count and the first `g` of `gg`. */
	let pendingCount = "";
	let pendingG = false;
	let tui: VimTui | undefined;
	let removeGate: (() => void) | undefined;

	const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	};

	const resetPending = () => {
		pendingCount = "";
		pendingG = false;
	};

	const isLive = () => enabled && viewport;

	/**
	 * Move the transcript by `delta` lines. When fullscreen provided no scroll
	 * view at all, warn once instead of silently swallowing the key.
	 */
	const scrollReading = (ctx: ExtensionContext, delta: number): boolean => {
		if (!tui || !getPrimaryScrollView(tui)) {
			if (!warnedNoScroll) {
				warnedNoScroll = true;
				notify(ctx, "vim: no transcript view (fullscreen required)", "warning");
			}
			return true;
		}
		scrollReadingArea(tui, delta);
		return true;
	};

	/**
	 * Jump to the next/previous transcript entry and park it at the top of the
	 * viewport. `scope` selects all entries or only user/assistant messages.
	 * Warns once when the scroll view or the entries are unavailable.
	 */
	const jumpEntry = (ctx: ExtensionContext, direction: 1 | -1, scope: EntryScope): boolean => {
		const outcome = jumpToAdjacentEntry(tui, direction, scope);
		if (outcome.status === "unavailable" || outcome.status === "empty") {
			if (!warnedNoEntries) {
				warnedNoEntries = true;
				notify(ctx, "vim: no transcript entries to jump to", "warning");
			}
		}
		return true;
	};

	/** Jump to the very top/bottom of the transcript. Warns once without a view. */
	const scrollEdge = (ctx: ExtensionContext, edge: "top" | "bottom"): boolean => {
		if (!tui || !getPrimaryScrollView(tui)) {
			if (!warnedNoScroll) {
				warnedNoScroll = true;
				notify(ctx, "vim: no transcript view (fullscreen required)", "warning");
			}
			return true;
		}
		scrollToEdge(tui, edge);
		return true;
	};

	const publish = () => pi.events.emit(INPUT_MODE_SET_EVENT, { mode });
	const clearPublished = () => pi.events.emit(INPUT_MODE_CLEAR_EVENT, {});

	const setMode = (next: InputMode) => {
		if (mode === next) return;
		mode = next;
		resetPending();
		if (isLive()) publish();
		tui?.requestRender();
	};

	/**
	 * Dialogs, overlays, permission prompts, and lock mode all own the keyboard.
	 * While any of them is active the gate passes everything through untouched,
	 * so hotkeys and approvals always work.
	 */
	const canGate = () => isLive() && !uiPromptOpen && !lockActive && !tui?.hasOverlay?.();

	const gate = (data: string, ctx: ExtensionContext): { consume?: boolean; data?: string } | undefined => {
		if (!canGate()) {
			resetPending();
			return undefined;
		}

		if (mode === "insert") {
			// Esc leaves insert first; a second Esc (in normal) aborts.
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+;")) {
				setMode("normal");
				return { consume: true };
			}
			return undefined;
		}

		if (matchesKey(data, "i")) {
			setMode("insert");
			return { consume: true };
		}
		if (matchesKey(data, "a")) {
			setMode("insert");
			return { data: END_OF_LINE };
		}
		// Esc reaches pi (abort); modifier chords reach pi (hotkeys, dialogs).
		if (matchesKey(data, "escape") || hasModifier(data)) {
			resetPending();
			return undefined;
		}

		// Phase 4: `gg`/`G` (and `0`/`$`) plus numeric counts (`3j`, `5k`). A lone
		// `g` waits for its second half; any other key cancels it. A leading `0`
		// is the top motion, but `0` after a digit is part of the count (`10j`).
		if (matchesKey(data, "g")) {
			if (pendingG) {
				resetPending();
				return { consume: scrollEdge(ctx, "top") };
			}
			pendingG = true;
			return { consume: true };
		}
		if (pendingG) pendingG = false;

		const digit = COUNT_DIGITS.find((value) => matchesKey(data, value));
		if (digit) {
			pendingCount += digit;
			return { consume: true };
		}
		if (matchesKey(data, "0")) {
			if (pendingCount === "") return { consume: scrollEdge(ctx, "top") };
			pendingCount += "0";
			return { consume: true };
		}
		const count = pendingCount === "" ? 1 : Number.parseInt(pendingCount, 10) || 1;

		if (matchesKey(data, "shift+g") || data === "G" || matchesKey(data, "$") || matchesKey(data, "shift+4")) {
			resetPending();
			return { consume: scrollEdge(ctx, "bottom") };
		}

		// Transcript scrolling: j/k = 1 line, J/K = 5 lines, scaled by a count.
		// `shift+j` matches legacy uppercase `J` and Kitty CSI-u shift+j; the raw
		// `data === "J"` check covers plain terminals without the shift modifier.
		if (matchesKey(data, "j")) {
			resetPending();
			return { consume: scrollReading(ctx, count) };
		}
		if (matchesKey(data, "shift+j") || data === "J") {
			resetPending();
			return { consume: scrollReading(ctx, 5 * count) };
		}
		if (matchesKey(data, "k")) {
			resetPending();
			return { consume: scrollReading(ctx, -count) };
		}
		if (matchesKey(data, "shift+k") || data === "K") {
			resetPending();
			return { consume: scrollReading(ctx, -5 * count) };
		}

		// Entry jumps: `]`/`[` step over every entry; `}`/`{` (and `l`/`h`) step
		// only between user and assistant messages. Shifted brackets are matched
		// both as the shifted symbol and as `shift+[`/`shift+]` (Kitty CSI-u).
		if (matchesKey(data, "]")) {
			resetPending();
			return { consume: jumpEntry(ctx, 1, "all") };
		}
		if (matchesKey(data, "[")) {
			resetPending();
			return { consume: jumpEntry(ctx, -1, "all") };
		}
		if (matchesKey(data, "}") || matchesKey(data, "shift+]")) {
			resetPending();
			return { consume: jumpEntry(ctx, 1, "messages") };
		}
		if (matchesKey(data, "{") || matchesKey(data, "shift+[")) {
			resetPending();
			return { consume: jumpEntry(ctx, -1, "messages") };
		}
		if (matchesKey(data, "l")) {
			resetPending();
			return { consume: jumpEntry(ctx, 1, "messages") };
		}
		if (matchesKey(data, "h")) {
			resetPending();
			return { consume: jumpEntry(ctx, -1, "messages") };
		}

		// Every other plain key is held back from the draft.
		resetPending();
		return { consume: true };
	};

	const captureTui = (ctx: ExtensionContext): VimTui | undefined => {
		if (ctx.hasUI) {
			ctx.ui.setWidget(TUI_CAPTURE_WIDGET_KEY, (captured) => {
				(globalThis as Record<string, unknown>)[TUI_REFERENCE_KEY] = captured;
				return { render: () => [], invalidate: () => {} };
			});
		}
		return (globalThis as Record<string, unknown>)[TUI_REFERENCE_KEY] as VimTui | undefined;
	};

	const uninstall = () => {
		removeGate?.();
		removeGate = undefined;
	};

	const install = (ctx: ExtensionContext) => {
		resetPending();
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			viewport = false;
			uninstall();
			clearPublished();
			return;
		}

		const captured = captureTui(ctx);
		if (!captured) {
			viewport = false;
			uninstall();
			clearPublished();
			return;
		}
		tui = captured;
		viewport = isViewportTUI(captured as unknown as TUI);

		if (!viewport) {
			uninstall();
			clearPublished();
			if (enabled && !warnedRegular) {
				warnedRegular = true;
				notify(ctx, 'vim: needs fullscreen (settings tuiMode: "fullscreen"); inactive in regular mode', "warning");
			}
			return;
		}

		uninstall();
		if (!enabled) {
			clearPublished();
			return;
		}
		removeGate = captured.addInputListener((data) => gate(data, ctx));
		publish();
	};

	pi.on("session_start", async (_event, ctx) => {
		mode = "insert";
		resetPending();
		uiPromptOpen = false;
		warnedNoScroll = false;
		warnedNoEntries = false;
		install(ctx);
	});

	// Re-attach after a session switch/fork in case the TUI or editor was rebuilt.
	pi.on("session_tree", async (_event, ctx) => {
		install(ctx);
	});

	pi.on("ui_prompt_start", async () => {
		uiPromptOpen = true;
		resetPending();
	});

	pi.on("ui_prompt_end", async () => {
		uiPromptOpen = false;
	});

	pi.events.on(LOCK_STATE_EVENT, (event: { locked?: unknown }) => {
		lockActive = event?.locked === true;
	});

	pi.on("session_shutdown", async () => {
		resetPending();
		uninstall();
		tui = undefined;
		viewport = false;
		clearPublished();
	});

	pi.registerCommand("px:vim", {
		description: "Vim-style modal editor (insert default): on | off | status",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "status") {
				notify(ctx, `vim: ${enabled ? "on" : "off"}, ${viewport ? "fullscreen" : "regular"}, ${mode} mode`);
				return;
			}
			if (arg && arg !== "on" && arg !== "off") {
				notify(ctx, "vim: usage: /px:vim on | off | status", "warning");
				return;
			}
			enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
			install(ctx);
			notify(ctx, `vim: ${enabled ? "on" : "off"} (this session only)`);
		},
	});
}
