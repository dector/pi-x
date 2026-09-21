import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	HERDR_BLOCKED_EVENT,
	HUB_CHANNELS,
	HUB_USER_WAIT_CHANNELS,
	type CapRequest,
	type CapResult,
	type HubAskPayload,
	type HubRegisterPayload,
	type HubReplyPayload,
	type HubUnregisterPayload,
	type PermissionAction,
} from "./contract";
import { HerdrTabStatus, detectHerdrTabEnv, type HerdrTabStyle } from "./herdr-tab";
import {
	UserWaitRegistry,
	parseUserWaitClear,
	parseUserWaitSet,
	type UserWaitSnapshot,
	type UserWaitTransition,
} from "./user-wait";

/**
 * hub: central signal hub for pi-x extensions.
 *
 * Keeps a registry of capability providers, routes `hub:ask` requests to the
 * providers that declared the requested capability, collects their `hub:reply`
 * responses, arbitrates, and emits a single `hub:answer`. Hub is permissive:
 * malformed payloads are dropped, but nothing is authorized here.
 */

const ACTION_RANK: Record<PermissionAction, number> = { allow: 0, confirm: 1, block: 2 };
const PENDING_TTL_MS = 30 * 60_000;
const WAIT_ID_DISPLAY_LENGTH = 8;

/** Shorten a wait id for display only; the full id is never prompt content. */
function shortWaitId(id: string): string {
	return id.length > WAIT_ID_DISPLAY_LENGTH ? id.slice(0, WAIT_ID_DISPLAY_LENGTH) : id;
}

// `/px:hub` renders owner-supplied text (owner, id, label, provider ids). Strip
// ANSI escapes and control characters so a malicious value cannot forge extra
// lines, repaint the terminal, or move the cursor.
const ANSI_ESCAPE_PATTERN = /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

/** Collapse a display field to one clean line; `""` when nothing remains. */
function sanitizeDisplayText(value: string): string {
	return value
		.replace(ANSI_ESCAPE_PATTERN, " ")
		.replace(CONTROL_CHARACTER_PATTERN, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Detached copy for `changed` observers, so they cannot mutate adapter state. */
function copyWaitSnapshot(snapshot: UserWaitSnapshot): UserWaitSnapshot {
	return { active: snapshot.active, count: snapshot.count, waits: snapshot.waits.map((wait) => ({ ...wait })) };
}

type PendingRequest = {
	cap: CapRequest[];
	pendingTargets: Set<string>;
	resultsByWhat: Map<string, CapResult[]>;
	settled: boolean;
	timer: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseRegister(payload: unknown): HubRegisterPayload | undefined {
	if (!isRecord(payload)) return undefined;
	if (typeof payload.id !== "string" || payload.id.length === 0) return undefined;
	if (!isRecord(payload.caps) || !isStringArray(payload.caps.provide)) return undefined;
	return { id: payload.id, caps: { provide: payload.caps.provide } };
}

function parseUnregister(payload: unknown): HubUnregisterPayload | undefined {
	if (!isRecord(payload) || typeof payload.id !== "string") return undefined;
	return { id: payload.id };
}

function parseCapRequests(value: unknown): CapRequest[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const requests: CapRequest[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.what !== "string") return undefined;
		requests.push({ what: item.what, data: isRecord(item.data) ? item.data : {} });
	}
	return requests;
}

function parseAsk(payload: unknown): HubAskPayload | undefined {
	if (!isRecord(payload) || typeof payload.id !== "string") return undefined;
	const cap = parseCapRequests(payload.cap);
	if (!cap) return undefined;
	return {
		id: payload.id,
		from: typeof payload.from === "string" ? payload.from : undefined,
		ctx: payload.ctx,
		cap,
	};
}

/**
 * `ctx.mode` exists at runtime but is missing from the pinned 0.75.4
 * `ExtensionContext` type. Read it defensively so the TUI-only gate still
 * typechecks and non-TUI sessions (RPC/print/JSON) never touch the socket.
 */
function isTuiContext(ctx: ExtensionContext): boolean {
	return (ctx as ExtensionContext & { mode?: string }).mode === "tui";
}

function parseHerdrTabStyle(value: string | undefined): HerdrTabStyle {
	return value === "dots" ? "dots" : "symbols";
}

/**
 * Build the Herdr tab helper once at load, or `undefined` when disabled or not
 * inside a Herdr-managed pane. Construction does no I/O; `start()` does.
 */
function createHerdrTabStatus(): HerdrTabStatus | undefined {
	if (process.env.PI_HUB_HERDR_TAB === "0") return undefined;
	const env = detectHerdrTabEnv();
	if (!env) return undefined;
	return new HerdrTabStatus({ env, style: parseHerdrTabStyle(process.env.PI_HUB_HERDR_TAB_STYLE) });
}

function parseReply(payload: unknown): HubReplyPayload | undefined {
	if (!isRecord(payload) || typeof payload.id !== "string" || !Array.isArray(payload.results)) return undefined;

	const results: CapResult[] = [];
	for (const item of payload.results) {
		if (!isRecord(item) || typeof item.what !== "string") continue;
		const action = item.action;
		if (action !== "allow" && action !== "confirm" && action !== "block") continue;
		results.push({
			what: item.what,
			action,
			reason: typeof item.reason === "string" ? item.reason : undefined,
			summary: typeof item.summary === "string" ? item.summary : undefined,
		});
	}

	return {
		id: payload.id,
		from: typeof payload.from === "string" ? payload.from : undefined,
		results,
	};
}

export default function hubExtension(pi: ExtensionAPI): void {
	const providersByCap = new Map<string, Set<string>>();
	const capsByProvider = new Map<string, Set<string>>();
	const pending = new Map<string, PendingRequest>();
	const userWaits = new UserWaitRegistry();

	// Herdr keeps its own blocked counter, so only the aggregate zero/non-zero
	// crossing may emit a Herdr boolean. A metadata update while N > 1, or a
	// second concurrent wait, must not emit another `{ active: true }`.
	const emitHerdrWaitTransition = (transition: UserWaitTransition): void => {
		if (transition.activated) {
			pi.events.emit(HERDR_BLOCKED_EVENT, { active: true, label: transition.snapshot.waits[0]?.label });
		} else if (transition.deactivated) {
			pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
		}
	};

	const applyUserWaitTransition = (transition: UserWaitTransition): void => {
		// Observers get a detached copy: a `changed` listener must not be able to
		// mutate the snapshot the Herdr adapter reads its activation label from.
		if (transition.changed) pi.events.emit(HUB_USER_WAIT_CHANNELS.changed, copyWaitSnapshot(transition.snapshot));
		emitHerdrWaitTransition(transition);
	};

	// Herdr tab status: built once at load, started per session. Outside Herdr,
	// with PI_HUB_HERDR_TAB=0, or outside a TUI session this stays inactive.
	// Startup is non-blocking; shutdown awaits the bounded label restore.
	const herdrTab = createHerdrTabStatus();

	const removeProvider = (id: string): void => {
		const caps = capsByProvider.get(id);
		if (!caps) return;

		for (const cap of caps) {
			const ids = providersByCap.get(cap);
			ids?.delete(id);
			if (ids && ids.size === 0) providersByCap.delete(cap);
		}
		capsByProvider.delete(id);
	};

	const register = (payload: HubRegisterPayload): void => {
		removeProvider(payload.id);

		const caps = new Set(payload.caps.provide);
		capsByProvider.set(payload.id, caps);
		for (const cap of caps) {
			const ids = providersByCap.get(cap) ?? new Set<string>();
			ids.add(payload.id);
			providersByCap.set(cap, ids);
		}
	};

	// Most-restrictive wins per capability: block > confirm > allow.
	// A capability nobody answered becomes `block`.
	const finalize = (id: string): void => {
		const request = pending.get(id);
		if (!request || request.settled) return;
		request.settled = true;
		clearTimeout(request.timer);
		pending.delete(id);

		const results: CapResult[] = request.cap.map((entry) => {
			const candidates = request.resultsByWhat.get(entry.what) ?? [];
			if (candidates.length === 0) {
				return { what: entry.what, action: "block", reason: "no provider answered" };
			}

			let winner = candidates[0] as CapResult;
			for (const candidate of candidates) {
				if (ACTION_RANK[candidate.action] > ACTION_RANK[winner.action]) winner = candidate;
			}
			return winner;
		});

		pi.events.emit(HUB_CHANNELS.answer, { id, results });
	};

	pi.events.on(HUB_CHANNELS.register, (payload) => {
		const parsed = parseRegister(payload);
		if (parsed) register(parsed);
	});

	pi.events.on(HUB_CHANNELS.unregister, (payload) => {
		const parsed = parseUnregister(payload);
		if (parsed) removeProvider(parsed.id);
	});

	pi.events.on(HUB_CHANNELS.ask, (payload) => {
		const ask = parseAsk(payload);
		if (!ask) return;

		const targets = new Set<string>();
		for (const request of ask.cap) {
			for (const id of providersByCap.get(request.what) ?? []) targets.add(id);
		}

		if (targets.size === 0) {
			// No provider: answer explicitly instead of letting the requester time out.
			pi.events.emit(HUB_CHANNELS.answer, {
				id: ask.id,
				results: ask.cap.map((entry) => ({ what: entry.what, action: "block", reason: "no hub provider" })),
			});
			return;
		}

		pending.set(ask.id, {
			cap: ask.cap,
			pendingTargets: targets,
			resultsByWhat: new Map(),
			settled: false,
			timer: setTimeout(() => finalize(ask.id), PENDING_TTL_MS),
		});

		pi.events.emit(HUB_CHANNELS.request, {
			id: ask.id,
			from: ask.from,
			ctx: ask.ctx,
			cap: ask.cap,
			targets: [...targets],
		});
	});

	// Explicit user waits: the UI owner declares set/clear. Hub only stores and
	// aggregates; it never infers a wait from a pending `hub:ask`.
	pi.events.on(HUB_USER_WAIT_CHANNELS.set, (payload) => {
		const parsed = parseUserWaitSet(payload);
		if (!parsed) return;
		const transition = userWaits.set(parsed);
		if (!transition) return;

		// Ack before changed so a synchronous client can confirm support.
		pi.events.emit(HUB_USER_WAIT_CHANNELS.ack, { id: parsed.id, owner: parsed.owner, operation: "set" });
		applyUserWaitTransition(transition);
	});

	pi.events.on(HUB_USER_WAIT_CHANNELS.clear, (payload) => {
		const parsed = parseUserWaitClear(payload);
		if (!parsed) return;
		const transition = userWaits.clear(parsed);
		if (!transition) return;

		pi.events.emit(HUB_USER_WAIT_CHANNELS.ack, { id: parsed.id, owner: parsed.owner, operation: "clear" });
		applyUserWaitTransition(transition);
	});

	pi.events.on(HUB_CHANNELS.reply, (payload) => {
		const reply = parseReply(payload);
		if (!reply) return;

		const request = pending.get(reply.id);
		if (!request || request.settled) return;

		// Only targeted providers contribute to arbitration. Other extensions
		// may blanket-reply `hub:request`, and an anonymous reply cannot be
		// attributed to a target.
		if (!reply.from || !request.pendingTargets.has(reply.from)) return;

		for (const result of reply.results) {
			const list = request.resultsByWhat.get(result.what) ?? [];
			list.push(result);
			request.resultsByWhat.set(result.what, list);
		}

		if (reply.from) request.pendingTargets.delete(reply.from);

		// Wait for every targeted provider before finalizing so multi-provider
		// arbitration sees every verdict (`block > confirm > allow`). A provider
		// that never replies is bounded by the pending TTL. Providers answer
		// even when a request is irrelevant to them, so this does not hang for
		// the registered built-ins.
		if (request.pendingTargets.size === 0) finalize(reply.id);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!herdrTab || !isTuiContext(ctx)) return;
		void herdrTab.start().catch(() => undefined);
	});

	pi.on("session_shutdown", async () => {
		// Drop every registered wait and release Herdr if one was still open, so a
		// shut-down session cannot leave the pane stuck as blocked.
		applyUserWaitTransition(userWaits.reset());

		if (!herdrTab) return;
		// `stop()` is internally bounded by its restore timeout; awaiting it keeps
		// the shutdown handler from resolving before the label is restored.
		await herdrTab.stop().catch(() => undefined);
	});

	pi.registerCommand("px:hub", {
		description: "Show hub providers and pending permission requests",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const providerLines = [...capsByProvider.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(
					([id, caps]) =>
						`- ${sanitizeDisplayText(id)}: ${[...caps].sort().map((cap) => sanitizeDisplayText(cap)).join(", ") || "(none)"}`,
				);

			const pendingLines = [...pending.entries()].map(
				([id, request]) =>
					`- ${sanitizeDisplayText(id)}: ${request.cap.map((entry) => sanitizeDisplayText(entry.what)).join(", ")}`,
			);

			// User waits are display text only: id is shortened, label is whatever the
			// UI owner chose to declare. Full prompt content never reaches hub, and
			// every rendered field is sanitized so it cannot forge extra lines.
			const waitSnapshot = userWaits.snapshot();
			const waitLines = waitSnapshot.waits.map((wait) => {
				const owner = sanitizeDisplayText(wait.owner) || "(unknown)";
				const id = sanitizeDisplayText(wait.id);
				const label = wait.label === undefined ? "" : sanitizeDisplayText(wait.label);
				return `- ${owner}/${shortWaitId(id) || "(unknown)"}: ${label || "(no label)"}`;
			});

			const lines = [
				`hub providers: ${capsByProvider.size}`,
				...(providerLines.length > 0 ? providerLines : ["- (none)"]),
				`pending asks: ${pending.size}`,
				...pendingLines,
				`active user waits: ${waitSnapshot.count}`,
				...waitLines,
				`herdr tab: ${herdrTab?.describe() ?? "off"}`,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
