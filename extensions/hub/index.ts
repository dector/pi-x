import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HUB_CHANNELS,
	type CapRequest,
	type HubAskPayload,
	type HubRegisterPayload,
	type HubUnregisterPayload,
} from "./contract";

/**
 * hub: central signal hub for pi-x extensions.
 *
 * Keeps a registry of capability providers and routes `hub:ask` requests to
 * the providers that declared the requested capability. Hub is permissive:
 * malformed payloads are dropped, but nothing is blocked or authorized here.
 */

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

export default function hubExtension(pi: ExtensionAPI): void {
	const providersByCap = new Map<string, Set<string>>();
	const capsByProvider = new Map<string, Set<string>>();

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
		if (targets.size === 0) return;

		pi.events.emit(HUB_CHANNELS.request, {
			id: ask.id,
			from: ask.from,
			ctx: ask.ctx,
			cap: ask.cap,
			targets: [...targets],
		});
	});
}
