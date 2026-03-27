import { createReason } from "../../reasons";
import type { BashMatcher } from "../../types";

export const readOnlyAllowMatcher: BashMatcher = {
	id: "structural/read-only-allow",
	priority: 60,
	evaluate(ctx) {
		if (ctx.analysis.commandCount === 0) return undefined;
		if (!ctx.classification.anyReadLike) return undefined;
		if (!ctx.classification.allReadOnly) return undefined;
		return {
			action: "allow",
			reasons: [createReason({ code: "read-only-command", matcherId: this.id })],
		};
	},
};
