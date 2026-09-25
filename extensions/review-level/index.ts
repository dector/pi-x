import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_REVIEW_LEVEL,
	parseReviewLevel,
	REVIEW_LEVEL_DESCRIPTIONS,
	REVIEW_LEVEL_ICONS,
	REVIEW_LEVEL_LABELS,
	REVIEW_LEVELS,
	reviewGuidance,
	type ReviewLevel,
} from "./policy";

const ENTRY_TYPE = "review-level";
const PROMPT_SECTION = "review_recommendation";
const STATUS_BAR_REVIEW_SET_EVENT = "px:status-bar:review-level:set";
const STATUS_BAR_REVIEW_CLEAR_EVENT = "px:status-bar:review-level:clear";
const CACHE_PRESERVED_ICON = "󰄬";

interface CustomEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function restoreReviewLevel(ctx: ExtensionContext): ReviewLevel {
	let level = DEFAULT_REVIEW_LEVEL;
	for (const entry of ctx.sessionManager.getBranch() as CustomEntryLike[]) {
		if (!entry || entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			level = DEFAULT_REVIEW_LEVEL;
			continue;
		}
		level = parseReviewLevel((data as { level?: unknown }).level) ?? DEFAULT_REVIEW_LEVEL;
	}
	return level;
}

function pickerRows(): string[] {
	return REVIEW_LEVELS.map(
		(level) => `${REVIEW_LEVEL_ICONS[level]}  ${REVIEW_LEVEL_LABELS[level]} — ${REVIEW_LEVEL_DESCRIPTIONS[level]}`,
	);
}

function levelFromPickerRow(row: string | undefined): ReviewLevel | undefined {
	if (!row) return undefined;
	return REVIEW_LEVELS.find((level) => row === pickerRows()[REVIEW_LEVELS.indexOf(level)]);
}

function supportsPromptPatching(ctx: ExtensionContext): boolean {
	const compat = ctx.model?.compat;
	return !!compat && "supportsMidConvoSystemMessages" in compat && compat.supportsMidConvoSystemMessages === true;
}

function pickerTitle(ctx: ExtensionContext): string {
	if (supportsPromptPatching(ctx)) {
		const notice = `${CACHE_PRESERVED_ICON} System prompt patching is supported; changing this setting will not invalidate the LLM prompt cache.`;
		return `Recommended review level\n${ctx.ui.theme.fg("success", notice)}`;
	}
	return `Recommended review level\n${ctx.ui.theme.fg("error", "Changing this setting might invalidate the LLM prompt cache.")}`;
}

export default function reviewLevelExtension(pi: ExtensionAPI): void {
	let level: ReviewLevel = DEFAULT_REVIEW_LEVEL;

	const publish = (): void => {
		pi.events.emit(STATUS_BAR_REVIEW_SET_EVENT, { level });
	};

	const restore = (ctx: ExtensionContext): void => {
		level = restoreReviewLevel(ctx);
		publish();
	};

	const setLevel = (next: ReviewLevel): boolean => {
		if (next === level) return false;
		level = next;
		pi.appendEntry(ENTRY_TYPE, { level });
		publish();
		return true;
	};

	const unsubscribeRenewRequest = pi.events.on("px:renew:settings:request", (payload) => {
		if (!payload || typeof payload !== "object") return;
		const request = payload as { id?: unknown; sourceSessionId?: unknown; cwd?: unknown };
		if (typeof request.id !== "string" || request.sourceSessionId !== currentSessionId || request.cwd !== currentCwd) return;
		pi.events.emit("px:renew:settings:response", { id: request.id, owner: "review-level", sourceSessionId: request.sourceSessionId, cwd: request.cwd, state: { level } });
	});
	let currentSessionId: string | undefined;
	let currentCwd: string | undefined;
	const unsubscribeRenewApply = pi.events.on("px:renew:settings:apply", (payload) => {
		if (!payload || typeof payload !== "object") return;
		const request = payload as { transferId?: unknown; owner?: unknown; targetSessionId?: unknown; cwd?: unknown; state?: unknown };
		if (typeof request.transferId !== "string" || request.owner !== "review-level" || request.targetSessionId !== currentSessionId || request.cwd !== currentCwd) return;
		const next = parseReviewLevel((request.state as { level?: unknown } | undefined)?.level);
		if (!next) return;
		setLevel(next);
		pi.events.emit("px:renew:settings:ack", { transferId: request.transferId, owner: "review-level", targetSessionId: request.targetSessionId, cwd: request.cwd });
	});

	pi.on("session_start", async (_event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		currentCwd = ctx.cwd;
		restore(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		currentCwd = ctx.cwd;
		restore(ctx);
	});

	pi.on("before_agent_start", (event) => {
		const guidance = reviewGuidance(level);
		if (guidance) {
			event.systemPromptOptions.sections[PROMPT_SECTION] = guidance;
		} else {
			delete event.systemPromptOptions.sections[PROMPT_SECTION];
		}
	});

	pi.on("session_shutdown", () => {
		unsubscribeRenewRequest();
		unsubscribeRenewApply();
		currentSessionId = undefined;
		currentCwd = undefined;
		pi.events.emit(STATUS_BAR_REVIEW_CLEAR_EVENT, undefined);
		level = DEFAULT_REVIEW_LEVEL;
	});

	pi.registerCommand("px:review", {
		description: "Set recommended review level: auto, off, minimal, normal, or high",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = REVIEW_LEVELS.filter((candidate) => candidate.startsWith(normalized)).map((candidate) => ({
				value: candidate,
				label: candidate,
				description: REVIEW_LEVEL_DESCRIPTIONS[candidate],
			}));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			let selected: ReviewLevel | undefined;

			if (raw) {
				selected = parseReviewLevel(raw);
				if (!selected) {
					if (ctx.hasUI) ctx.ui.notify("Usage: /px:review [auto|off|minimal|normal|high]", "warning");
					return;
				}
			} else if (ctx.hasUI) {
				const rows = pickerRows();
				const choice = await ctx.ui.select(pickerTitle(ctx), rows);
				selected = levelFromPickerRow(choice);
				if (!selected) return;
			} else {
				return;
			}

			const changed = setLevel(selected);
			if (ctx.hasUI) {
				const state = changed ? "set to" : "already";
				ctx.ui.notify(`Recommended review level ${state} ${REVIEW_LEVEL_LABELS[selected]}.`, "info");
			}
		},
	});
}
