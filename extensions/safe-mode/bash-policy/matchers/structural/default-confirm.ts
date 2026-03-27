import { createReason } from "../../reasons";
import type { BashMatcher } from "../../types";

export const defaultConfirmMatcher: BashMatcher = {
	id: "structural/default-confirm",
	priority: 1000,
	evaluate() {
		return {
			action: "confirm",
			reasons: [createReason({ code: "fallback-confirm", matcherId: this.id })],
		};
	},
};
