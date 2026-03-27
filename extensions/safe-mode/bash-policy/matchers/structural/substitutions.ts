import { createReason } from "../../reasons";
import type { BashMatcher } from "../../types";

export const substitutionsMatcher: BashMatcher = {
	id: "structural/substitutions",
	priority: 30,
	evaluate(ctx) {
		if (!ctx.analysis.structure.hasSubstitution) return undefined;
		return {
			action: "confirm",
			reasons: [createReason({ code: "command-substitution", matcherId: this.id })],
		};
	},
};
