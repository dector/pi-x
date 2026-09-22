/**
 * Shared status glyphs for the subagent surfaces.
 *
 * The `/px:agents` list and the above-editor active-subagents widget must read
 * the same, so the Nerd Font Material Design glyphs and their theme tones live
 * here once. `running`/`paused` deliberately use the plain `play`/`pause`
 * glyphs (no ring) so they do not look like selection markers next to the
 * outcome checks.
 *
 * This module is pure data with no Pi runtime imports so both surfaces (and
 * `bun test`) can load it cheaply.
 */

/** Coarse run/batch outcome driving the status glyph and its tone. */
export type ManagerRunOutcome = "running" | "paused" | "blocked" | "finished" | "failed" | "canceled";

/** Status glyphs, chosen to match the widget's existing robot icon family. */
export const MANAGER_ICONS = {
	batch: "\u{f06a9}", // md-robot
	running: "\u{f040a}", // md-play
	paused: "\u{f03e4}", // md-pause
	blocked: "\u{f1238}", // md-exclamation_thick
	finished: "\u{f012c}", // md-check
	failed: "\u{f0156}", // md-close
	canceled: "\u{f073a}", // md-cancel
	async: "\u{f140b}", // md-lightning_bolt
	blocking: "\u{f097f}", // md-lock_clock
	herdr: "\u{f05b2}", // md-window_restore
} as const;

/** Theme tone per outcome. `blocked` is deliberately the loudest. */
export const MANAGER_OUTCOME_TONE: Record<ManagerRunOutcome, "success" | "warning" | "error" | "muted"> = {
	running: "success",
	paused: "warning",
	blocked: "error",
	finished: "success",
	failed: "error",
	canceled: "warning",
};
