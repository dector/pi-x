// Skill read counter for the status bar first line. Collected internally by
// status-bar (it is the only consumer), so no producer event contract is needed.
//
// No pi runtime or TUI imports: the tracker takes the event fields it needs, so
// tests can drive it without a session.

import { basename, isAbsolute, resolve } from "node:path";

const ANSI_RESET = "\u001b[0m";
const ANSI_GRAY = "\u001b[90m";

/** Nerd Font `U+F0431` (skills) plus its separating space. */
export const SKILL_STATS_ICON = "\u{F0431} ";

/** Unique `SKILL.md` files read this session, over the skills pi loaded. */
export interface SkillStats {
	read: number;
	loaded: number;
}

/** First-line label: `󰐱 2/7`, grayed out in the UI. */
export function renderSkillStatsLabel(stats: SkillStats, hasUI: boolean): string {
	const text = `${SKILL_STATS_ICON}${stats.read}/${stats.loaded}`;
	return hasUI ? `${ANSI_GRAY}${text}${ANSI_RESET}` : text;
}

/** The number of skills pi loaded, from a `systemPromptOptions` payload. */
export function countLoadedSkills(systemPromptOptions: unknown): number {
	if (!systemPromptOptions || typeof systemPromptOptions !== "object") return 0;
	const skills = (systemPromptOptions as { skills?: unknown }).skills;
	return Array.isArray(skills) ? skills.length : 0;
}

/**
 * The skill count pi reports for a session context. Older hosts may not expose
 * the accessor, which reads as zero loaded skills.
 */
export function countSessionSkills(ctx: object): number {
	const getOptions = (ctx as { getSystemPromptOptions?: () => unknown }).getSystemPromptOptions;
	if (typeof getOptions !== "function") return 0;
	return countLoadedSkills(getOptions.call(ctx));
}

interface ReadToolInput {
	path?: unknown;
}

/** The `path` argument of a read tool call, when it is a usable string. */
export function getReadToolPath(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const maybe = input as ReadToolInput;
	return typeof maybe.path === "string" && maybe.path.trim().length > 0 ? maybe.path : undefined;
}

function isSkillPath(absolutePath: string): boolean {
	return basename(absolutePath) === "SKILL.md";
}

/**
 * Counts unique successfully-read `SKILL.md` files for the current session.
 * The host feeds it the session events that can change the count and gets a
 * fresh snapshot whenever one of them does.
 */
export class SkillStatsTracker {
	private readonly readPaths = new Set<string>();
	private loaded = 0;
	private lastReported = "";

	constructor(private readonly onChange: (stats: SkillStats) => void) {}

	/** Live counters for the current session. */
	snapshot(): SkillStats {
		return { read: this.readPaths.size, loaded: this.loaded };
	}

	/** Counted absolute `SKILL.md` paths, sorted for stable debug output. */
	readPathsList(): string[] {
		return [...this.readPaths].sort();
	}

	/** Drop all session state; the next publish starts from zero. */
	reset(): void {
		this.readPaths.clear();
		this.loaded = 0;
		this.lastReported = "";
	}

	/** Start a session with the skill count pi reported for it. */
	startSession(loaded: number): void {
		this.reset();
		this.setLoaded(loaded);
	}

	/** Refresh the denominator before an agent run. */
	setLoaded(loaded: number): void {
		if (!Number.isFinite(loaded) || loaded === this.loaded) return;
		this.loaded = loaded;
		this.publish();
	}

	/**
	 * Count one successful read. `cwd` resolves relative read paths; anything
	 * that is not a `SKILL.md` read (or a repeat of one already counted) is a
	 * no-op.
	 */
	recordRead(args: { toolName: string; isError: boolean; input: unknown; cwd: string }): void {
		if (args.toolName !== "read" || args.isError) return;
		const readPath = getReadToolPath(args.input);
		if (!readPath) return;

		const absolutePath = isAbsolute(readPath) ? resolve(readPath) : resolve(args.cwd, readPath);
		if (!isSkillPath(absolutePath)) return;
		const before = this.readPaths.size;
		this.readPaths.add(absolutePath);
		if (this.readPaths.size !== before) this.publish();
	}

	private publish(): void {
		const stats = this.snapshot();
		const signature = `${stats.read}/${stats.loaded}`;
		if (signature === this.lastReported) return;
		this.lastReported = signature;
		this.onChange(stats);
	}
}
