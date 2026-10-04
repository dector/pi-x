import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TERMINAL_BELL = "\u0007";
const BELL_COOLDOWN_MS = 1_000;

// hasUI includes RPC; older repository declarations do not yet expose mode.
function isTuiTerminal(ctx: ExtensionContext): boolean {
	return ctx.hasUI === true && (ctx as ExtensionContext & { mode?: string }).mode === "tui" && process.stdout.isTTY === true;
}

export default function attensionCoreExtension(pi: ExtensionAPI): void {
	let lastBellAt = 0;

	const tryRingTerminalBell = (ctx: ExtensionContext, force = false): boolean => {
		if (!isTuiTerminal(ctx)) return false;
		const now = Date.now();
		if (!force && now - lastBellAt < BELL_COOLDOWN_MS) return false;

		try {
			process.stdout.write(TERMINAL_BELL);
		} catch {
			return false;
		}

		lastBellAt = now;
		return true;
	};

	pi.on("agent_end", async (_event, ctx) => {
		tryRingTerminalBell(ctx);
	});

	pi.on("session_start", async () => {
		lastBellAt = 0;
	});

	pi.on("session_tree", async () => {
		lastBellAt = 0;
	});

	pi.on("session_shutdown", async () => {
		lastBellAt = 0;
	});

	pi.registerCommand("px:attension-core-test", {
		description: "Ring terminal bell now",
		handler: async (_args, ctx) => {
			if (!isTuiTerminal(ctx)) {
				if (ctx.hasUI) ctx.ui.notify("attension-core: bell needs a TUI terminal (skipped)", "warning");
				return;
			}
			const didRing = tryRingTerminalBell(ctx, true);
			if (ctx.hasUI) {
				ctx.ui.notify(didRing ? "attension-core: bell sent" : "attension-core: failed to write bell", didRing ? "info" : "warning");
			}
		},
	});
}
