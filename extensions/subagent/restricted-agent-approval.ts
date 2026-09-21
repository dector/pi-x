/**
 * Parent-side approval prompt for restricted-agent dispatches.
 *
 * `prepare.ts` decides *whether* a request needs approval and collects the
 * restricted names, patterns, and alternatives; this module owns the *UI*: it
 * renders one confirm dialog per dispatch and routes it through
 * `withUserWait` so Herdr/hub report the parent as blocked while the user
 * decides.
 *
 * It accepts a ctx-like `{ hasUI, ui }` surface rather than the whole
 * `ExtensionContext` so it stays loadable from `bun test` and does not import
 * `index.ts`.
 */

import type { RestrictedAgentApprovalRequest } from "./prepare.ts";
import { withUserWait, type UserWaitEventBus } from "./user-wait.ts";

/** Minimal ctx-like surface needed to show the parent confirm dialog. */
export interface RestrictedAgentApprovalContext {
	/** Whether interactive UI is available (false in print/RPC mode). */
	hasUI: boolean;
	ui: {
		confirm(title: string, message: string, options?: { timeout?: number }): Promise<boolean>;
	};
}

/** Rendered prompt text plus the user-wait label. */
export interface RestrictedAgentApprovalPrompt {
	title: string;
	message: string;
	label: string;
}

function plural(count: number): string {
	return count === 1 ? "" : "s";
}

/**
 * Build the confirm dialog text. It must make the scope obvious: exactly which
 * restricted names are requested, which patterns matched them, what is allowed
 * instead, that approval is not remembered, and when it auto-denies.
 */
export function formatRestrictedAgentApprovalPrompt(
	request: RestrictedAgentApprovalRequest,
	timeoutSeconds: number,
): RestrictedAgentApprovalPrompt {
	const restricted = request.restrictedAgents.join(", ");
	const patterns = request.patterns.length > 0 ? request.patterns.join(", ") : "(none)";
	const alternatives = request.alternatives.length > 0 ? request.alternatives.join(", ") : "none";
	const seconds = `${timeoutSeconds} second${plural(timeoutSeconds)}`;

	return {
		title: `Approve restricted agent${plural(request.restrictedAgents.length)}?`,
		message: [
			`Mode: ${request.mode}`,
			`Restricted agent${plural(request.restrictedAgents.length)}: ${restricted}`,
			`Matching patterns: ${patterns}`,
			`Allowed alternatives: ${alternatives}`,
			"Approval is for this dispatch only and is not remembered.",
			`Auto-denies after ${seconds} without an answer.`,
		].join("\n"),
		label: `restricted agents: ${restricted}`,
	};
}

/**
 * Ask the parent user to approve the restricted agents in one dispatch.
 *
 * Returns `false` without touching the UI or declaring a wait when no UI is
 * available, so print/RPC sessions fail closed. With UI, declares a
 * user-wait (cleared on approve, deny, timeout, or throw) and shows one timed
 * confirm dialog. Only an explicit `true` allows the dispatch.
 */
export async function requestRestrictedAgentApproval(
	request: RestrictedAgentApprovalRequest,
	timeoutSeconds: number,
	ctx: RestrictedAgentApprovalContext | undefined,
	events: UserWaitEventBus,
): Promise<boolean> {
	if (!ctx?.hasUI) return false;

	const prompt = formatRestrictedAgentApprovalPrompt(request, timeoutSeconds);
	return withUserWait(events, { owner: "subagent", kind: "approval", label: prompt.label }, () =>
		ctx.ui.confirm(prompt.title, prompt.message, { timeout: timeoutSeconds * 1000 }),
	);
}
