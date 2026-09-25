import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/**
 * Runtime values `/reset` needs from sibling extensions, mirrored locally so a
 * missing sibling degrades to a warning instead of a module-load failure.
 *
 * `contract.test.ts` compares each value to its canonical owner, so these
 * mirrors cannot silently drift.
 */
export const RESET_CONTRACT = {
	/** Canonical owner: `extensions/subagent/rewire.ts` `THINKING_LEVELS`. */
	thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as readonly ThinkingLevel[],
	/** Canonical owner: `extensions/proc/stop-all.ts` event constants. */
	procStopAllRequestEvent: "px:proc:stop-all:request",
	procStopAllReplyEvent: "px:proc:stop-all:reply",
	procStopAllMaxWaitMs: 4_000,
} as const;
