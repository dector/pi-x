import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isViewportTUI, matchesKey, parseKey, type TUI } from "@earendil-works/pi-tui";

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

type InputMode = "normal" | "insert";

interface VimTui {
	addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	requestRender(): void;
	hasOverlay?(): boolean;
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
	let tui: VimTui | undefined;
	let removeGate: (() => void) | undefined;

	const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	};

	const isLive = () => enabled && viewport;

	const publish = () => pi.events.emit(INPUT_MODE_SET_EVENT, { mode });
	const clearPublished = () => pi.events.emit(INPUT_MODE_CLEAR_EVENT, {});

	const setMode = (next: InputMode) => {
		if (mode === next) return;
		mode = next;
		if (isLive()) publish();
		tui?.requestRender();
	};

	/**
	 * Dialogs, overlays, permission prompts, and lock mode all own the keyboard.
	 * While any of them is active the gate passes everything through untouched,
	 * so hotkeys and approvals always work.
	 */
	const canGate = () => isLive() && !uiPromptOpen && !lockActive && !tui?.hasOverlay?.();

	const gate = (data: string): { consume?: boolean; data?: string } | undefined => {
		if (!canGate()) return undefined;

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
		if (matchesKey(data, "escape") || hasModifier(data)) return undefined;
		// Every other plain key is held back from the draft.
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
		removeGate = captured.addInputListener((data) => gate(data));
		publish();
	};

	pi.on("session_start", async (_event, ctx) => {
		mode = "insert";
		uiPromptOpen = false;
		install(ctx);
	});

	// Re-attach after a session switch/fork in case the TUI or editor was rebuilt.
	pi.on("session_tree", async (_event, ctx) => {
		install(ctx);
	});

	pi.on("ui_prompt_start", async () => {
		uiPromptOpen = true;
	});

	pi.on("ui_prompt_end", async () => {
		uiPromptOpen = false;
	});

	pi.events.on(LOCK_STATE_EVENT, (event: { locked?: unknown }) => {
		lockActive = event?.locked === true;
	});

	pi.on("session_shutdown", async () => {
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
