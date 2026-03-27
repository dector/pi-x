import { createReason } from "../../reasons";
import type { BashMatcher } from "../../types";

export const unknownCommandMatcher: BashMatcher = {
	id: "structural/unknown-command",
	priority: 40,
	evaluate(ctx) {
		if (!ctx.classification.hasUnknownCommand) return undefined;
		const unknown = ctx.classification.details.find((detail) => detail.kind === "unknown");
		return {
			action: "confirm",
			reasons: [
				createReason({
					code: "unknown-command",
					matcherId: this.id,
					commandIndex: unknown?.commandIndex,
					program: unknown?.program,
				}),
			],
		};
	},
};
