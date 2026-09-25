import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { USAGE, narrowCompletions, parseNarrowCommand } from "./command";
import { loadGlobalState, saveGlobalState, type NarrowStateV1 } from "./state";
import { NarrowViewport } from "./viewport";

function isInteractiveTerminal(): boolean {
	const stdout = process.stdout as { isTTY?: boolean };
	const stdin = process.stdin as { isTTY?: boolean };
	return stdout.isTTY === true && stdin.isTTY === true;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

/**
 * Keeps pi inside a centered reading column on wide monitors.
 *
 * See README.md for the mechanism and the caveats.
 */
export default function narrowExtension(pi: ExtensionAPI): void {
	const viewport = new NarrowViewport();
	const { state: persisted, error: loadError } = loadGlobalState();
	let current: NarrowStateV1 = persisted;
	let reportedLoadError = false;

	/** Push a configuration into the terminal and persist it. */
	const applyState = (next: NarrowStateV1): { message: string; type: "info" | "warning" } => {
		current = next;
		const saved = saveGlobalState(next);

		if (!isInteractiveTerminal()) {
			// The preference is still recorded, it just has nothing to apply to.
			return { message: "narrow: needs an interactive terminal, saved but not applied", type: "warning" };
		}

		viewport.configure({ enabled: next.enabled, target: next.width, bias: next.bias });
		return saved.ok
			? { message: viewport.describe(), type: "info" }
			: { message: `${viewport.describe()}\n${saved.error}`, type: "warning" };
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

	pi.registerCommand("px:narrow", {
		description: "Limit pi to a reading column (/px:narrow [on [N]|off|set N|bias [N]|status])",
		getArgumentCompletions: (prefix: string) => narrowCompletions(prefix),
		handler: async (args, ctx) => {
			const parsed = parseNarrowCommand(args);
			if ("error" in parsed) {
				notify(ctx, `${parsed.error}\n${USAGE}`, "warning");
				return;
			}

			if (parsed.kind === "status") {
				notify(
					ctx,
					isInteractiveTerminal()
						? viewport.describe()
						: `narrow: on=${current.enabled} width=${current.width} bias=${current.bias} (not applied: no interactive terminal)`,
					isInteractiveTerminal() ? "info" : "warning",
				);
				return;
			}

			if (parsed.kind === "showBias") {
				const where = current.bias === 0 ? "centered" : current.bias < 0 ? `${-current.bias}% to the left` : `${current.bias}% to the right`;
				notify(ctx, `narrow bias: ${current.bias} (${where})`, "info");
				return;
			}

			const next: NarrowStateV1 =
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
	});
}
