import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseResetArguments } from "./arguments.ts";
import { PROC_STOP_ALL_REPLY_EVENT, PROC_STOP_ALL_REQUEST_EVENT, type ProcStopAllResult } from "../proc/stop-all.ts";

interface ResetBridge {
	sessionId: string;
	cwd: string;
	pi: ExtensionAPI;
	applyModel(provider: string | undefined, modelId: string | undefined, thinkingLevel: string): Promise<boolean>;
}

function activeBridge(): ResetBridge | undefined {
	return (globalThis as { __piXResetBridge?: ResetBridge }).__piXResetBridge;
}

export default function resetExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const bridge: ResetBridge = {
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			pi,
			async applyModel(provider, modelId, thinkingLevel) {
				const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
				if (!levels.includes(thinkingLevel)) return false;
				let restoredModel = true;
				if (provider && modelId && (ctx.model?.provider !== provider || ctx.model?.id !== modelId)) {
					const models = await ctx.modelRegistry.getAvailable();
					const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
					restoredModel = !!model && await pi.setModel(model);
				}
				pi.setThinkingLevel(thinkingLevel as ReturnType<typeof pi.getThinkingLevel>);
				return restoredModel;
			},
		};
		(globalThis as { __piXResetBridge?: ResetBridge }).__piXResetBridge = bridge;
	});
	pi.on("session_shutdown", () => {
		if (activeBridge()?.pi === pi) delete (globalThis as { __piXResetBridge?: ResetBridge }).__piXResetBridge;
	});

	pi.registerCommand("reset", {
		description: "Start a fresh session while retaining session settings",
		handler: async (args, ctx) => {
			const parsed = parseResetArguments(args);
			if (!parsed.ok) {
				ctx.ui.notify(parsed.message.trim(), "warning");
				return;
			}
			if (parsed.options.keepAgents) {
				ctx.ui.notify("/reset +agents is not yet available; no session was changed.", "warning");
				return;
			}
			await resetSession(pi, ctx, parsed.options.stopProc);
		},
	});
}

export async function stopManagedProcesses(pi: ExtensionAPI, targetSessionId: string): Promise<ProcStopAllResult | undefined> {
	const id = `reset-proc-${targetSessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result?: ProcStopAllResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off();
			resolve(result);
		};
		const off = pi.events.on(PROC_STOP_ALL_REPLY_EVENT, (payload) => {
			if (!payload || typeof payload !== "object") return;
			const reply = payload as Partial<ProcStopAllResult>;
			if (reply.id !== id || !Array.isArray(reply.stopped) || !Array.isArray(reply.timedOut)) return;
			if (![...reply.stopped, ...reply.timedOut].every((name) => typeof name === "string")) return;
			finish(reply as ProcStopAllResult);
		});
		const timer = setTimeout(() => finish(), 6_000);
		pi.events.emit(PROC_STOP_ALL_REQUEST_EVENT, { id });
	});
}

async function resetSession(pi: ExtensionAPI, ctx: ExtensionCommandContext, stopProc: boolean): Promise<void> {
	const model = ctx.model;
	const thinkingLevel = pi.getThinkingLevel();
	const requestId = `reset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const snapshots = new Map<string, unknown>();
	const onSnapshot = (payload: unknown): void => {
		if (!payload || typeof payload !== "object") return;
		const value = payload as { id?: unknown; owner?: unknown; sourceSessionId?: unknown; cwd?: unknown; state?: unknown };
		if (
			value.id === requestId &&
			typeof value.owner === "string" &&
			value.sourceSessionId === ctx.sessionManager.getSessionId() &&
			value.cwd === ctx.cwd
		) snapshots.set(value.owner, value.state);
	};
	const unsubscribeSnapshot = pi.events.on("px:reset:settings:response", onSnapshot);
	pi.events.emit("px:reset:settings:request", {
		id: requestId,
		sourceSessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
	});
	unsubscribeSnapshot();
	const result = await ctx.newSession({
		withSession: async (newCtx) => {
			// Pi creates a new event bus for every session. The old `pi.events` cannot
			// reach replacement extensions; their fresh reset instance publishes this
			// process-local bridge during session_start.
			const targetSessionId = newCtx.sessionManager.getSessionId();
			const bridge = activeBridge();
			if (!bridge || bridge.sessionId !== targetSessionId || bridge.cwd !== newCtx.cwd) {
				newCtx.ui.notify("/reset: replacement extension is unavailable; settings were not transferred.", "warning");
				return;
			}
			if (stopProc) {
				const stopped = await stopManagedProcesses(bridge.pi, targetSessionId);
				if (!stopped) newCtx.ui.notify("/reset -proc: process manager did not respond; processes may still be running.", "warning");
				else if (stopped.timedOut.length) newCtx.ui.notify(`/reset -proc: processes did not stop: ${stopped.timedOut.join(", ")}`, "warning");
			}
			const expected = [...snapshots.keys()];
			const completed = new Set<string>();
			let unsubscribeAck: (() => void) | undefined;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const acknowledged = new Promise<void>((resolve) => {
				if (expected.length === 0) resolve();
				unsubscribeAck = bridge.pi.events.on("px:reset:settings:ack", (payload) => {
					if (!payload || typeof payload !== "object") return;
					const ack = payload as { transferId?: unknown; owner?: unknown; targetSessionId?: unknown; cwd?: unknown };
					if (ack.transferId !== requestId || ack.targetSessionId !== targetSessionId || ack.cwd !== newCtx.cwd) return;
					if (typeof ack.owner === "string") completed.add(ack.owner);
					if (expected.every((owner) => completed.has(owner))) resolve();
				});
			});
			try {
				if (!(await bridge.applyModel(model?.provider, model?.id, thinkingLevel))) {
					newCtx.ui.notify("/reset: model or thinking level could not be restored.", "warning");
				}
				for (const [owner, state] of snapshots) {
					bridge.pi.events.emit("px:reset:settings:apply", { transferId: requestId, owner, targetSessionId, cwd: newCtx.cwd, state });
				}
				if (expected.length) {
					const timedOut = new Promise<void>((resolve) => {
						timeout = setTimeout(resolve, 5000);
					});
					await Promise.race([acknowledged, timedOut]);
					const missing = expected.filter((owner) => !completed.has(owner));
					if (missing.length) newCtx.ui.notify(`/reset: settings not fully transferred (${missing.join(", ")}).`, "warning");
				}
			} finally {
				if (timeout) clearTimeout(timeout);
				unsubscribeAck?.();
			}
		},
	});
	if (result.cancelled && ctx.hasUI) ctx.ui.notify("/reset cancelled.", "info");
}
