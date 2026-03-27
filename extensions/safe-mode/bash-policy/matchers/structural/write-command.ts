import { createReason } from "../../reasons";
import type { BashMatcher, BashReasonCode } from "../../types";

const WRITE_REASON_CODES = new Set<BashReasonCode>([
	"write-command",
	"find-write-like-flag",
	"git-write-subcommand",
	"package-manager-write-subcommand",
	"dynamic-arguments",
]);

export const writeLikeCommandMatcher: BashMatcher = {
	id: "structural/write-like-command",
	priority: 50,
	evaluate(ctx) {
		if (!ctx.classification.anyWriteLike) return undefined;
		const detail = ctx.classification.details.find(
			(item) => item.kind === "write" && item.reasonCode && WRITE_REASON_CODES.has(item.reasonCode),
		);
		return {
			action: "confirm",
			reasons: [
				createReason({
					code: detail?.reasonCode ?? "write-command",
					matcherId: this.id,
					commandIndex: detail?.commandIndex,
					program: detail?.program,
					detail: detail?.detail,
				}),
			],
		};
	},
};
