import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { FocusModeConfigDialog, type LiveMode } from "./config";
import { USAGE, focusModeCompletions, parseFocusModeCommand } from "./command";
import { loadGlobalState, saveGlobalState, type FocusModeStateV1 } from "./state";
import { FocusModeViewport } from "./viewport";

/** Toggle focus mode from another extension (e.g. the pi-ui quick actions dialog). */
export const FOCUS_MODE_TOGGLE_EVENT = "px:focus-mode:toggle";
/** Broadcast the current focus-mode state so the quick actions dialog can show it. */
export const FOCUS_MODE_STATE_EVENT = "px:focus-mode:state";

function isInteractiveTerminal(): boolean {
	const stdout = process.stdout as { isTTY?: boolean };
	const stdin = process.stdin as { isTTY?: boolean };
	return stdout.isTTY === true && stdin.isTTY === true;
}

/** The factory has no context; exclude protocol/one-shot CLI launches before the first frame. */
function allowsEarlyTerminalSetup(): boolean {
	// Unknown embedded hosts must wait for an authoritative session context.
	const entry = basename(process.argv[1] ?? "");
	if (entry !== "pi" && entry !== "pi.exe" && !/^(pi|cli)\.[cm]?[jt]s$/.test(entry)) return false;
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (arg === "-p" || arg === "--print") return false;
		if (arg === "--mode" && args[++i] !== "text") return false;
		if (arg.startsWith("--mode=") && arg !== "--mode=text") return false;
	}
	return isInteractiveTerminal();
}

// Installed Pi exposes mode; older repository declarations do not yet include it.
function isTuiTerminal(ctx: ExtensionContext): boolean {
	return ctx.hasUI === true && (ctx as ExtensionContext & { mode?: string }).mode === "tui" && isInteractiveTerminal();
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

/**
 * Keeps pi inside a reading column on wide monitors.
 *
 * See README.md for the mechanism and the caveats.
 */
export default function focusModeExtension(pi: ExtensionAPI): void {
	const viewport = new FocusModeViewport();
	const { state: persisted, error: loadError } = loadGlobalState();
	let current: FocusModeStateV1 = persisted;
	let reportedLoadError = false;

	const publishState = (): void => {
		pi.events.emit(FOCUS_MODE_STATE_EVENT, { enabled: current.enabled, width: current.width, bias: current.bias });
	};

	/** Push a configuration into the terminal, and persist it unless it is session only. */
	const applyState = (ctx: ExtensionContext, next: FocusModeStateV1, persist = true): { message: string; type: "info" | "warning" } => {
		current = next;
		publishState();
		const saved = persist ? saveGlobalState(next) : { ok: true as const };

		if (!isTuiTerminal(ctx)) {
			// The preference is still recorded, it just has nothing to apply to.
			return { message: "focus: needs an interactive terminal, saved but not applied", type: "warning" };
		}

		viewport.configure({ enabled: next.enabled, target: next.width, bias: next.bias });
		if (!persist) return { message: `${viewport.describe()} (this session only)`, type: "info" };
		return saved.ok
			? { message: viewport.describe(), type: "info" }
			: { message: `${viewport.describe()}\n${saved.error}`, type: "warning" };
	};

	/** `/px:focus config`: the settings dialog, which applies as you edit. */
	const openConfig = async (ctx: ExtensionContext): Promise<void> => {
		if (!isTuiTerminal(ctx)) {
			notify(ctx, "focus: config needs an interactive terminal", "warning");
			return;
		}
		await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
			const dialog = new FocusModeConfigDialog(
				tui,
				theme,
				() => viewport.desiredGeometry().realWidth,
				{ ...current },
				(next, mode: LiveMode) => {
					// A preview is the dialog moving the column under itself: applied
					// to the terminal, never written, and undone if the dialog closes.
					if (mode === "preview") {
						if (isTuiTerminal(ctx)) viewport.configure({ enabled: next.enabled, target: next.width, bias: next.bias });
						return;
					}
					const { message, type } = applyState(ctx, next, mode === "persist");
					notify(ctx, message, type);
				},
				() => done(null),
			);
			return dialog;
		}, {
			overlay: true,
			overlayOptions: { anchor: "center", width: "100%", minWidth: 40, maxHeight: "90%", margin: 1 },
		});
	};

	// Pi starts rendering before session_start. Preserve the initial TUI column,
	// but never wrap protocol stdio merely because RPC was launched under a PTY.
	if (allowsEarlyTerminalSetup()) {
		viewport.configure({ enabled: current.enabled, target: current.width, bias: current.bias });
	}

	pi.on("session_start", async (_event, ctx) => {
		// Let listeners (the pi-ui quick actions dialog) sync their badge even
		// when this terminal cannot show the reading column.
		publishState();
		if (!isTuiTerminal(ctx)) {
			// Defensive cleanup if a host selected a different mode than its argv.
			viewport.restore();
			return;
		}

		// Idempotent: only repaints when the screen moved since the last apply.
		viewport.configure({ enabled: current.enabled, target: current.width, bias: current.bias });

		if (loadError && !reportedLoadError) {
			reportedLoadError = true;
			if (ctx.hasUI) ctx.ui.notify(loadError, "warning");
		}
	});

	pi.on("session_shutdown", () => viewport.restore());

	const command = {
		description: "Limit pi to a reading column (/px:focus [on [N]|off|set N|bias [N]|status])",
		getArgumentCompletions: (prefix: string) => focusModeCompletions(prefix),
		handler: async (args: string, ctx: ExtensionContext) => {
			const parsed = parseFocusModeCommand(args);
			if ("error" in parsed) {
				notify(ctx, `${parsed.error}\n${USAGE}`, "warning");
				return;
			}

			if (parsed.kind === "config") {
				await openConfig(ctx);
				return;
			}

			if (parsed.kind === "status") {
				notify(
					ctx,
					isTuiTerminal(ctx)
						? viewport.describe()
						: `focus: on=${current.enabled} width=${current.width} bias=${current.bias} (not applied: no interactive terminal)`,
					isTuiTerminal(ctx) ? "info" : "warning",
				);
				return;
			}

			if (parsed.kind === "showBias") {
				const where = current.bias === 0 ? "centered" : current.bias < 0 ? `${-current.bias}% to the left` : `${current.bias}% to the right`;
				notify(ctx, `focus bias: ${current.bias} (${where})`, "info");
				return;
			}

			const next: FocusModeStateV1 =
				parsed.kind === "toggle"
					? { ...current, enabled: !current.enabled }
					: parsed.kind === "enable"
						? {
								...current,
								enabled: true,
								width: parsed.width ?? current.width,
								// An omitted `/bias` half leaves the current bias alone.
								...(parsed.bias === undefined ? {} : { bias: parsed.bias }),
							}
						: parsed.kind === "setBias"
							? { ...current, bias: parsed.bias }
							: { ...current, enabled: false };

			// `-s` applies it for this session and leaves the saved config alone.
			const { message, type } = applyState(ctx, next, parsed.session !== true);
			notify(ctx, message, type);
		},
	};

	pi.registerCommand("px:focus", command);

	// The extension used to be called narrow; keep the old name working so
	// muscle memory does not break. Drop this when it stops being useful.
	pi.registerCommand("px:narrow", { ...command, description: `Deprecated alias for /px:focus (${command.description})` });

	// Quick actions dialog in pi-ui emits this with `{ ctx }`; toggle and persist,
	// exactly like the bare `/px:focus` command.
	pi.events.on(FOCUS_MODE_TOGGLE_EVENT, (payload) => {
		if (!payload || typeof payload !== "object") return;
		const ctx = (payload as { ctx?: ExtensionContext }).ctx;
		if (!ctx) return;
		const { message, type } = applyState(ctx, { ...current, enabled: !current.enabled });
		notify(ctx, message, type);
	});
}
