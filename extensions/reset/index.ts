import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseResetArguments } from "./arguments.ts";
import { PROC_STOP_ALL_REPLY_EVENT, PROC_STOP_ALL_REQUEST_EVENT, type ProcStopAllResult } from "../proc/stop-all.ts";

const TRANSFERRED_ENTRY_TYPES = new Set(["permissions-core", "review-level"]);

interface CustomEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

export function transferableSettings(branch: unknown): Array<{ type: string; data: unknown }> {
	if (!Array.isArray(branch)) return [];
	const latest = new Map<string, unknown>();
	for (const entry of branch as CustomEntryLike[]) {
		if (entry?.type === "custom" && typeof entry.customType === "string" && TRANSFERRED_ENTRY_TYPES.has(entry.customType)) {
			latest.set(entry.customType, entry.data);
		}
	}
	return [...latest].map(([type, data]) => ({ type, data }));
}

export default function resetExtension(pi: ExtensionAPI): void {
	let unsubscribeHandoff: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		unsubscribeHandoff?.();
		const sessionId = ctx.sessionManager.getSessionId();
		const cwd = ctx.cwd;
		unsubscribeHandoff = pi.events.on("px:reset:handoff:apply", async (payload) => {
			if (!payload || typeof payload !== "object") return;
			const value = payload as { transferId?: unknown; targetSessionId?: unknown; cwd?: unknown; provider?: unknown; modelId?: unknown; thinkingLevel?: unknown };
			if (value.targetSessionId !== sessionId || value.cwd !== cwd || typeof value.transferId !== "string") return;
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
			if (typeof value.thinkingLevel !== "string" || !levels.includes(value.thinkingLevel)) return;
			if (typeof value.provider === "string" && typeof value.modelId === "string") {
				const models = await ctx.modelRegistry.getAvailable();
				const model = models.find((candidate) => candidate.provider === value.provider && candidate.id === value.modelId);
				if (model) await pi.setModel(model);
			}
			pi.setThinkingLevel(value.thinkingLevel as any);
			pi.events.emit("px:reset:settings:ack", { transferId: value.transferId, owner: "model", targetSessionId: sessionId, cwd });
		});
	});
	pi.on("session_shutdown", () => {
		unsubscribeHandoff?.();
		unsubscribeHandoff = undefined;
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
			if (stopProc) {
				const stopped = await stopManagedProcesses(pi, newCtx.sessionManager.getSessionId());
				if (!stopped) newCtx.ui.notify("/reset -proc: process manager did not respond; processes may still be running.", "warning");
				else if (stopped.timedOut.length) newCtx.ui.notify(`/reset -proc: processes did not stop: ${stopped.timedOut.join(", ")}`, "warning");
			}
			// This event is handled by the replacement extension instance, whose
			// setters are bound to the new runtime. Never use this stale API's setters.
			const targetSessionId = newCtx.sessionManager.getSessionId();
			const expected = ["model", ...[...snapshots.keys()].filter((owner) => owner !== "model")];
			const completed = new Set<string>();
			let unsubscribeAck: (() => void) | undefined;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const acknowledged = new Promise<void>((resolve) => {
				unsubscribeAck = pi.events.on("px:reset:settings:ack", (payload) => {
					if (!payload || typeof payload !== "object") return;
					const ack = payload as { transferId?: unknown; owner?: unknown; targetSessionId?: unknown; cwd?: unknown };
					if (ack.transferId !== requestId || ack.targetSessionId !== targetSessionId || ack.cwd !== newCtx.cwd) return;
					if (typeof ack.owner === "string") completed.add(ack.owner);
					if (expected.every((owner) => completed.has(owner))) resolve();
				});
			});
			pi.events.emit("px:reset:handoff:apply", {
				transferId: requestId,
				targetSessionId,
				cwd: newCtx.cwd,
				provider: model?.provider,
				modelId: model?.id,
				thinkingLevel,
			});
			for (const [owner, state] of snapshots) {
				pi.events.emit("px:reset:settings:apply", { transferId: requestId, owner, targetSessionId, cwd: newCtx.cwd, state });
			}
			try {
				const timedOut = new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error("reset handoff acknowledgement timeout")), 5000);
				});
				await Promise.race([acknowledged, timedOut]);
			} finally {
				if (timeout) clearTimeout(timeout);
				unsubscribeAck?.();
			}
		},
	});
	if (result.cancelled && ctx.hasUI) ctx.ui.notify("/reset cancelled.", "info");
}
