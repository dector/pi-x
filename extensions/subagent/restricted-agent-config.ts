/**
 * File-backed global restricted-agent config loader.
 *
 * Reads only `path.join(getAgentDir(), "subagent.json")`. Project-local config
 * is never consulted: agent restrictions are a user-level safety policy, so a
 * repository must not be able to weaken them.
 *
 * Parsing lives in the pure `restricted-agent-policy.ts`; this module is only
 * responsible for locating and reading the file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	defaultRestrictedAgentPolicy,
	parseRestrictedAgentConfig,
	type RestrictedAgentPolicy,
} from "./restricted-agent-policy.ts";

/** Global user config filename under the agent directory. */
export const RESTRICTED_AGENT_CONFIG_FILE = "subagent.json";

/** Global config path for the given agent directory. */
export function restrictedAgentConfigPath(agentDir: string): string {
	return join(agentDir, RESTRICTED_AGENT_CONFIG_FILE);
}

/**
 * Load the global restricted-agent policy. A missing file, unreadable file, or
 * invalid JSON yields defaults; invalid fields fall back individually.
 */
export function loadRestrictedAgentConfig(agentDir: string = getAgentDir()): RestrictedAgentPolicy {
	let raw: string;
	try {
		raw = readFileSync(restrictedAgentConfigPath(agentDir), "utf8");
	} catch {
		return defaultRestrictedAgentPolicy();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return defaultRestrictedAgentPolicy();
	}

	return parseRestrictedAgentConfig(parsed);
}
