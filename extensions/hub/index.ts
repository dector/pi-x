import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HUB_CHANNELS,
	type CapRequest,
	type CapResult,
	type HubAskPayload,
	type HubRegisterPayload,
	type HubReplyPayload,
	type HubUnregisterPayload,
	type PermissionAction,
} from "./contract";

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

	pi.events.on(HUB_CHANNELS.reply, (payload) => {
		const reply = parseReply(payload);
		if (!reply) return;

		const request = pending.get(reply.id);
		if (!request || request.settled) return;

		for (const result of reply.results) {
			const list = request.resultsByWhat.get(result.what) ?? [];
			list.push(result);
			request.resultsByWhat.set(result.what, list);
		}

		if (reply.from) request.pendingTargets.delete(reply.from);
		const allAnswered = request.cap.every((entry) => (request.resultsByWhat.get(entry.what)?.length ?? 0) > 0);
		if (allAnswered || request.pendingTargets.size === 0) finalize(reply.id);
	});

	pi.registerCommand("px:hub", {
		description: "Show hub providers and pending permission requests",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const providerLines = [...capsByProvider.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([id, caps]) => `- ${id}: ${[...caps].sort().join(", ") || "(none)"}`);

			const pendingLines = [...pending.entries()].map(
				([id, request]) => `- ${id}: ${request.cap.map((entry) => entry.what).join(", ")}`,
			);

			const lines = [
				`hub providers: ${capsByProvider.size}`,
				...(providerLines.length > 0 ? providerLines : ["- (none)"]),
				`pending asks: ${pending.size}`,
				...pendingLines,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
