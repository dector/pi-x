// Pure review-level policy shared by command, prompt, persistence, and tests.

export const REVIEW_LEVELS = ["auto", "off", "minimal", "normal", "high"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

export const DEFAULT_REVIEW_LEVEL: ReviewLevel = "auto";

export const REVIEW_LEVEL_LABELS: Record<ReviewLevel, string> = {
	auto: "Auto",
	off: "Off",
	minimal: "Minimal",
	normal: "Normal",
	high: "High",
};

export const REVIEW_LEVEL_ICONS: Record<ReviewLevel, string> = {
	auto: "󰈈", // md-eye
	off: "󰛑", // md-eye-off-outline
	minimal: "󱀧", // md-eye-minus-outline
	normal: "󰛐", // md-eye-outline
	high: "󰡬", // md-eye-plus-outline
};

export const REVIEW_LEVEL_DESCRIPTIONS: Record<ReviewLevel, string> = {
	auto: "No preference; let the agent choose the appropriate review effort",
	off: "Prefer the first working implementation without a separate review pass",
	minimal: "Review only when clearly necessary; small implementation issues are acceptable",
	normal: "Use one review pass for most non-trivial changes",
	high: "Polish the change and resolve critical or important review findings",
};

export const REVIEW_LEVEL_GUIDANCE: Record<Exclude<ReviewLevel, "auto">, string> = {
	off:
		"The user recommends review level OFF. Prefer the first working implementation: run normal relevant tests, but do not launch reviewer subagents or perform a separate review pass unless needed to avoid an obvious critical correctness or security issue.",
	minimal:
		"The user recommends review level MINIMAL. Review only when the change's risk or complexity clearly warrants it. A working implementation with passing relevant tests is sufficient; small non-critical implementation issues are acceptable.",
	normal:
		"The user recommends review level NORMAL. For most non-trivial changes, perform one proportionate review pass. Address clear correctness and maintainability issues, but avoid repeated polishing passes unless they are justified.",
	high:
		"The user recommends review level HIGH. Treat the change as polished work: perform a dedicated review pass and resolve critical and important findings. Repeat review when needed to ensure no such findings remain.",
};

export function parseReviewLevel(value: unknown): ReviewLevel | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return REVIEW_LEVELS.find((level) => level === normalized);
}

export function reviewGuidance(level: ReviewLevel): string | undefined {
	return level === "auto" ? undefined : REVIEW_LEVEL_GUIDANCE[level];
}

export function reviewStatusIcon(level: ReviewLevel): string {
	return REVIEW_LEVEL_ICONS[level];
}
