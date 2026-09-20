import { expect, test } from "bun:test";
import {
	NETWORK_POLICIES,
	NETWORK_POLICY_SETTINGS,
	classifyNetworkTrust,
	createInitialNetworkPermissionState,
	deriveAutoNetworkPolicy,
	deserializeNetworkPermissionState,
	dispositionForPolicy,
	evaluateNetworkPermission,
	normalizeHttpMethod,
	normalizeNetworkUrl,
	parseNetworkPermissionRequest,
	parseNetworkPermissionState,
	resolveNetworkPermissionState,
	serializeNetworkPermissionState,
	summarizeNetworkRequest,
	type NetworkPermissionAction,
	type NetworkPermissionRequest,
	type NetworkPolicy,
	type NetworkTrust,
} from "./policy.ts";

const POLICY_MATRIX: Record<NetworkPolicy, Record<NetworkTrust, NetworkPermissionAction>> = {
	"deny-all": { trusted: "block", untrusted: "block" },
	"ask-all": { trusted: "confirm", untrusted: "confirm" },
	"allow-trusted": { trusted: "allow", untrusted: "block" },
	"ask-untrusted": { trusted: "allow", untrusted: "confirm" },
	"allow-all": { trusted: "allow", untrusted: "allow" },
};

const TRUSTED_METHODS = ["GET", "HEAD", "OPTIONS"] as const;
const UNTRUSTED_METHODS = ["POST", "PUT", "PATCH", "DELETE", "TRACE", "CONNECT", "FROBNICATE"] as const;

function request(partial: Partial<NetworkPermissionRequest> & Pick<NetworkPermissionRequest, "toolName" | "operation">): NetworkPermissionRequest {
	return partial;
}

// ---------------------------------------------------------------------------
// Method normalization
// ---------------------------------------------------------------------------

test("normalizeHttpMethod: missing or blank methods default to GET", () => {
	expect(normalizeHttpMethod(undefined)).toBe("GET");
	expect(normalizeHttpMethod(null)).toBe("GET");
	expect(normalizeHttpMethod("")).toBe("GET");
	expect(normalizeHttpMethod("   ")).toBe("GET");
});

test("normalizeHttpMethod: trims and uppercases valid tokens", () => {
	expect(normalizeHttpMethod("get")).toBe("GET");
	expect(normalizeHttpMethod("  post  ")).toBe("POST");
	expect(normalizeHttpMethod("patch")).toBe("PATCH");
});

test("normalizeHttpMethod: rejects non-strings and invalid tokens", () => {
	expect(normalizeHttpMethod(123)).toBeUndefined();
	expect(normalizeHttpMethod({})).toBeUndefined();
	expect(normalizeHttpMethod("GE T")).toBeUndefined();
	expect(normalizeHttpMethod("GET\n")).toBeUndefined();
	expect(normalizeHttpMethod("G/ET")).toBeUndefined();
	expect(normalizeHttpMethod("X".repeat(33))).toBeUndefined();
});

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

test("normalizeNetworkUrl: normalizes absolute http(s) URLs", () => {
	expect(normalizeNetworkUrl("https://example.com")).toBe("https://example.com/");
	expect(normalizeNetworkUrl("  https://example.com/path?a=1&b=2  ")).toBe("https://example.com/path?a=1&b=2");
	expect(normalizeNetworkUrl("http://localhost:3000/api")).toBe("http://localhost:3000/api");
});

test("normalizeNetworkUrl: rejects malformed and unsupported URLs", () => {
	expect(normalizeNetworkUrl(undefined)).toBeUndefined();
	expect(normalizeNetworkUrl(42)).toBeUndefined();
	expect(normalizeNetworkUrl("")).toBeUndefined();
	expect(normalizeNetworkUrl("   ")).toBeUndefined();
	expect(normalizeNetworkUrl("not a url")).toBeUndefined();
	expect(normalizeNetworkUrl("/relative/path")).toBeUndefined();
	expect(normalizeNetworkUrl("ftp://example.com/file")).toBeUndefined();
	expect(normalizeNetworkUrl("file:///etc/passwd")).toBeUndefined();
	expect(normalizeNetworkUrl("javascript:alert(1)")).toBeUndefined();
	expect(normalizeNetworkUrl("https://exa\u0000mple.com")).toBeUndefined();
	expect(normalizeNetworkUrl(`https://example.com/${"a".repeat(8192)}`)).toBeUndefined();
});

test("normalizeNetworkUrl: rejects URLs with credentials so they cannot leak", () => {
	expect(normalizeNetworkUrl("https://user:pass@example.com/path")).toBeUndefined();
	expect(normalizeNetworkUrl("https://user@example.com/path")).toBeUndefined();
	expect(normalizeNetworkUrl("https://:pass@example.com/path")).toBeUndefined();
	expect(normalizeNetworkUrl("http://token@localhost:3000/")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Request validation / normalization
// ---------------------------------------------------------------------------

test("parseNetworkPermissionRequest: normalizes http requests", () => {
	expect(parseNetworkPermissionRequest({ toolName: "http", operation: "request", url: "https://example.com", method: "get" })).toEqual({
		toolName: "http",
		operation: "request",
		url: "https://example.com/",
		method: "GET",
	});
	expect(parseNetworkPermissionRequest({ toolName: "http", operation: "request", url: "https://example.com" })).toEqual({
		toolName: "http",
		operation: "request",
		url: "https://example.com/",
		method: "GET",
	});
	expect(parseNetworkPermissionRequest({ toolName: "http_md", operation: "request", url: "https://example.com", method: "post" })).toEqual({
		toolName: "http_md",
		operation: "request",
		url: "https://example.com/",
		method: "POST",
	});
});

test("parseNetworkPermissionRequest: normalizes web_search requests", () => {
	expect(parseNetworkPermissionRequest({ toolName: "web_search", operation: "search", query: "  pi coding agent  " })).toEqual({
		toolName: "web_search",
		operation: "search",
		query: "pi coding agent",
	});
	expect(parseNetworkPermissionRequest({ toolName: "web_search", operation: "search" })).toEqual({
		toolName: "web_search",
		operation: "search",
	});
});

test("parseNetworkPermissionRequest: rejects malformed payloads", () => {
	const cases: unknown[] = [
		undefined,
		null,
		42,
		"http",
		[],
		{},
		{ toolName: "curl", operation: "request", url: "https://example.com" },
		{ toolName: "http", url: "https://example.com" },
		{ toolName: "http", operation: "search", url: "https://example.com" },
		{ toolName: "http", operation: "request" },
		{ toolName: "http", operation: "request", url: "" },
		{ toolName: "http", operation: "request", url: "ftp://example.com" },
		{ toolName: "http", operation: "request", url: "https://example.com", method: "GE T" },
		{ toolName: "http", operation: "request", url: "https://example.com", method: "POST\n" },
		{ toolName: "http_md", operation: "bogus", url: "https://example.com" },
		{ toolName: "web_search", operation: "request", query: "pi" },
		{ toolName: "web_search", operation: "search", query: "" },
		{ toolName: "web_search", operation: "search", query: "   " },
		{ toolName: "web_search", operation: "search", query: 42 },
	];
	for (const value of cases) {
		expect(parseNetworkPermissionRequest(value)).toBeUndefined();
	}
});

// ---------------------------------------------------------------------------
// Trust classification
// ---------------------------------------------------------------------------

const TRUSTED_HTTP_URL = "https://example.com";

function httpRequest(method: string | undefined): {
	toolName: "http";
	operation: "request";
	url: string;
	method?: string;
} {
	return { toolName: "http", operation: "request", url: TRUSTED_HTTP_URL, ...(method === undefined ? {} : { method }) };
}

test("classifyNetworkTrust: GET, HEAD, and OPTIONS are trusted", () => {
	for (const method of TRUSTED_METHODS) {
		expect(classifyNetworkTrust(httpRequest(method))).toBe("trusted");
		expect(classifyNetworkTrust(httpRequest(method.toLowerCase()))).toBe("trusted");
	}
	expect(classifyNetworkTrust({ toolName: "http_md", operation: "request", url: TRUSTED_HTTP_URL })).toBe("trusted");
});

test("classifyNetworkTrust: other valid methods are untrusted", () => {
	for (const method of UNTRUSTED_METHODS) {
		expect(classifyNetworkTrust(httpRequest(method))).toBe("untrusted");
		expect(classifyNetworkTrust({ toolName: "http_md", operation: "request", url: TRUSTED_HTTP_URL, method })).toBe("untrusted");
	}
});

test("classifyNetworkTrust: web_search is trusted", () => {
	expect(classifyNetworkTrust(request({ toolName: "web_search", operation: "search", query: "pi" }))).toBe("trusted");
});

test("classifyNetworkTrust: malformed requests are not classified as trusted", () => {
	const cases: unknown[] = [
		{ toolName: "http", operation: "request" },
		{ toolName: "http", operation: "request", url: "" },
		{ toolName: "http", operation: "request", url: "ftp://example.com" },
		{ toolName: "http", operation: "request", url: "https://user:pass@example.com" },
		{ toolName: "http", operation: "request", url: TRUSTED_HTTP_URL, method: "GE T" },
		{ toolName: "http", operation: "request", url: TRUSTED_HTTP_URL, method: 42 },
		{ toolName: "web_search", operation: "search", query: 42 },
		{ toolName: "web_search", operation: "request", query: "pi" },
		{ toolName: "curl", operation: "request", url: TRUSTED_HTTP_URL },
		undefined,
	];
	for (const value of cases) {
		expect(classifyNetworkTrust(value)).toBeUndefined();
	}
});

// ---------------------------------------------------------------------------
// Policy disposition matrix
// ---------------------------------------------------------------------------

test("dispositionForPolicy: complete five-policy decision matrix", () => {
	for (const policy of NETWORK_POLICIES) {
		for (const trust of ["trusted", "untrusted"] as const) {
			expect(dispositionForPolicy(policy, trust)).toBe(POLICY_MATRIX[policy][trust]);
		}
	}
});

test("evaluateNetworkPermission: complete matrix through valid requests", () => {
	const trusted = { toolName: "http", operation: "request", url: "https://example.com", method: "GET" };
	const untrusted = { toolName: "http", operation: "request", url: "https://example.com", method: "POST" };
	for (const policy of NETWORK_POLICIES) {
		expect(evaluateNetworkPermission({ request: trusted, policy }).action).toBe(POLICY_MATRIX[policy].trusted);
		expect(evaluateNetworkPermission({ request: untrusted, policy }).action).toBe(POLICY_MATRIX[policy].untrusted);
	}
});

// ---------------------------------------------------------------------------
// Evaluation fail-closed behavior
// ---------------------------------------------------------------------------

test("evaluateNetworkPermission: malformed requests block even under allow-all", () => {
	for (const policy of NETWORK_POLICIES) {
		const decision = evaluateNetworkPermission({ request: { toolName: "http", operation: "request" }, policy });
		expect(decision.action).toBe("block");
		expect(decision.reason).toContain("Invalid or unsupported");
	}
});

test("evaluateNetworkPermission: invalid policies fail closed", () => {
	for (const policy of [undefined, null, "bogus", 7]) {
		const decision = evaluateNetworkPermission({
			request: { toolName: "http", operation: "request", url: "https://example.com", method: "GET" },
			policy,
		});
		expect(decision.action).toBe("block");
		expect(decision.reason).toBe("Invalid network policy.");
	}
});

test("evaluateNetworkPermission: blocked and confirmed decisions carry reasons and summaries", () => {
	const blocked = evaluateNetworkPermission({
		request: { toolName: "http", operation: "request", url: "https://example.com", method: "POST" },
		policy: "deny-all",
	});
	expect(blocked.action).toBe("block");
	expect(blocked.reason).toContain("denies all");
	expect(blocked.summary).toBe("http: POST https://example.com/");

	const confirmed = evaluateNetworkPermission({
		request: { toolName: "web_search", operation: "search", query: "pi coding agent" },
		policy: "ask-all",
	});
	expect(confirmed.action).toBe("confirm");
	expect(confirmed.reason).toContain("requires approval");
	expect(confirmed.summary).toBe('web_search: "pi coding agent"');
});

test("evaluateNetworkPermission: allow decisions omit a reason", () => {
	const decision = evaluateNetworkPermission({
		request: { toolName: "http", operation: "request", url: "https://example.com" },
		policy: "allow-trusted",
	});
	expect(decision.action).toBe("allow");
	expect(decision.reason).toBeUndefined();
});

test("evaluateNetworkPermission: credentialed URLs block without leaking credentials", () => {
	const decision = evaluateNetworkPermission({
		request: { toolName: "http", operation: "request", url: "https://user:sup3rsecret@example.com/", method: "GET" },
		policy: "allow-all",
	});
	expect(decision.action).toBe("block");
	expect(decision.summary).toBeUndefined();
	expect(JSON.stringify(decision)).not.toContain("sup3rsecret");
});

test("summarizeNetworkRequest: identifies method and target/query", () => {
	expect(summarizeNetworkRequest({ toolName: "http", operation: "request", url: "https://example.com/a", method: "DELETE" })).toBe(
		"http: DELETE https://example.com/a",
	);
	expect(summarizeNetworkRequest({ toolName: "http_md", operation: "request", url: "https://example.com" })).toBe(
		"http_md: GET https://example.com/",
	);
	expect(summarizeNetworkRequest({ toolName: "web_search", operation: "search" })).toBe("web_search");
	expect(summarizeNetworkRequest({ toolName: "web_search", operation: "search", query: "a\nb" })).toBe('web_search: "a b"');
});

test("summarizeNetworkRequest: sanitizes every control character globally", () => {
	expect(
		summarizeNetworkRequest({ toolName: "web_search", operation: "search", query: "\u0000a\u0001b\u007fc\u001f" }),
	).toBe('web_search: "a b c"');
	expect(
		summarizeNetworkRequest({ toolName: "web_search", operation: "search", query: "x\u0085y\u009fz" }),
	).toBe('web_search: "x y z"');
});

test("summarizeNetworkRequest: never echoes a raw credentialed URL", () => {
	const summary = summarizeNetworkRequest({
		toolName: "http",
		operation: "request",
		url: "https://user:sup3rsecret@example.com/path",
		method: "GET",
	});
	expect(summary).toBe("http: GET");
	expect(summary).not.toContain("sup3rsecret");
});

// ---------------------------------------------------------------------------
// Auto derivation
// ---------------------------------------------------------------------------

test("deriveAutoNetworkPolicy: safe mode defaults", () => {
	expect(deriveAutoNetworkPolicy("paranoid")).toBe("ask-all");
	expect(deriveAutoNetworkPolicy("reader")).toBe("ask-all");
	expect(deriveAutoNetworkPolicy("smart")).toBe("ask-untrusted");
	expect(deriveAutoNetworkPolicy("yolo")).toBe("allow-trusted");
});

test("deriveAutoNetworkPolicy: non-canonical safe modes fail closed", () => {
	for (const safeMode of ["yolo+", "YOLO", "PARANOID", " paranoid ", "mystery", "", undefined, null, 42]) {
		expect(deriveAutoNetworkPolicy(safeMode)).toBe("ask-all");
	}
});

test("resolveNetworkPermissionState: Auto tracks safe mode", () => {
	for (const [safeMode, expected] of [
		["paranoid", "ask-all"],
		["reader", "ask-all"],
		["smart", "ask-untrusted"],
		["yolo", "allow-trusted"],
	] as const) {
		const state = resolveNetworkPermissionState({ configured: "auto", safeMode });
		expect(state).toEqual({
			configured: "auto",
			effective: expected,
			autoEffective: expected,
			overriddenByParanoid: safeMode === "paranoid",
		});
	}
});

test("resolveNetworkPermissionState: invalid or mixed-case safe modes fail closed instead of bypassing PARANOID", () => {
	for (const safeMode of ["yolo+", "YOLO", "PARANOID", " paranoid ", "mystery", "", undefined, null, 42]) {
		for (const configured of NETWORK_POLICY_SETTINGS) {
			const state = resolveNetworkPermissionState({ configured, safeMode });
			expect(state.configured).toBe(configured);
			expect(state.effective).toBe("ask-all");
			expect(state.overriddenByParanoid).toBe(true);
		}
	}
});

// ---------------------------------------------------------------------------
// PARANOID override and restoration
// ---------------------------------------------------------------------------

test("resolveNetworkPermissionState: PARANOID overrides every configured policy", () => {
	for (const configured of NETWORK_POLICY_SETTINGS) {
		const state = resolveNetworkPermissionState({ configured, safeMode: "paranoid" });
		expect(state.configured).toBe(configured);
		expect(state.effective).toBe("ask-all");
		expect(state.overriddenByParanoid).toBe(true);
	}
});

test("resolveNetworkPermissionState: leaving PARANOID restores the retained policy", () => {
	for (const configured of NETWORK_POLICY_SETTINGS.filter((setting) => setting !== "auto")) {
		const paranoid = resolveNetworkPermissionState({ configured, safeMode: "paranoid" });
		expect(paranoid.effective).toBe("ask-all");

		const restored = resolveNetworkPermissionState({ configured: paranoid.configured, safeMode: "smart" });
		expect(restored).toEqual({ configured, effective: configured, autoEffective: "ask-untrusted", overriddenByParanoid: false });
	}
});

test("resolveNetworkPermissionState: leaving PARANOID resumes Auto derivation", () => {
	const paranoid = resolveNetworkPermissionState({ configured: "auto", safeMode: "paranoid" });
	expect(paranoid.effective).toBe("ask-all");
	expect(paranoid.overriddenByParanoid).toBe(true);

	expect(resolveNetworkPermissionState({ configured: "auto", safeMode: "smart" })).toEqual({
		configured: "auto",
		effective: "ask-untrusted",
		autoEffective: "ask-untrusted",
		overriddenByParanoid: false,
	});
	expect(resolveNetworkPermissionState({ configured: "auto", safeMode: "yolo" })).toEqual({
		configured: "auto",
		effective: "allow-trusted",
		autoEffective: "allow-trusted",
		overriddenByParanoid: false,
	});
});

test("createInitialNetworkPermissionState: new sessions start at Auto", () => {
	expect(createInitialNetworkPermissionState("smart")).toEqual({
		configured: "auto",
		effective: "ask-untrusted",
		autoEffective: "ask-untrusted",
		overriddenByParanoid: false,
	});
});

test("resolveNetworkPermissionState: invalid configured settings fail closed", () => {
	expect(resolveNetworkPermissionState({ configured: "bogus" as never, safeMode: "smart" })).toEqual({
		configured: "ask-all",
		effective: "ask-all",
		autoEffective: "ask-untrusted",
		overriddenByParanoid: false,
	});
	expect(resolveNetworkPermissionState({ configured: "bogus" as never, safeMode: "paranoid" })).toEqual({
		configured: "ask-all",
		effective: "ask-all",
		autoEffective: "ask-all",
		overriddenByParanoid: true,
	});
});

// ---------------------------------------------------------------------------
// Serializable state
// ---------------------------------------------------------------------------

test("serialize/parse NetworkPermissionState: round trips", () => {
	const states = [
		{ configured: "auto", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: false },
		{ configured: "auto", effective: "ask-untrusted", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		{ configured: "auto", effective: "allow-trusted", autoEffective: "allow-trusted", overriddenByParanoid: false },
		{ configured: "allow-all", effective: "allow-all", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		{ configured: "allow-all", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: true },
	] as const;
	for (const state of states) {
		const json = serializeNetworkPermissionState(state);
		expect(JSON.parse(json)).toEqual(state);
		expect(parseNetworkPermissionState(JSON.parse(json))).toEqual(state);
		expect(deserializeNetworkPermissionState(json)).toEqual(state);
	}
});

test("parseNetworkPermissionState: accepts every canonical consistent state", () => {
	for (const configured of NETWORK_POLICY_SETTINGS) {
		const autoEffective = "ask-untrusted";
		const effective = configured === "auto" ? autoEffective : configured;
		expect(parseNetworkPermissionState({ configured, effective, autoEffective, overriddenByParanoid: false })).toEqual({
			configured,
			effective,
			autoEffective,
			overriddenByParanoid: false,
		});
		expect(
			parseNetworkPermissionState({
				configured,
				effective: "ask-all",
				autoEffective: "ask-all",
				overriddenByParanoid: true,
			}),
		).toEqual({ configured, effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: true });
	}
});

test("parseNetworkPermissionState: rejects inconsistent effective state", () => {
	const cases: unknown[] = [
		// Explicit choices must be effective verbatim without PARANOID.
		{ configured: "allow-trusted", effective: "allow-all", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		{ configured: "deny-all", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: false },
		{ configured: "allow-all", effective: "ask-untrusted", autoEffective: "ask-untrusted", overriddenByParanoid: false },
		// Auto can only derive ask-all / ask-untrusted / allow-trusted.
		{ configured: "auto", effective: "deny-all", autoEffective: "deny-all", overriddenByParanoid: false },
		{ configured: "auto", effective: "allow-all", autoEffective: "allow-all", overriddenByParanoid: false },
		// Auto's effective policy must match its derived policy.
		{ configured: "auto", effective: "ask-untrusted", autoEffective: "allow-trusted", overriddenByParanoid: false },
		// PARANOID (and fail-closed unknown modes) must be ask-all everywhere.
		{ configured: "auto", effective: "allow-all", autoEffective: "allow-all", overriddenByParanoid: true },
		{ configured: "allow-all", effective: "allow-trusted", autoEffective: "ask-all", overriddenByParanoid: true },
		{ configured: "allow-all", effective: "ask-all", autoEffective: "allow-trusted", overriddenByParanoid: true },
		// autoEffective itself must be derivable.
		{ configured: "allow-all", effective: "allow-all", autoEffective: "deny-all", overriddenByParanoid: false },
	];
	for (const value of cases) {
		expect(parseNetworkPermissionState(value)).toBeUndefined();
	}
});

test("parseNetworkPermissionState: rejects malformed or inconsistent state", () => {
	const cases: unknown[] = [
		undefined,
		null,
		"auto",
		[],
		{},
		{ configured: "bogus", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: false },
		{ configured: "auto", effective: "bogus", autoEffective: "ask-all", overriddenByParanoid: false },
		{ configured: "auto", effective: "ask-all", autoEffective: "bogus", overriddenByParanoid: false },
		{ configured: "auto", effective: "ask-all", overriddenByParanoid: false },
		{ configured: "auto", effective: "ask-all", autoEffective: "ask-all", overriddenByParanoid: "no" },
		{ configured: "auto", effective: "allow-all", autoEffective: "allow-all", overriddenByParanoid: true },
	];
	for (const value of cases) {
		expect(parseNetworkPermissionState(value)).toBeUndefined();
	}
	expect(deserializeNetworkPermissionState("not json")).toBeUndefined();
});
