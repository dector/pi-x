import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TERMINAL_BELL = "\u0007";
const BELL_COOLDOWN_MS = 1_000;

export default function attensionCoreExtension(pi: ExtensionAPI): void {
	let lastBellAt = 0;

	const tryRingTerminalBell = (force = false): boolean => {
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

	pi.on("agent_end", async () => {
		tryRingTerminalBell();
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

	pi.registerCommand("attension-core-test", {
		description: "Ring terminal bell now",
		handler: async (_args, ctx) => {
			const didRing = tryRingTerminalBell(true);
			if (ctx.hasUI) {
				ctx.ui.notify(didRing ? "attension-core: bell sent" : "attension-core: failed to write bell", didRing ? "info" : "warning");
			}
		},
	});
}
