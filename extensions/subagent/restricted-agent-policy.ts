/**
 * Pure restricted-agent policy helpers.
 *
 * "Restricted" agents are profiles the model must not auto-select: expensive or
 * explicit-only tiers such as `reviewer-ultra-explicit`. This module owns the
 * defaults, glob matching, request collection, alternative ranking, and config
 * parsing.
 *
 * It deliberately imports nothing from the filesystem or the Pi runtime, so the
 * policy stays cheap to unit test. The file-backed loader lives in
 * `restricted-agent-config.ts`.
 */

/** Restricted by default: every strong and explicit-tier agent. */
export const DEFAULT_RESTRICTED_AGENT_PATTERNS: readonly string[] = ["*-strong", "*-explicit"];

/** Default prompt timeout (seconds) applied to restricted agents. */
export const DEFAULT_RESTRICTED_AGENT_PROMPT_TIMEOUT_SECONDS = 15;

/**
 * Known tier suffixes in preference order.
 *
 * Lower index = cheaper/less-capable tier, so a same-family alternative earlier
 * in this list is suggested before one later in the list. `xultra-explicit` is
 * intentionally last: it is the most restricted tier.
 */
export const AGENT_TIER_SUFFIXES: readonly string[] = [
	"xfast",
	"fast",
	"strong",
	"strong-explicit",
	"ultra-explicit",
	"xultra-explicit",
];

/** Resolved restricted-agent policy, with individual fields already defaulted. */
export interface RestrictedAgentPolicy {
	/** Glob patterns whose matching agent names are restricted. */
	restrictedAgentPatterns: string[];
	/** Seconds to wait for a restricted-agent prompt before giving up. */
	restrictedAgentPromptTimeoutSeconds: number;
}

/** A fresh policy populated entirely from defaults. */
export function defaultRestrictedAgentPolicy(): RestrictedAgentPolicy {
	return {
		restrictedAgentPatterns: [...DEFAULT_RESTRICTED_AGENT_PATTERNS],
		restrictedAgentPromptTimeoutSeconds: DEFAULT_RESTRICTED_AGENT_PROMPT_TIMEOUT_SECONDS,
	};
}

function escapeRegExpChar(char: string): string {
	return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * Translate a glob to an anchored regexp. `*` matches any run of characters
 * (including `-`), `?` matches exactly one, and everything else is literal.
 */
function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (const char of pattern) {
		if (char === "*") source += ".*";
		else if (char === "?") source += ".";
		else source += escapeRegExpChar(char);
	}
	return new RegExp(`${source}$`);
}

/** True when `name` matches a single glob `pattern`. */
export function matchesRestrictedPattern(name: string, pattern: string): boolean {
	return globToRegExp(pattern).test(name);
}

/** True when `name` matches at least one restricted glob pattern. */
export function isAgentNameRestricted(name: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => matchesRestrictedPattern(name, pattern));
}

/**
 * Collect requested names that match a restricted pattern, preserving first
 * occurrence order and dropping duplicates. Non-restricted names are ignored.
 */
export function collectRestrictedAgentNames(
	requestedNames: readonly string[],
	patterns: readonly string[],
): string[] {
	const seen = new Set<string>();
	const restricted: string[] = [];
	for (const name of requestedNames) {
		if (seen.has(name)) continue;
		seen.add(name);
		if (isAgentNameRestricted(name, patterns)) restricted.push(name);
	}
	return restricted;
}

/**
 * Longest known tier suffix on `name`, or `undefined` when it has none.
 *
 * Longest wins so `reviewer-xultra-explicit` strips `xultra-explicit` rather
 * than the shorter `ultra-explicit` it also ends with.
 */
function findTierSuffix(name: string): string | undefined {
	let best: string | undefined;
	for (const suffix of AGENT_TIER_SUFFIXES) {
		if (!name.endsWith(`-${suffix}`)) continue;
		if (!best || suffix.length > best.length) best = suffix;
	}
	return best;
}

/** Role/family of an agent name: the name with any known tier suffix removed. */
export function agentFamily(name: string): string {
	const suffix = findTierSuffix(name);
	return suffix ? name.slice(0, name.length - suffix.length - 1) : name;
}

/**
 * Preference rank for an agent's tier suffix (`xfast` = 0, `xultra-explicit`
 * = 5), or `undefined` when the name carries no known tier suffix.
 */
export function agentTierRank(name: string): number | undefined {
	const suffix = findTierSuffix(name);
	return suffix ? AGENT_TIER_SUFFIXES.indexOf(suffix) : undefined;
}

/**
 * Suggest unrestricted agents as alternatives to a restricted `requestedName`.
 *
 * Same family/role agents come first, ordered by tier rank (cheapest first). If
 * a same-family name has no known tier suffix it sorts after every tiered name.
 * All other unrestricted agents follow in discovery order. Names are deduped
 * and the requested name is never suggested.
 */
export function suggestUnrestrictedAgents(
	requestedName: string,
	agents: readonly { name: string }[],
	patterns: readonly string[],
): string[] {
	const family = agentFamily(requestedName);
	const seen = new Set<string>();
	const sameFamily: Array<{ name: string; rank: number; order: number }> = [];
	const others: string[] = [];

	for (const [order, agent] of agents.entries()) {
		const name = agent.name;
		if (seen.has(name)) continue;
		seen.add(name);
		if (name === requestedName) continue;
		if (isAgentNameRestricted(name, patterns)) continue;

		if (agentFamily(name) === family) {
			// No suffix ranks after every known tier rather than before it.
			sameFamily.push({ name, rank: agentTierRank(name) ?? AGENT_TIER_SUFFIXES.length, order });
		} else {
			others.push(name);
		}
	}

	sameFamily.sort((a, b) => a.rank - b.rank || a.order - b.order);
	return [...sameFamily.map((entry) => entry.name), ...others];
}

function parsePatterns(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const patterns: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return undefined;
		const trimmed = entry.trim();
		if (trimmed.length === 0) return undefined;
		patterns.push(trimmed);
	}
	return patterns;
}

function parseTimeoutSeconds(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return value;
}

/**
 * Parse a raw config value into a fully-defaulted policy.
 *
 * A missing, non-object, or invalid field falls back to its own default. An
 * explicit `restrictedAgentPatterns: []` is valid and disables restrictions.
 */
export function parseRestrictedAgentConfig(value: unknown): RestrictedAgentPolicy {
	const policy = defaultRestrictedAgentPolicy();
	if (typeof value !== "object" || value === null || Array.isArray(value)) return policy;

	const record = value as Record<string, unknown>;
	const patterns = parsePatterns(record.restrictedAgentPatterns);
	if (patterns !== undefined) policy.restrictedAgentPatterns = patterns;

	const timeout = parseTimeoutSeconds(record.restrictedAgentPromptTimeoutSeconds);
	if (timeout !== undefined) policy.restrictedAgentPromptTimeoutSeconds = timeout;

	return policy;
}
