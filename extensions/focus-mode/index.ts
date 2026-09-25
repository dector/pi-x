import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FocusModeConfigDialog } from "./config";
import { USAGE, focusModeCompletions, parseFocusModeCommand } from "./command";
import { loadGlobalState, saveGlobalState, type FocusModeStateV1 } from "./state";
import { FocusModeViewport } from "./viewport";

function isInteractiveTerminal(): boolean {
	const stdout = process.stdout as { isTTY?: boolean };
	const stdin = process.stdin as { isTTY?: boolean };
	return stdout.isTTY === true && stdin.isTTY === true;
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

	/** Push a configuration into the terminal, and persist it unless it is session only. */
	const applyState = (next: FocusModeStateV1, persist = true): { message: string; type: "info" | "warning" } => {
		current = next;
		const saved = persist ? saveGlobalState(next) : { ok: true as const };

		if (!isInteractiveTerminal()) {
			// The preference is still recorded, it just has nothing to apply to.
			return { message: "focus: needs an interactive terminal, saved but not applied", type: "warning" };
		}

		viewport.configure({ enabled: next.enabled, target: next.width, bias: next.bias });
		if (!persist) return { message: `${viewport.describe()} (this session only)`, type: "info" };
		return saved.ok
			? { message: viewport.describe(), type: "info" }
			: { message: `${viewport.describe()}\n${saved.error}`, type: "warning" };
	};

	/** `/px:focus config`: the settings dialog, which applies only on demand. */
	const openConfig = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			notify(ctx, "focus: config needs an interactive terminal", "warning");
			return;
		}
		await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
			const dialog = new FocusModeConfigDialog(
				tui,
				theme,
				() => viewport.desiredGeometry().realWidth,
				{ ...current },
				(next, persist) => {
					const { message, type } = applyState(next, persist);
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

	// Applied at load time, before pi renders its first frame.
	if (isInteractiveTerminal()) {
		viewport.configure({ enabled: current.enabled, target: current.width, bias: current.bias });
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!isInteractiveTerminal()) return;

		// Idempotent: only repaints when the screen moved since the last apply.
		viewport.configure({ enabled: current.enabled, target: current.width, bias: current.bias });

		if (loadError && !reportedLoadError) {
			reportedLoadError = true;
			if (ctx.hasUI) ctx.ui.notify(loadError, "warning");
		}
	});

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
					isInteractiveTerminal()
						? viewport.describe()
						: `focus: on=${current.enabled} width=${current.width} bias=${current.bias} (not applied: no interactive terminal)`,
					isInteractiveTerminal() ? "info" : "warning",
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

			const { message, type } = applyState(next);
			notify(ctx, message, type);
		},
	};

	pi.registerCommand("px:focus", command);

	// The extension used to be called narrow; keep the old name working so
	// muscle memory does not break. Drop this when it stops being useful.
	pi.registerCommand("px:narrow", { ...command, description: `Deprecated alias for /px:focus (${command.description})` });
}
