import type { BashMatcher, BashMatcherContext, BashPolicyDecision } from "./types";

export function runMatcherRegistry(args: {
	matchers: readonly BashMatcher[];
	ctx: BashMatcherContext;
}): Omit<BashPolicyDecision, "analysis"> {
	const sorted = [...args.matchers].sort((a, b) => a.priority - b.priority);

	for (const matcher of sorted) {
		const result = matcher.evaluate(args.ctx);
		if (!result) continue;
		return {
			action: result.action,
			reasons: result.reasons,
			matchedBy: [matcher.id],
		};
	}

	return {
		action: "confirm",
		reasons: [],
		matchedBy: [],
	};
}
