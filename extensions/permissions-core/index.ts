import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NETWORK_STATE_EVENTS } from "./contract";
import { parseNetworkPolicySetting } from "./policy";
import {
	HUB_REQUEST_EVENT,
	PERMISSIONS_CORE_ENTRY_TYPE,
	createNetworkPermissionService,
	type PersistedNetworkSetting,
} from "./provider";
import {
	SAFE_MODE_STATE_CHANGED_EVENT,
	parseSafeModeChangedSource,
	parseSafeModeSnapshot,
	querySafeModeSnapshot,
} from "./safe-mode";

interface CustomEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function readPersistedSetting(ctx: ExtensionContext): PersistedNetworkSetting {
	let present = false;
	let configured: unknown;

	for (const entry of ctx.sessionManager.getBranch() as CustomEntryLike[]) {
		if (!entry || entry.type !== "custom" || entry.customType !== PERMISSIONS_CORE_ENTRY_TYPE) continue;
		present = true;
		configured = undefined;
		if (typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)) {
			configured = (entry.data as { configured?: unknown }).configured;
		}
	}

	return present ? { present: true, configured } : { present: false };
}

/**
 * permissions-core: headless network permission provider.
 *
 * Owns the effective network policy and answers `perm:net` hub requests. State
 * is exposed to UI/status-bar through `px:permissions-core:net:state:*`. Safe
 * mode is only observed (read-only); this extension never changes it.
 */
export default function permissionsCoreExtension(pi: ExtensionAPI): void {
	let activeContext: ExtensionContext | undefined;
	const service = createNetworkPermissionService({
		emit: (channel, payload) => pi.events.emit(channel, payload),
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
	});

	const restoreSession = async (ctx: ExtensionContext): Promise<void> => {
		activeContext = ctx;
		service.resetSession();
		service.restore(readPersistedSetting(ctx));
		// Register before the safe-mode query so a `perm:net` ask racing with
		// startup can still be answered. The provider never asks the hub itself.
		service.register();

		const snapshot = await querySafeModeSnapshot(pi.events);
		service.observeSafeMode(snapshot?.mode, snapshot ? "safe-mode:query" : "safe-mode:unavailable");
	};

	pi.on("session_start", async (_event, ctx) => {
		await restoreSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreSession(ctx);
	});

	pi.on("session_shutdown", () => {
		activeContext = undefined;
		service.unregister();
	});

	// Answer `perm:net` hub requests. Malformed requests and invalid payloads
	// block; the handler always replies for a `perm:net` cap it is targeted for.
	pi.events.on(HUB_REQUEST_EVENT, (payload) => {
		service.handleHubRequest(payload);
	});

	const unsubscribeRenewRequest = pi.events.on("px:renew:settings:request", (payload) => {
		if (!payload || typeof payload !== "object" || !activeContext) return;
		const request = payload as { id?: unknown; sourceSessionId?: unknown; cwd?: unknown };
		if (typeof request.id !== "string" || request.sourceSessionId !== activeContext.sessionManager.getSessionId() || request.cwd !== activeContext.cwd) return;
		pi.events.emit("px:renew:settings:response", {
			id: request.id,
			owner: "permissions-core",
			sourceSessionId: request.sourceSessionId,
			cwd: request.cwd,
			state: { configured: service.getState().configured },
		});
	});
	const unsubscribeRenewApply = pi.events.on("px:renew:settings:apply", (payload) => {
		if (!payload || typeof payload !== "object" || !activeContext) return;
		const request = payload as { transferId?: unknown; owner?: unknown; targetSessionId?: unknown; cwd?: unknown; state?: unknown };
		if (typeof request.transferId !== "string" || request.owner !== "permissions-core" || request.targetSessionId !== activeContext.sessionManager.getSessionId() || request.cwd !== activeContext.cwd) return;
		const configured = parseNetworkPolicySetting((request.state as { configured?: unknown } | undefined)?.configured);
		if (!configured) return;
		service.setConfigured(configured, "renew");
		pi.events.emit("px:renew:settings:ack", { transferId: request.transferId, owner: "permissions-core", targetSessionId: request.targetSessionId, cwd: request.cwd });
	});
	pi.on("session_shutdown", () => {
		unsubscribeRenewRequest();
		unsubscribeRenewApply();
	});

	pi.events.on(NETWORK_STATE_EVENTS.request, (payload) => {
		service.handleStateRequest(payload);
	});

	pi.events.on(NETWORK_STATE_EVENTS.set, (payload) => {
		service.handleStateSet(payload);
	});

	pi.events.on(SAFE_MODE_STATE_CHANGED_EVENT, (payload) => {
		const snapshot = parseSafeModeSnapshot(payload);
		service.observeSafeMode(snapshot?.mode, parseSafeModeChangedSource(payload));
	});
}
