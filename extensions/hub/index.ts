import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	HERDR_BLOCKED_EVENT,
	HUB_CHANNELS,
	HUB_PROGRESS_CHANNELS,
	HUB_USER_WAIT_CHANNELS,
	type CapRequest,
	type CapResult,
	type HubAskPayload,
	type HubProgressAckPayload,
	type HubRegisterPayload,
	type HubReplyPayload,
	type HubUnregisterPayload,
	type PermissionAction,
	type ProgressChunkSnapshot,
	type ProgressChunkState,
	type ProgressOperation,
	type ProgressSnapshot,
} from "./contract";
import { HerdrTabStatus, detectHerdrTabEnv, type HerdrTabStyle } from "./herdr-tab";
import {
	MAX_PROGRESS_CHUNKS,
	ProgressRegistry,
	parseProgressCreate,
	parseProgressFinish,
	parseProgressQuery,
	parseProgressRemove,
	parseProgressUpdate,
	type ProgressChunkRecord,
	type ProgressRegistryResult,
	type ProgressTrackerRecord,
} from "./progress";
import { registerProgressTool } from "./progress-tool";
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
/** `/px:progress` never lists more finished trackers than this in the summary. */
const MAX_FINISHED_PROGRESS_DISPLAY = 10;

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

/** Detached copy for progress `changed` observers, matching the wait adapter. */
function copyProgressSnapshot(snapshot: ProgressSnapshot): ProgressSnapshot {
	return {
		active: snapshot.active,
		count: snapshot.count,
		trackers: snapshot.trackers.map((tracker) => ({
			trackerId: tracker.trackerId,
			owner: tracker.owner,
			title: tracker.title,
			unit: tracker.unit,
			updatedAt: tracker.updatedAt,
			chunks: tracker.chunks.map((chunk) => {
				const copy: ProgressChunkSnapshot = { index: chunk.index, state: chunk.state };
				if (chunk.label !== undefined) copy.label = chunk.label;
				if (chunk.path !== undefined) copy.path = chunk.path.map((segment) => ({ ...segment }));
				if (chunk.phase !== undefined) copy.phase = chunk.phase;
				return copy;
			}),
		})),
	};
}

function progressLeaves(record: ProgressTrackerRecord): ProgressChunkRecord[] {
	const parents = new Set(record.chunks.flatMap((chunk) => chunk.parentId ? [chunk.parentId] : []));
	return record.chunks.filter((chunk) => !parents.has(chunk.id));
}

/** Count leaves in one lifecycle state. */
function countProgressChunks(record: ProgressTrackerRecord, state: ProgressChunkState): number {
	return progressLeaves(record).reduce((total, chunk) => (chunk.state === state ? total + 1 : total), 0);
}

/**
 * One-line tracker summary, for example `Authentication [active] — 1/13 done`.
 * The title is producer-supplied display text and is sanitized here.
 */
function formatProgressSummary(record: ProgressTrackerRecord): string {
	const title = sanitizeDisplayText(record.title) || "(untitled)";
	const status = record.outcome ?? "active";
	const total = progressLeaves(record).length;
	const parts = [`${countProgressChunks(record, "done")}/${total} done`];

	const failed = countProgressChunks(record, "failed");
	if (failed > 0) parts.push(`${failed} failed`);
	const skipped = countProgressChunks(record, "skipped");
	if (skipped > 0) parts.push(`${skipped} skipped`);

	return `${title} [${status}] — ${parts.join(", ")}`;
}

/** One node detail line; hierarchical records are indented by depth. */
function formatProgressChunk(chunk: ProgressChunkRecord, record: ProgressTrackerRecord): string {
	const label = sanitizeDisplayText(chunk.label ?? chunk.id) || "(unnamed)";
	const isContainer = record.chunks.some((candidate) => candidate.parentId === chunk.id);
	const state = isContainer
		? "container"
		: chunk.phase !== undefined && chunk.phase.length > 0 ? `${chunk.state}/${chunk.phase}` : chunk.state;
	let depth = 0;
	let parentId = chunk.parentId;
	while (parentId !== undefined) {
		depth += 1;
		parentId = record.chunks.find((candidate) => candidate.id === parentId)?.parentId;
	}
	return `${"  ".repeat(depth)}${chunk.index}. [${sanitizeDisplayText(state)}] ${label}`;
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
	const progress = new ProgressRegistry();
	// Progress mutations are accepted only inside a live session. Factory-time
	// listener registration is unconditional, but a late child relay after
	// shutdown must not repopulate the registry or receive an ack.
	let progressSessionActive = false;

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

	// Semantic progress: producers own `owner + trackerId` incarnations. The
	// registry parses at its boundary, so a malformed payload yields no result
	// and is dropped without an acknowledgement. Ack precedes changed so a
	// synchronous client can confirm support before observers react.
	const applyProgressMutation = (
		operation: ProgressOperation,
		request: { requestId: string; trackerId: string; trackerToken: string; owner: string } | undefined,
		run: () => ProgressRegistryResult | undefined,
	): void => {
		if (!progressSessionActive || !request) return;

		const result = run();
		if (!result) return;

		const ack: HubProgressAckPayload = {
			requestId: request.requestId,
			trackerId: request.trackerId,
			trackerToken: request.trackerToken,
			owner: request.owner,
			operation,
			ok: result.ok,
			changed: result.changed,
		};
		if (result.error !== undefined) ack.error = result.error;
		pi.events.emit(HUB_PROGRESS_CHANNELS.ack, ack);

		// Emit the observer snapshot only when the lightweight active view really
		// changed; clearing finished history is a registry-only change.
		if (result.snapshotChanged) {
			pi.events.emit(HUB_PROGRESS_CHANNELS.changed, copyProgressSnapshot(result.snapshot));
		}
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

	// Progress mutation relays. Parsing happens before any state change so a
	// malformed event is ignored completely (no ack, no changed).
	pi.events.on(HUB_PROGRESS_CHANNELS.create, (payload) => {
		const parsed = parseProgressCreate(payload);
		applyProgressMutation("create", parsed, () => progress.create(parsed));
	});

	pi.events.on(HUB_PROGRESS_CHANNELS.update, (payload) => {
		const parsed = parseProgressUpdate(payload);
		applyProgressMutation("update", parsed, () => progress.update(parsed));
	});

	pi.events.on(HUB_PROGRESS_CHANNELS.finish, (payload) => {
		const parsed = parseProgressFinish(payload);
		applyProgressMutation("finish", parsed, () => progress.finish(parsed));
	});

	pi.events.on(HUB_PROGRESS_CHANNELS.remove, (payload) => {
		const parsed = parseProgressRemove(payload);
		applyProgressMutation("remove", parsed, () => progress.remove(parsed));
	});

	// Query is a read, not a mutation, so it always answers with a detached
	// snapshot (an empty one after shutdown).
	pi.events.on(HUB_PROGRESS_CHANNELS.query, (payload) => {
		const parsed = parseProgressQuery(payload);
		if (!parsed) return;
		pi.events.emit(HUB_PROGRESS_CHANNELS.snapshot, {
			requestId: parsed.requestId,
			snapshot: copyProgressSnapshot(progress.snapshot()),
		});
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
		// Progress lives for exactly one session; enable mutations before any
		// other session-start work so the flag is independent of the Herdr path.
		progressSessionActive = true;

		if (!herdrTab || !isTuiContext(ctx)) return;
		void herdrTab.start().catch(() => undefined);
	});

	// A session tree change is still the same live process, so progress stays
	// active and is not reset. Registered unconditionally; the flag assignment is
	// harmless even if an older harness never emits the event.
	pi.on("session_tree", () => {
		progressSessionActive = true;
	});

	pi.on("session_shutdown", async () => {
		// Deactivate before resetting so a late child exit race cannot repopulate
		// the registry after the final snapshot. Emit one empty changed snapshot
		// only when observers actually held active trackers.
		progressSessionActive = false;
		const progressReset = progress.reset();
		if (progressReset.snapshotChanged) {
			pi.events.emit(HUB_PROGRESS_CHANNELS.changed, copyProgressSnapshot(progressReset.snapshot));
		}

		// Drop every registered wait and release Herdr if one was still open, so a
		// shut-down session cannot leave the pane stuck as blocked.
		applyUserWaitTransition(userWaits.reset());

		if (!herdrTab) return;
		// `stop()` is internally bounded by its restore timeout; awaiting it keeps
		// the shutdown handler from resolving before the label is restored.
		await herdrTab.stop().catch(() => undefined);
	});

	// Model-facing progress tool. Registration is factory-time so the tool is
	// available as soon as the extension loads, before the first session starts.
	registerProgressTool(pi);

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

			const progressActive = progress.activeCount();
			const progressTotal = progressActive + progress.finishedCount();

			const lines = [
				`hub providers: ${capsByProvider.size}`,
				...(providerLines.length > 0 ? providerLines : ["- (none)"]),
				`pending asks: ${pending.size}`,
				...pendingLines,
				`active user waits: ${waitSnapshot.count}`,
				...waitLines,
				`progress trackers: ${progressTotal} (${progressActive} active)`,
				`herdr tab: ${herdrTab?.describe() ?? "off"}`,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("px:progress", {
		description: "Show semantic progress trackers (/px:progress [owner/]trackerId)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;

			const records = progress.list();
			if (records.length === 0) {
				ctx.ui.notify("progress: no trackers", "info");
				return;
			}

			const requested = (args ?? "").trim();
			if (requested.length === 0) {
				// Every active tracker, then at most the ten most recently finished
				// (list is already ordered by updatedAt descending).
				const active = records.filter((record) => record.outcome === undefined);
				const finished = records
					.filter((record) => record.outcome !== undefined)
					.slice(0, MAX_FINISHED_PROGRESS_DISPLAY);

				const lines = [`active trackers: ${active.length}`];
				for (const record of active) lines.push(`- ${formatProgressSummary(record)}`);
				if (finished.length > 0) {
					lines.push(`recently finished: ${finished.length}`);
					for (const record of finished) lines.push(`- ${formatProgressSummary(record)}`);
				}

				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// `owner/trackerId` disambiguates when two owners share a tracker ID.
			const slash = requested.indexOf("/");
			if (slash > 0 && slash < requested.length - 1) {
				const owner = requested.slice(0, slash);
				const trackerId = requested.slice(slash + 1);
				const record = records.find((entry) => entry.owner === owner && entry.trackerId === trackerId);
				if (!record) {
					ctx.ui.notify(`progress tracker not found: ${sanitizeDisplayText(requested)}`, "warning");
					return;
				}
				const lines = [formatProgressSummary(record)];
				for (const chunk of record.chunks.slice(0, MAX_PROGRESS_CHUNKS)) lines.push(formatProgressChunk(chunk, record));
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const matches = records.filter((entry) => entry.trackerId === requested);
			if (matches.length === 0) {
				ctx.ui.notify(`progress tracker not found: ${sanitizeDisplayText(requested)}`, "warning");
				return;
			}
			if (matches.length > 1) {
				const owners = matches.map((entry) => sanitizeDisplayText(entry.owner)).join(", ");
				ctx.ui.notify(
					`progress: multiple owners for ${sanitizeDisplayText(requested)} (${owners}); use /px:progress <owner>/<trackerId>`,
					"warning",
				);
				return;
			}

			const record = matches[0] as ProgressTrackerRecord;
			const lines = [formatProgressSummary(record)];
			for (const chunk of record.chunks.slice(0, MAX_PROGRESS_CHUNKS)) lines.push(formatProgressChunk(chunk, record));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
