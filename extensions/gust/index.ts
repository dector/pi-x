import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ThreadsDialog } from "./dialog.ts";
import { gustClient, reloadClient, type ReloadTarget } from "./gust.ts";
import { processHoldSettings, ReloadHold } from "./hold.ts";
import { Orchestrator, type OrchestratorStatus } from "./orchestrator.ts";
import type { ThreadState } from "./types.ts";

/**
 * Gust comment browser and worker orchestrator.
 *
 * `/px:gust` opens a two-pane browser backed by `gust ctl comments`.
 * `/px:gust process` starts a deterministic orchestrator that watches thread
 * changes and runs one `pi` worker per thread, with a persistent session per
 * thread (see ./orchestrator.ts and ./worker.ts). `/px:gust process stop`
 * stops it. The client auto-detects `gust` on PATH or `go tool gust`, and
 * finds the socket from the current directory (override with GUST_SOCKET).
 */

const STATE_GLYPH: Record<ThreadState, string> = {
	created: "✎",
	submitted: "○",
	seen: "◐",
	review: "●",
	done: "✓",
};

let orchestrator: Orchestrator | null = null;
let activeCtx: ExtensionCommandContext | null = null;

function projectRoot(ctx: ExtensionContext): string {
	return process.env.GUST_CWD?.trim() || ctx.cwd;
}

function ensureOrchestrator(ctx: ExtensionCommandContext): Orchestrator {
	if (!orchestrator) {
		orchestrator = new Orchestrator(projectRoot(ctx), gustClient);
		orchestrator.subscribe(renderStatus);
	}
	return orchestrator;
}

function widgetLines(status: OrchestratorStatus): string[] {
	const lines = [`Gust orchestrator — ${status.phase}${status.running ? "" : " (stopped)"}`];
	if (status.lastError) lines.push(`  ⚠ ${status.lastError}`);
	for (const thread of status.threads.slice(0, 8)) {
		const note = thread.note ? ` — ${thread.note}` : "";
		lines.push(`  ${STATE_GLYPH[thread.state]} ${thread.id.slice(0, 8)} ${thread.state.padEnd(9)} ${thread.path}${note}`);
	}
	if (status.threads.length > 8) lines.push(`  … ${status.threads.length - 8} more`);
	if (status.resolved > 0) lines.push(`  ✓ ${status.resolved} resolved`);
	return lines;
}

function renderStatus(): void {
	const ctx = activeCtx;
	if (!ctx) return;
	try {
		const status = orchestrator?.status();
		if (!status || (!status.running && !status.started)) {
			ctx.ui.setStatus("gust", undefined);
			ctx.ui.setWidget("gust", undefined);
			return;
		}
		const parts = [status.running ? status.phase : "stopped"];
		if (status.active) parts.push(`▶ ${status.active.slice(0, 8)}`);
		parts.push(`${status.processed} done`);
		if (status.failed) parts.push(`${status.failed} failed`);
		ctx.ui.setStatus("gust", `gust: ${parts.join(" · ")}`);
		ctx.ui.setWidget("gust", widgetLines(status));
	} catch {
		// The session may be gone; ignore late UI updates.
	}
}

async function openThreads(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("gust: the thread browser requires an interactive session", "warning");
		return;
	}
	const worker = ensureOrchestrator(ctx);
	await ctx.ui.custom<null>((tui, theme, _keybindings, done) =>
		new ThreadsDialog(tui, theme, gustClient, () => done(null), worker),
	);
}

async function startProcess(ctx: ExtensionCommandContext): Promise<void> {
	const worker = ensureOrchestrator(ctx);
	if (worker.isRunning()) {
		ctx.ui.notify("gust: orchestrator is already running", "info");
		return;
	}
	worker.start();
	ctx.ui.notify("gust: orchestrator started — watching for threads", "info");
}

async function stopProcess(ctx: ExtensionCommandContext): Promise<void> {
	if (!orchestrator?.isRunning()) {
		orchestrator = null;
		renderStatus();
		ctx.ui.notify("gust: orchestrator is not running", "info");
		return;
	}
	await orchestrator.stop();
	ctx.ui.notify("gust: orchestrator stopped", "info");
}

function showStatus(ctx: ExtensionCommandContext): void {
	const status = orchestrator?.status();
	if (!status) {
		ctx.ui.notify("gust: orchestrator has not been started", "info");
		return;
	}
	const counts = status.threads.map((t) => `${t.id.slice(0, 8)}:${t.state}`).join(" ");
	ctx.ui.notify(
		`gust: ${status.running ? status.phase : "stopped"} · ${status.processed} done · ${status.failed} failed${counts ? ` · ${counts}` : ""}`,
		"info",
	);
}

export default function gustExtension(pi: ExtensionAPI): void {
	const hold = new ReloadHold(reloadClient, processHoldSettings());
	const target = (ctx: ExtensionContext): ReloadTarget => ({
		cwd: projectRoot(ctx),
		socket: process.env.GUST_SOCKET?.trim() || undefined,
	});
	const renderHold = (ctx: ExtensionContext) => {
		try {
			ctx.ui.setStatus("gust-hold", hold.settings.enabled ? "gust: hold" : undefined);
		} catch { /* Context may have been replaced. */ }
	};
	const holdAction = async (ctx: ExtensionContext, work: () => Promise<unknown>) => {
		try {
			await work();
		} catch (error) {
			try {
				ctx.ui.notify(`gust hold: ${error instanceof Error ? error.message : String(error)}`, "warning");
			} catch { /* Context may have been replaced. */ }
		} finally {
			renderHold(ctx);
		}
	};
	const toggleHold = async (ctx: ExtensionCommandContext) => {
		await holdAction(ctx, async () => {
			const enabled = await hold.toggle(target(ctx), !ctx.isIdle());
			ctx.ui.notify(`gust: automatic reload hold ${enabled ? "enabled" : "disabled"}`, "info");
		});
	};

	pi.registerCommand("gust", {
		description: "`hold` toggles automatic reload pausing while the agent works",
		getArgumentCompletions: (prefix) =>
			["hold"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (args.trim() === "hold") await toggleHold(ctx);
			else ctx.ui.notify("Usage: /gust hold (toggle automatic reload hold)", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await holdAction(ctx, async () => {
			await hold.settle(); // Retry any release whose reply was lost during replacement.
			if (!ctx.isIdle()) await hold.start(target(ctx));
		});
	});
	// before_agent_start is awaited before the loop starts. agent_start also
	// covers automatic continuations; duplicate starts are idempotent.
	pi.on("before_agent_start", async (_event, ctx) => {
		await holdAction(ctx, () => hold.start(target(ctx)));
	});
	pi.on("agent_start", async (_event, ctx) => {
		await holdAction(ctx, () => hold.start(target(ctx)));
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.isIdle()) return; // A new run may already have started.
		await holdAction(ctx, () => hold.settle(() => ctx.isIdle()));
	});

	pi.registerCommand("px:gust", {
		description: "Browse Gust threads, `process` workers, or `hold` automatic reloads during agent work",
		getArgumentCompletions: (prefix) =>
			["process", "process stop", "status", "hold"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const command = args.trim();
			switch (command) {
				case "":
					renderStatus();
					await openThreads(ctx);
					return;
				case "process":
					await startProcess(ctx);
					return;
				case "process stop":
				case "stop":
					await stopProcess(ctx);
					return;
				case "hold":
					await toggleHold(ctx);
					return;
				case "status":
					showStatus(ctx);
					return;
				default:
					ctx.ui.notify(`gust: unknown argument ${JSON.stringify(command)}`, "warning");
					return;
			}
		},
	});

	pi.on("session_shutdown", async (event, ctx) => {
		await holdAction(ctx, () => hold.shutdown(event.reason === "quit"));
		await orchestrator?.stop().catch(() => {});
		orchestrator = null;
		activeCtx = null;
	});
}
