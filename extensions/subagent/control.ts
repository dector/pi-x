import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { querySafeModeSnapshot, SAFE_MODES, type SafeMode, type SafeModeSnapshot } from "./safe-mode.ts";

const STATE_SET_EVENT = "px:safe-mode:state:set";
const STATE_CHANGED_EVENT = "px:safe-mode:state:changed";
const CONTROL_STATUS_KEY = "px:subagent-control";

export type PauseState = "running" | "pause-requested" | "paused";

export class PauseGate {
	private current: PauseState = "running";
	private waiters: Array<() => void> = [];
	private report: (state: PauseState) => void;

	constructor(report: (state: PauseState) => void = () => {}) {
		this.report = report;
	}

	get state(): PauseState {
		return this.current;
	}

	requestPause(): void {
		if (this.current !== "running") return;
		this.current = "pause-requested";
		this.report(this.current);
	}

	async waitAtBoundary(): Promise<void> {
		if (this.current === "running") return;
		if (this.current === "pause-requested") {
			this.current = "paused";
			this.report(this.current);
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	resume(): void {
		if (this.current === "running") return;
		this.current = "running";
		for (const resolve of this.waiters.splice(0)) resolve();
		this.report(this.current);
	}

	abort(): void {
		this.resume();
	}
}

function report(ctx: ExtensionContext, payload: Record<string, unknown>): void {
	ctx.ui.setStatus(CONTROL_STATUS_KEY, JSON.stringify(payload));
}

async function setSafeMode(
	pi: ExtensionAPI,
	state: SafeModeSnapshot,
	timeoutMs = 1000,
): Promise<SafeModeSnapshot | undefined> {
	const source = `subagent-child-control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const finish = (value: SafeModeSnapshot | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off();
			resolve(value);
		};
		const off = pi.events.on(STATE_CHANGED_EVENT, (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			const changed = payload as { mode?: unknown; outerAccess?: unknown; source?: unknown };
			if (changed.source !== source || !SAFE_MODES.includes(changed.mode as SafeMode) || typeof changed.outerAccess !== "boolean") return;
			finish({ mode: changed.mode as SafeMode, outerAccess: changed.outerAccess });
		});
		timer = setTimeout(() => finish(undefined), timeoutMs);
		pi.events.emit(STATE_SET_EVENT, { state, source });
	});
}

export function registerChildControls(pi: ExtensionAPI): PauseGate | undefined {
	if (process.env.PI_SUBAGENT_CHILD !== "1") return undefined;
	let statusContext: ExtensionContext | undefined;
	const gate = new PauseGate((state) => {
		if (statusContext) report(statusContext, { kind: "pause", state });
	});

	pi.registerCommand("px:subagent-control", {
		description: "Internal control channel for a parent subagent runner",
		handler: async (args, ctx) => {
			statusContext = ctx;
			const parts = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
			const action = parts[0];
			if (action === "pause") {
				gate.requestPause();
				report(ctx, { kind: "pause", state: gate.state });
				return;
			}
			if (action === "resume") {
				gate.resume();
				report(ctx, { kind: "pause", state: gate.state });
				return;
			}
			if (action === "state") {
				const state = await querySafeModeSnapshot(pi.events, { timeoutMs: 500 });
				report(ctx, state ? { kind: "state", state, pause: gate.state } : { kind: "error", error: "safe-mode unavailable" });
				return;
			}
			if (action === "mode") {
				const mode = parts[1] as SafeMode | undefined;
				const outer = parts[2] === "outer-on" ? true : parts[2] === "outer-off" ? false : undefined;
				if (!mode || !SAFE_MODES.includes(mode) || outer === undefined) {
					report(ctx, { kind: "error", error: "usage: mode <paranoid|reader|smart|yolo> <outer-on|outer-off>" });
					return;
				}
				const state = await setSafeMode(pi, { mode, outerAccess: outer });
				report(ctx, state ? { kind: "state", state } : { kind: "error", error: "safe-mode unavailable or timed out" });
				return;
			}
			report(ctx, { kind: "error", error: "unknown control command" });
		},
	});

	pi.on("turn_start", async () => gate.waitAtBoundary());
	pi.on("tool_call", async () => gate.waitAtBoundary());
	pi.on("session_shutdown", async () => gate.abort());
	return gate;
}
