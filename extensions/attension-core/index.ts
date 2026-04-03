import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_BAR_FIRST_LINE_SET_EVENT = "status-bar:first-line:set";
const STATUS_BAR_FIRST_LINE_CLEAR_EVENT = "status-bar:first-line:clear";

const STATUS_BAR_ID = "attension-core";
const FIRST_LINE_PRIORITY = 1000;
const TERMINAL_BELL = "\u0007";
const BELL_COOLDOWN_MS = 2_000;

function renderIndicator(ctx: ExtensionContext): string {
	if (!ctx.hasUI) return "🔔";
	return ctx.ui.theme.fg("warning", "🔔");
}

function tryRingTerminalBell(lastBellAt: number): number {
	const now = Date.now();
	if (now - lastBellAt < BELL_COOLDOWN_MS) return lastBellAt;

	try {
		process.stdout.write(TERMINAL_BELL);
	} catch {
		// ignore I/O issues
	}

	return now;
}

export default function attensionCoreExtension(pi: ExtensionAPI): void {
	let attentionNeeded = false;
	let activeAgentCount = 0;
	let lastBellAt = 0;

	const publish = (ctx: ExtensionContext) => {
		if (attentionNeeded) {
			pi.events.emit(STATUS_BAR_FIRST_LINE_SET_EVENT, {
				id: STATUS_BAR_ID,
				content: renderIndicator(ctx),
				priority: FIRST_LINE_PRIORITY,
			});
			return;
		}
		pi.events.emit(STATUS_BAR_FIRST_LINE_CLEAR_EVENT, { id: STATUS_BAR_ID });
	};

	const setAttention = (next: boolean, ctx: ExtensionContext, ringBell: boolean) => {
		if (attentionNeeded === next) return;
		attentionNeeded = next;
		publish(ctx);
		if (attentionNeeded && ringBell) {
			lastBellAt = tryRingTerminalBell(lastBellAt);
		}
	};

	const bind = (
		eventName:
			| "session_start"
			| "session_switch"
			| "session_tree"
			| "session_fork"
			| "turn_start"
			| "turn_end"
			| "agent_start"
			| "agent_end"
			| "input"
			| "message_start"
			| "message_end",
		handler: (ctx: ExtensionContext) => void,
	) => {
		pi.on(eventName, async (_event, ctx) => {
			handler(ctx);
		});
	};

	bind("session_start", (ctx) => {
		activeAgentCount = 0;
		setAttention(false, ctx, false);
	});

	bind("session_switch", (ctx) => {
		activeAgentCount = 0;
		setAttention(false, ctx, false);
	});

	bind("session_tree", (ctx) => {
		activeAgentCount = 0;
		setAttention(false, ctx, false);
	});

	bind("session_fork", (ctx) => {
		activeAgentCount = 0;
		setAttention(false, ctx, false);
	});

	bind("turn_start", (ctx) => {
		activeAgentCount = 0;
		setAttention(false, ctx, false);
	});

	bind("agent_start", (ctx) => {
		activeAgentCount += 1;
		setAttention(false, ctx, false);
	});

	bind("message_start", (ctx) => {
		setAttention(false, ctx, false);
	});

	bind("agent_end", (ctx) => {
		activeAgentCount = Math.max(0, activeAgentCount - 1);
		if (activeAgentCount === 0) {
			setAttention(true, ctx, true);
		}
	});

	bind("turn_end", (ctx) => {
		if (activeAgentCount === 0) {
			setAttention(true, ctx, true);
		}
	});

	bind("message_end", (ctx) => {
		if (activeAgentCount === 0) {
			setAttention(true, ctx, true);
		}
	});

	bind("input", (ctx) => {
		setAttention(false, ctx, false);
	});

	pi.on("session_shutdown", async () => {
		activeAgentCount = 0;
		attentionNeeded = false;
		pi.events.emit(STATUS_BAR_FIRST_LINE_CLEAR_EVENT, { id: STATUS_BAR_ID });
	});

	pi.registerCommand("attension-core-test", {
		description: "Toggle attension-core indicator and ring terminal bell",
		handler: async (_args, ctx) => {
			setAttention(!attentionNeeded, ctx, true);
			if (ctx.hasUI) {
				ctx.ui.notify(`attension-core: attention ${attentionNeeded ? "enabled" : "cleared"}`, "info");
			}
		},
	});
}
