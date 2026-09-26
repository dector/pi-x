/**
 * Pure agent-frontmatter parsing.
 *
 * Split out of `agents.ts` so it can be unit tested without importing the Pi
 * runtime (the local `node_modules` SDK copy is older than the runtime and does
 * not export everything `agents.ts` needs). This module imports only types from
 * the SDK, which are erased at runtime.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isSubagentFunction, isSubagentLevel, type SubagentFunction, type SubagentLevel } from "./model-mapping.ts";

/** Normalized agent frontmatter fields. `name`/`description` are required. */
export interface AgentFields {
	name: string;
	description: string;
	shortDescription?: string;
	tools?: string[];
	function?: SubagentFunction;
	level?: SubagentLevel;
	model?: string;
	thinking?: ThinkingLevel;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
export function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

/**
 * Normalize a frontmatter `thinking` value to a valid pi thinking level.
 *
 * The CLI already clamps unsupported levels, but rejecting junk here keeps
 * agent discovery from silently passing a typo through as a real level.
 */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
		? (value as ThinkingLevel)
		: undefined;
}

/**
 * Normalize raw frontmatter into agent fields. Returns `undefined` when the
 * required `name`/`description` are missing, which lets discovery skip the file
 * rather than register a nameless agent.
 */
export function parseAgentFields(frontmatter: Record<string, unknown>): AgentFields | undefined {
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		shortDescription:
			typeof frontmatter.short_description === "string" ? frontmatter.short_description : undefined,
		tools: parseToolList(frontmatter.tools),
		function: isSubagentFunction(frontmatter.function) ? frontmatter.function : undefined,
		level: isSubagentLevel(frontmatter.level) ? frontmatter.level : undefined,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: parseThinkingLevel(frontmatter.thinking),
	};
}
