// Network-policy inheritance: bounded parent query and child argv.
//
// permissions-core owns the configured network policy and publishes it on
// `px:permissions-core:net:state:*`. We only need the `configured` value (the
// parent's already-derived `effective` policy is deliberately NOT inherited:
// a PARANOID child must still derive `ask-all` from its own safe mode). This
// mirrors the small read-only state contract instead of importing across
// extension folders, the same approach the safe-mode snapshot uses.

export const NETWORK_POLICY_STATE_REQUEST_EVENT = "px:permissions-core:net:state:request";
export const NETWORK_POLICY_STATE_RESPONSE_EVENT = "px:permissions-core:net:state:response";

/** Child argv flag consumed by permissions-core on session start. */
export const NETWORK_POLICY_FLAG = "network-policy";

/**
 * Configured policies, mirrored from permissions-core. `auto` means "derive
 * from the child's own safe mode"; the explicit policies are applied verbatim
 * (subject to the child's PARANOID override).
 */
export const NETWORK_POLICY_SETTINGS = [
	"auto",
	"deny-all",
	"ask-all",
	"allow-trusted",
	"ask-untrusted",
	"allow-all",
] as const;

export type NetworkPolicySetting = (typeof NETWORK_POLICY_SETTINGS)[number];

const MAX_ID_LENGTH = 256;
/** Same short bound as the safe-mode snapshot query. */
const DEFAULT_QUERY_TIMEOUT_MS = 150;

interface EventBusLike {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;
}

export function parseNetworkPolicySetting(value: unknown): NetworkPolicySetting | undefined {
	return typeof value === "string" && (NETWORK_POLICY_SETTINGS as readonly string[]).includes(value)
		? (value as NetworkPolicySetting)
		: undefined;
}

/**
 * Only the configured choice is readable from the response payload. Everything
 * else (missing `state`, unknown setting, `effective`-only payloads) yields
 * `undefined`, so a malformed response can never inherit a policy.
 */
function parseConfiguredSetting(value: unknown): NetworkPolicySetting | undefined {
	if (!isRecord(value)) return undefined;
	return parseNetworkPolicySetting(value.configured);
}

/**
 * Add the child flag only for a valid setting. A missing or malformed value
 * adds nothing, so the child keeps permissions-core's own Auto default instead
 * of inheriting a guessed (and possibly more permissive) policy. The value is
 * re-validated here so nothing unvalidated can ever reach child argv.
 */
export function appendNetworkPolicyArgs(args: string[], setting: unknown): void {
	const parsed = parseNetworkPolicySetting(setting);
	if (!parsed) return;
	args.push(`--${NETWORK_POLICY_FLAG}`, parsed);
}

/**
 * Ask permissions-core for the parent's configured policy. Resolves
 * `undefined` on timeout, absent provider, or malformed response, and never
 * throws and never goes through the hub.
 */
export function queryNetworkPolicySnapshot(
	events: EventBusLike,
	options?: { timeoutMs?: number; requestId?: string },
): Promise<NetworkPolicySetting | undefined> {
	const id = options?.requestId ?? `subagent-net-policy-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

	return new Promise((resolve) => {
		let settled = false;
		const finish = (setting: NetworkPolicySetting | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off();
			resolve(setting);
		};

		const off = events.on(NETWORK_POLICY_STATE_RESPONSE_EVENT, (payload) => {
			if (!isRecord(payload) || !isBoundedId(payload.id) || payload.id !== id) return;
			finish(parseConfiguredSetting(payload.state));
		});

		const timer = setTimeout(() => finish(undefined), timeoutMs);

		try {
			events.emit(NETWORK_POLICY_STATE_REQUEST_EVENT, { id });
		} catch {
			finish(undefined);
		}
	});
}
