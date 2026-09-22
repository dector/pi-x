export const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
export const SUBAGENT_REMAINING_DEPTH_ENV = "PI_SUBAGENT_REMAINING_DEPTH";
export const DEFAULT_SUBAGENT_DEPTH = 0;
export const MIN_SUBAGENT_DEPTH = -1;
export const MAX_SUBAGENT_DEPTH = 8;

/**
 * Maximum recursive delegation depth for this process.
 * -1 disables delegation, 0 permits only this process to delegate, and each
 * positive value permits one additional recursive generation.
 */
export function parseSubagentDepth(value: string | undefined, fallback = DEFAULT_SUBAGENT_DEPTH): number {
	if (value === undefined || !/^-?\d+$/.test(value.trim())) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) return fallback;
	return Math.max(MIN_SUBAGENT_DEPTH, Math.min(MAX_SUBAGENT_DEPTH, parsed));
}

export function initialSubagentDepth(env: Record<string, string | undefined>, isChild: boolean): number {
	return parseSubagentDepth(
		isChild ? env[SUBAGENT_REMAINING_DEPTH_ENV] : env[SUBAGENT_DEPTH_ENV],
		isChild ? MIN_SUBAGENT_DEPTH : DEFAULT_SUBAGENT_DEPTH,
	);
}

export function childSubagentDepth(parentDepth: number): number {
	return Math.max(MIN_SUBAGENT_DEPTH, parentDepth - 1);
}

export function canDelegate(depth: number): boolean {
	return depth >= 0;
}

export function formatSubagentDepth(depth: number): string {
	if (depth < 0) return "Disabled";
	if (depth === 0) return "Top level only";
	return `${depth} recursive level${depth === 1 ? "" : "s"}`;
}
