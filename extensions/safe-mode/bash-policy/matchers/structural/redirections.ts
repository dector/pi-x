import { createReason } from "../../reasons";
import type { BashMatcher } from "../../types";

export const redirectionsMatcher: BashMatcher = {
	id: "structural/redirections",
	priority: 20,
	evaluate(ctx) {
		const reasons = [];
		if (ctx.analysis.structure.hasInputRedirection) {
			reasons.push(createReason({ code: "input-redirection", matcherId: this.id }));
		}
		if (ctx.analysis.structure.hasOutputRedirection) {
			reasons.push(createReason({ code: "output-redirection", matcherId: this.id }));
		}
		if (reasons.length === 0) return undefined;
		return { action: "confirm", reasons };
	},
};
