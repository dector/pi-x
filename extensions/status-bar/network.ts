// status-bar consumer for the permissions-core network state.
//
// `status-bar` must not import across extension directories, so this module
// mirrors the validated permissions-core contract (event names + payload
// parsers) exactly like `permissions-ui` does. It stays pure and testable: no
// pi runtime and no TUI imports. `index.ts` binds it to `pi.events` and the
// active editor theme.
//
// The status bar only ever reads effective state. Malformed payloads and an
// absent core are dropped/failed gracefully: no network token is rendered.

export const NETWORK_STATE_EVENTS = {
	request: "px:permissions-core:net:state:request",
	response: "px:permissions-core:net:state:response",
	set: "px:permissions-core:net:state:set",
	changed: "px:permissions-core:net:state:changed",
} as const;

export const NETWORK_POLICIES = [
	"deny-all",
	"ask-all",
	"allow-trusted",
	"ask-untrusted",
	"allow-all",
] as const;

export type NetworkPolicy = (typeof NETWORK_POLICIES)[number];

export const NETWORK_POLICY_SETTINGS = ["auto", ...NETWORK_POLICIES] as const;

export type NetworkPolicySetting = (typeof NETWORK_POLICY_SETTINGS)[number];

export interface NetworkPermissionState {
	configured: NetworkPolicySetting;
	effective: NetworkPolicy;
	// Safe-mode-derived Auto policy, independent of `configured`. Under
	// PARANOID (or an unknown safe mode) it is always `ask-all`.
	autoEffective: NetworkPolicy;
	overriddenByParanoid: boolean;
}

export const NETWORK_STATUS_TOKENS = ["NET", "NET?", "NET+"] as const;

export type NetworkStatusToken = (typeof NETWORK_STATUS_TOKENS)[number];

/** Compact symbols used after the border's network glyph. */
export const NETWORK_BORDER_TOKENS = ["×", "?", "✓", "✓?", "!"] as const;
export type NetworkBorderToken = (typeof NETWORK_BORDER_TOKENS)[number];

// Kept as strings so this module stays free of the pi theme type and can be
// tested purely.
export type NetworkStatusColor = "muted" | "userMessageText" | "error";

export const POLICY_TOKENS: Record<NetworkPolicy, NetworkStatusToken> = {
	"deny-all": "NET",
	"ask-all": "NET?",
	"allow-trusted": "NET",
	"ask-untrusted": "NET?",
	"allow-all": "NET+",
};

export const POLICY_COLORS: Record<NetworkPolicy, NetworkStatusColor> = {
	"deny-all": "muted",
	"ask-all": "muted",
	"allow-trusted": "userMessageText",
	"ask-untrusted": "userMessageText",
	"allow-all": "userMessageText",
};

export const POLICY_BORDER_TOKENS: Record<NetworkPolicy, NetworkBorderToken> = {
	"deny-all": "×",
	"ask-all": "?",
	"allow-trusted": "✓",
	"ask-untrusted": "✓?",
	"allow-all": "!",
};

export function tokenForPolicy(policy: NetworkPolicy): NetworkStatusToken {
	return POLICY_TOKENS[policy];
}

export function colorForPolicy(policy: NetworkPolicy): NetworkStatusColor {
	return POLICY_COLORS[policy];
}

// Auto derivation can only produce these policies (paranoid/reader -> ask-all,
// smart -> ask-untrusted, yolo -> allow-trusted).
const AUTO_DERIVABLE_POLICIES: ReadonlySet<NetworkPolicy> = new Set([
	"ask-all",
	"ask-untrusted",
	"allow-trusted",
]);

const MAX_ID_LENGTH = 256;
const MAX_SOURCE_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
	return typeof value === "string" && (options as readonly string[]).includes(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export function parseNetworkPolicy(value: unknown): NetworkPolicy | undefined {
	return isOneOf(value, NETWORK_POLICIES) ? value : undefined;
}

export function parseNetworkPolicySetting(value: unknown): NetworkPolicySetting | undefined {
	return isOneOf(value, NETWORK_POLICY_SETTINGS) ? value : undefined;
}

/**
 * Validate a full network permission state. Rejects inconsistent combinations
 * so the status bar never renders a state the core could not have produced.
 */
export function parseNetworkPermissionState(value: unknown): NetworkPermissionState | undefined {
	if (!isRecord(value)) return undefined;

	const configured = parseNetworkPolicySetting(value.configured);
	const effective = parseNetworkPolicy(value.effective);
	const autoEffective = parseNetworkPolicy(value.autoEffective);
	if (!configured || !effective || !autoEffective || typeof value.overriddenByParanoid !== "boolean") {
		return undefined;
	}

	if (!AUTO_DERIVABLE_POLICIES.has(autoEffective)) return undefined;

	if (value.overriddenByParanoid) {
		if (effective !== "ask-all" || autoEffective !== "ask-all") return undefined;
	} else if (configured === "auto") {
		if (effective !== autoEffective) return undefined;
	} else if (effective !== configured) {
		return undefined;
	}

	return { configured, effective, autoEffective, overriddenByParanoid: value.overriddenByParanoid };
}

export interface NetworkStateResponse {
	id: string;
	state: NetworkPermissionState;
}

export function parseNetworkStateResponse(value: unknown): NetworkStateResponse | undefined {
	if (!isRecord(value) || !isBoundedString(value.id, MAX_ID_LENGTH)) return undefined;
	const state = parseNetworkPermissionState(value.state);
	return state ? { id: value.id, state } : undefined;
}

export interface NetworkStateChanged extends NetworkPermissionState {
	source?: string;
}

export function parseNetworkStateChanged(value: unknown): NetworkStateChanged | undefined {
	if (!isRecord(value)) return undefined;
	const state = parseNetworkPermissionState(value);
	if (!state) return undefined;
	if (value.source !== undefined && !isBoundedString(value.source, MAX_SOURCE_LENGTH)) return undefined;
	return { ...state, source: value.source as string | undefined };
}

export interface EventBusLike {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

const DEFAULT_QUERY_TIMEOUT_MS = 300;

/**
 * Bounded, read-only state query against permissions-core.
 *
 * Never throws and never goes through the hub. Resolves `undefined` on
 * timeout, malformed response, or absent provider, so the status bar can simply
 * render no token when the core is unavailable.
 */
export function queryNetworkState(
	events: EventBusLike,
	options?: { timeoutMs?: number; requestId?: string },
): Promise<NetworkPermissionState | undefined> {
	const id = options?.requestId ?? `status-bar-net-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

	return new Promise((resolve) => {
		let settled = false;
		const finish = (state: NetworkPermissionState | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off();
			resolve(state);
		};

		const off = events.on(NETWORK_STATE_EVENTS.response, (payload) => {
			const response = parseNetworkStateResponse(payload);
			if (!response || response.id !== id) return;
			finish(response.state);
		});

		const timer = setTimeout(() => finish(undefined), timeoutMs);

		try {
			events.emit(NETWORK_STATE_EVENTS.request, { id });
		} catch {
			finish(undefined);
		}
	});
}

export interface NetworkTheme {
	fg: (token: NetworkStatusColor, text: string) => string;
}

/** Render the effective network token with its muted/user-message theme color. */
export function renderNetworkToken(policy: NetworkPolicy, theme: NetworkTheme): string {
	return theme.fg(colorForPolicy(policy), tokenForPolicy(policy));
}

/** Render the compact border value; neutral values inherit the frame color. */
export function renderBorderNetworkToken(policy: NetworkPolicy, theme: NetworkTheme): string {
	const token = POLICY_BORDER_TOKENS[policy];
	if (policy === "deny-all") return theme.fg("muted", token);
	if (policy === "allow-all") return theme.fg("error", token);
	return token;
}

/** Render the effective network token from validated state. */
export function renderEffectiveNetworkToken(state: NetworkPermissionState, theme: NetworkTheme): string {
	return renderNetworkToken(state.effective, theme);
}

// Which surface owns the network token. `new` mode renders it on the editor
// border; `legacy` mode renders it on the status line. Exactly one surface is
// used so the token is never duplicated.
export type NetworkStatusSurface = "border" | "status-line";

export function networkSurfaceForDisplayMode(mode: "new" | "legacy"): NetworkStatusSurface {
	return mode === "new" ? "border" : "status-line";
}

export interface NetworkStatusResolution {
	surface: NetworkStatusSurface;
	label: string;
}

/**
 * Resolve the single surface that owns the effective network token and the
 * rendered label. `undefined` when there is no state (core absent), so callers
 * render nothing instead of a stale token.
 */
export function resolveNetworkStatus(args: {
	displayMode: "new" | "legacy";
	state: NetworkPermissionState | undefined;
	theme: NetworkTheme;
}): NetworkStatusResolution | undefined {
	if (!args.state) return undefined;
	const surface = networkSurfaceForDisplayMode(args.displayMode);
	return {
		surface,
		label:
			surface === "border"
				? renderBorderNetworkToken(args.state.effective, args.theme)
				: renderEffectiveNetworkToken(args.state, args.theme),
	};
}

function hasVisibleText(value?: string): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Live client-side cache of the effective network state.
 *
 * Subscribes to the validated permissions-core `changed` events and exposes
 * bounded `refresh()` queries. A `changed` event that lands while a query is in
 * flight always wins over the older query response, so safe-mode and policy
 * changes are reflected as soon as they happen.
 */
export class NetworkStateStore {
	private state: NetworkPermissionState | undefined;
	private version = 0;
	/** Only an active session may apply live `changed` events. */
	private active = false;
	private readonly unsubscribe: () => void;

	constructor(private readonly options: { events: EventBusLike; onChange: () => void }) {
		this.unsubscribe = options.events.on(NETWORK_STATE_EVENTS.changed, (payload) => {
			// Ignore events before activation and after shutdown, so a late event
			// cannot restore a stale token for a session that already ended.
			if (!this.active) return;
			const changed = parseNetworkStateChanged(payload);
			if (!changed) return;
			// Drop the routing `source` so the cached value is pure state.
			const { configured, effective, autoEffective, overriddenByParanoid } = changed;
			this.set({ configured, effective, autoEffective, overriddenByParanoid });
		});
	}

	get current(): NetworkPermissionState | undefined {
		return this.state;
	}

	/** Mark a session active so live `changed` events and `refresh()` are applied. */
	activate(): void {
		this.active = true;
	}

	/**
	 * Mark the session inactive and drop cached state. Late `changed` events and
	 * in-flight queries are ignored until the next `activate()`.
	 */
	deactivate(): void {
		this.active = false;
		this.set(undefined);
	}

	clear(): void {
		this.set(undefined);
	}

	/** Bounded read. Falls back to no state when the core is absent. */
	async refresh(options?: { timeoutMs?: number }): Promise<void> {
		if (!this.active) return;
		const version = this.version;
		const next = await queryNetworkState(this.options.events, options);
		if (!this.active || this.version !== version) return;
		this.set(next);
	}

	dispose(): void {
		this.unsubscribe();
	}

	private set(next: NetworkPermissionState | undefined): void {
		this.state = next;
		this.version += 1;
		this.options.onChange();
	}
}

/**
 * Join an already-styled safe-mode label and an already-styled network token
 * with exactly ` · `. The separator is colored by the caller (the frame border
 * color on the editor border). Either part may be missing; both missing yields
 * `undefined`.
 */
export function joinSafeModeAndNetwork(
	safeMode: string | undefined,
	network: string | undefined,
	colorSeparator: (text: string) => string,
): string | undefined {
	const parts: string[] = [];
	if (hasVisibleText(safeMode)) parts.push(safeMode);
	if (hasVisibleText(network)) parts.push(network);
	if (parts.length === 0) return undefined;
	return parts.join(colorSeparator(" · "));
}
