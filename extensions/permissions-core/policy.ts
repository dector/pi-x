// Pure network permission policy model.
//
// This module is headless: it owns validation, normalization, trust
// classification, policy disposition, Auto derivation from safe mode, and
// serializable state types. It performs no I/O, registers no hub provider,
// and renders no UI. Stage 2 wires it into the hub.

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

export const NETWORK_TOOLS = ["http", "http_md", "web_search"] as const;

export type NetworkToolName = (typeof NETWORK_TOOLS)[number];

export const NETWORK_OPERATIONS = ["request", "search"] as const;

export type NetworkOperation = (typeof NETWORK_OPERATIONS)[number];

export type NetworkTrust = "trusted" | "untrusted";

export type NetworkPermissionAction = "allow" | "confirm" | "block";

// Canonical safe modes emitted by the safe-mode extension. `yolo+` is a UI
// label for `yolo` with outer access enabled; outer access does not change
// network policy, so only the base mode is a valid policy input.
export const NETWORK_SAFE_MODES = ["paranoid", "reader", "smart", "yolo"] as const;

export type NetworkSafeMode = (typeof NETWORK_SAFE_MODES)[number];

export const TRUSTED_HTTP_METHODS = ["GET", "HEAD", "OPTIONS"] as const;

export interface NetworkPermissionRequest {
	toolName: NetworkToolName;
	operation: NetworkOperation;
	url?: string;
	method?: string;
	query?: string;
}

export interface NetworkPermissionDecision {
	action: NetworkPermissionAction;
	reason?: string;
	summary?: string;
}

export interface NetworkPermissionState {
	configured: NetworkPolicySetting;
	effective: NetworkPolicy;
	// Safe-mode-derived Auto policy, independent of `configured`. Under
	// PARANOID (or an unknown safe mode) it is always `ask-all`.
	autoEffective: NetworkPolicy;
	overriddenByParanoid: boolean;
}

const MAX_URL_LENGTH = 8192;
const MAX_QUERY_LENGTH = 2048;
const MAX_HTTP_METHOD_LENGTH = 32;
const MAX_SUMMARY_LENGTH = 240;

// RFC 7230 token characters.
const HTTP_METHOD_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// C0/C1 control characters plus DEL. Non-global copy for `.test()` (a global
// regex would be stateful).
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
// Global copy for sanitizing every occurrence.
const CONTROL_CHARACTER_GLOBAL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
	return typeof value === "string" && (options as readonly string[]).includes(value);
}

export function parseNetworkPolicy(value: unknown): NetworkPolicy | undefined {
	return isOneOf(value, NETWORK_POLICIES) ? value : undefined;
}

export function parseNetworkPolicySetting(value: unknown): NetworkPolicySetting | undefined {
	return isOneOf(value, NETWORK_POLICY_SETTINGS) ? value : undefined;
}

export function parseNetworkSafeMode(value: unknown): NetworkSafeMode | undefined {
	return isOneOf(value, NETWORK_SAFE_MODES) ? value : undefined;
}

export function parseNetworkToolName(value: unknown): NetworkToolName | undefined {
	return isOneOf(value, NETWORK_TOOLS) ? value : undefined;
}

export function parseNetworkOperation(value: unknown): NetworkOperation | undefined {
	return isOneOf(value, NETWORK_OPERATIONS) ? value : undefined;
}

/**
 * Normalize an HTTP method. Missing/blank methods become `GET`; methods are
 * trimmed and uppercased; anything that is not a valid HTTP token is invalid.
 */
export function normalizeHttpMethod(raw: unknown): string | undefined {
	if (raw === undefined || raw === null) return "GET";
	if (typeof raw !== "string") return undefined;
	if (CONTROL_CHARACTER_PATTERN.test(raw)) return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return "GET";
	const upper = trimmed.toUpperCase();
	if (upper.length > MAX_HTTP_METHOD_LENGTH) return undefined;
	return HTTP_METHOD_PATTERN.test(upper) ? upper : undefined;
}

/**
 * Validate and normalize an absolute HTTP(S) URL. Invalid URLs block; they are
 * never treated as untrusted traffic.
 */
export function normalizeNetworkUrl(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return undefined;
	if (CONTROL_CHARACTER_PATTERN.test(trimmed)) return undefined;

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return undefined;
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	if (parsed.hostname.length === 0) return undefined;
	// Credentials in the URL are rejected so normalized URLs and summaries can
	// never leak them. There is no legitimate need to send userinfo over HTTP.
	if (parsed.username.length > 0 || parsed.password.length > 0) return undefined;
	return parsed.href;
}

function normalizeQuery(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_QUERY_LENGTH) return undefined;
	if (CONTROL_CHARACTER_PATTERN.test(trimmed)) return undefined;
	return trimmed;
}

/**
 * Validate and normalize a raw network permission request.
 *
 * Returns `undefined` for malformed or unsupported payloads. Callers must
 * block those requests, never turn them into an approval prompt.
 */
export function parseNetworkPermissionRequest(value: unknown): NetworkPermissionRequest | undefined {
	if (!isRecord(value)) return undefined;

	const toolName = parseNetworkToolName(value.toolName);
	const operation = parseNetworkOperation(value.operation);
	if (!toolName || !operation) return undefined;

	if (toolName === "web_search") {
		if (operation !== "search") return undefined;
		if (value.query === undefined) return { toolName, operation };
		const query = normalizeQuery(value.query);
		return query ? { toolName, operation, query } : undefined;
	}

	// http / http_md
	if (operation !== "request") return undefined;
	const url = normalizeNetworkUrl(value.url);
	if (!url) return undefined;
	const method = normalizeHttpMethod(value.method);
	if (!method) return undefined;
	return { toolName, operation, url, method };
}

export function isTrustedHttpMethod(method: unknown): boolean {
	const normalized = normalizeHttpMethod(method);
	return normalized !== undefined && (TRUSTED_HTTP_METHODS as readonly string[]).includes(normalized);
}

function classifyParsedNetworkTrust(request: NetworkPermissionRequest): NetworkTrust {
	if (request.toolName === "web_search") return "trusted";
	return isTrustedHttpMethod(request.method) ? "trusted" : "untrusted";
}

/**
 * Layer 1: classify a raw network request.
 *
 * Validates and normalizes the request first. Malformed or unsupported
 * requests return `undefined`; callers must fail closed rather than treat
 * them as trusted. GET, HEAD, and OPTIONS are trusted; other valid methods
 * are untrusted. `web_search` is trusted.
 */
export function classifyNetworkTrust(request: unknown): NetworkTrust | undefined {
	const parsed = parseNetworkPermissionRequest(request);
	return parsed ? classifyParsedNetworkTrust(parsed) : undefined;
}

/**
 * Layer 2: map a policy and trust classification to a hub action.
 *
 * | Policy         | trusted | untrusted |
 * | -------------- | ------- | --------- |
 * | deny-all       | block   | block     |
 * | ask-all        | confirm | confirm   |
 * | allow-trusted  | allow   | block     |
 * | ask-untrusted  | allow   | confirm   |
 * | allow-all      | allow   | allow     |
 */
export function dispositionForPolicy(policy: NetworkPolicy, trust: NetworkTrust): NetworkPermissionAction {
	switch (policy) {
		case "deny-all":
			return "block";
		case "ask-all":
			return "confirm";
		case "allow-trusted":
			return trust === "trusted" ? "allow" : "block";
		case "ask-untrusted":
			return trust === "trusted" ? "allow" : "confirm";
		case "allow-all":
			return "allow";
		default:
			return "block";
	}
}

export function describeNetworkDisposition(policy: NetworkPolicy, trust: NetworkTrust): string {
	switch (policy) {
		case "deny-all":
			return "Network policy denies all valid requests.";
		case "ask-all":
			return "Network policy requires approval for all valid requests.";
		case "allow-trusted":
			return trust === "trusted"
				? "Network policy allows trusted requests."
				: "Network policy denies untrusted requests.";
		case "ask-untrusted":
			return trust === "trusted"
				? "Network policy allows trusted requests."
				: "Network policy requires approval for untrusted requests.";
		case "allow-all":
			return "Network policy allows all valid requests.";
		default:
			return "Network policy blocks the request.";
	}
}

function sanitizeSummaryText(value: string): string {
	const collapsed = value.replace(CONTROL_CHARACTER_GLOBAL_PATTERN, " ").replace(/\s+/g, " ").trim();
	if (collapsed.length <= MAX_SUMMARY_LENGTH) return collapsed;
	return `${collapsed.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
}

export function summarizeNetworkRequest(request: NetworkPermissionRequest): string {
	if (request.toolName === "web_search") {
		const query = request.query ? sanitizeSummaryText(request.query) : "";
		return query.length > 0 ? `web_search: "${query}"` : "web_search";
	}

	const method = normalizeHttpMethod(request.method) ?? "?";
	// Only a normalized URL is safe to display. Never echo a raw URL: it may be
	// malformed or contain credentials that normalization rejected.
	const url = normalizeNetworkUrl(request.url) ?? "";
	return url.length > 0 ? `${request.toolName}: ${method} ${url}` : `${request.toolName}: ${method}`;
}

/**
 * Validate, classify, and dispose a raw request under one effective policy.
 *
 * Malformed or unsupported requests block. A valid request uses the policy
 * matrix above. `allow-all` applies only to valid network operations.
 */
export function evaluateNetworkPermission(args: {
	request: unknown;
	policy: unknown;
}): NetworkPermissionDecision {
	const policy = parseNetworkPolicy(args.policy);
	if (!policy) {
		return { action: "block", reason: "Invalid network policy." };
	}

	const request = parseNetworkPermissionRequest(args.request);
	if (!request) {
		return { action: "block", reason: "Invalid or unsupported network request." };
	}

	const trust = classifyParsedNetworkTrust(request);
	const action = dispositionForPolicy(policy, trust);
	const decision: NetworkPermissionDecision = { action, summary: summarizeNetworkRequest(request) };
	if (action !== "allow") decision.reason = describeNetworkDisposition(policy, trust);
	return decision;
}

/**
 * Safe-mode-derived Auto behavior.
 *
 * | Safe mode | Auto policy     |
 * | --------- | --------------- |
 * | paranoid  | ask-all         |
 * | reader    | ask-all         |
 * | smart     | ask-untrusted   |
 * | yolo      | allow-trusted   |
 *
 * Only canonical lowercase safe modes are accepted. `yolo+` is not a safe
 * mode (it is `yolo` plus outer access, which does not affect network policy).
 * Unknown or mixed-case modes fail closed to `ask-all`.
 */
export function deriveAutoNetworkPolicy(safeMode: unknown): NetworkPolicy {
	switch (parseNetworkSafeMode(safeMode)) {
		case "smart":
			return "ask-untrusted";
		case "yolo":
			return "allow-trusted";
		case "paranoid":
		case "reader":
		default:
			return "ask-all";
	}
}

// Auto derivation can only ever yield one of these policies. Persisted state
// whose `autoEffective` (or `effective` under `auto`) is anything else is
// inconsistent and rejected.
const AUTO_DERIVABLE_POLICIES: ReadonlySet<NetworkPolicy> = new Set(
	NETWORK_SAFE_MODES.map((mode) => deriveAutoNetworkPolicy(mode)),
);

/**
 * Compute the validated effective state from a configured setting and the
 * current safe mode.
 *
 * PARANOID forces `ask-all` and sets `overriddenByParanoid`, but the configured
 * choice is retained. Leaving PARANOID resumes the configured policy, or Auto
 * derivation when configured is `auto`.
 *
 * The safe mode must be a canonical lowercase {@link NetworkSafeMode}. Unknown
 * or mixed-case modes fail closed: the effective policy becomes `ask-all` and
 * `overriddenByParanoid` is set, so they cannot silently bypass PARANOID
 * restrictions while the configured choice is retained.
 */
export function resolveNetworkPermissionState(args: {
	configured: NetworkPolicySetting;
	safeMode: unknown;
}): NetworkPermissionState {
	const configured = parseNetworkPolicySetting(args.configured) ?? "ask-all";
	const safeMode = parseNetworkSafeMode(args.safeMode);
	// Auto derivation is independent of the configured choice, so the UI can
	// always show what Auto would do even while an explicit policy is active.
	const autoEffective = deriveAutoNetworkPolicy(safeMode);
	if (!safeMode) {
		return { configured, effective: "ask-all", autoEffective, overriddenByParanoid: true };
	}

	const paranoid = safeMode === "paranoid";
	const derived = configured === "auto" ? autoEffective : configured;

	return {
		configured,
		effective: paranoid ? "ask-all" : derived,
		autoEffective,
		overriddenByParanoid: paranoid,
	};
}

/** New sessions start at Auto. */
export function createInitialNetworkPermissionState(safeMode: unknown): NetworkPermissionState {
	return resolveNetworkPermissionState({ configured: "auto", safeMode });
}

export function serializeNetworkPermissionState(state: NetworkPermissionState): string {
	return JSON.stringify({
		configured: state.configured,
		effective: state.effective,
		autoEffective: state.autoEffective,
		overriddenByParanoid: state.overriddenByParanoid,
	});
}

export function parseNetworkPermissionState(value: unknown): NetworkPermissionState | undefined {
	if (!isRecord(value)) return undefined;

	const configured = parseNetworkPolicySetting(value.configured);
	const effective = parseNetworkPolicy(value.effective);
	const autoEffective = parseNetworkPolicy(value.autoEffective);
	if (!configured || !effective || !autoEffective || typeof value.overriddenByParanoid !== "boolean") {
		return undefined;
	}

	// Auto can only derive the policies reachable from canonical safe modes.
	if (!AUTO_DERIVABLE_POLICIES.has(autoEffective)) return undefined;

	if (value.overriddenByParanoid) {
		// PARANOID (or a fail-closed unknown safe mode) always yields ask-all
		// for both the effective and the Auto-derived policy.
		if (effective !== "ask-all" || autoEffective !== "ask-all") return undefined;
	} else if (configured === "auto") {
		// Auto's effective policy is exactly its derived policy.
		if (effective !== autoEffective) return undefined;
	} else if (effective !== configured) {
		// Explicit choices are effective verbatim while PARANOID is inactive.
		return undefined;
	}

	return { configured, effective, autoEffective, overriddenByParanoid: value.overriddenByParanoid };
}

export function deserializeNetworkPermissionState(json: string): NetworkPermissionState | undefined {
	try {
		return parseNetworkPermissionState(JSON.parse(json));
	} catch {
		return undefined;
	}
}
