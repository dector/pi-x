import { createReason } from "../../reasons";
import type { BashMatcher } from "../../types";

export const parseErrorMatcher: BashMatcher = {
	id: "structural/parse-error",
	priority: 10,
	evaluate(ctx) {
		if (ctx.analysis.parse.ok) return undefined;
		if (ctx.analysis.parse.kind === "empty") {
			return { action: "confirm", reasons: [createReason({ code: "empty-command", matcherId: this.id })] };
		}
		if (ctx.analysis.parse.kind === "line-continuation") {
			return { action: "confirm", reasons: [createReason({ code: "line-continuation", matcherId: this.id })] };
		}
		return { action: "confirm", reasons: [createReason({ code: "parse-error", matcherId: this.id })] };
	},
};
