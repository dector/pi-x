import { describe, expect, test } from "bun:test";
import { transferableSettings } from "./index.ts";

describe("reset setting snapshot", () => {
	test("selects only the latest persisted network and review entries", () => {
		const branch = [
			{ type: "custom", customType: "safe-mode", data: { mode: "reader", outerAccess: true } },
			{ type: "custom", customType: "permissions-core", data: { configured: "ask-all" } },
			{ type: "custom", customType: "permissions-core", data: { configured: "allow-all" } },
			{ type: "custom", customType: "review-level", data: { level: "normal" } },
			{ type: "custom", customType: "review-level", data: { level: "high" } },
			{ type: "custom", customType: "other-approval", data: { approved: true } },
			{ type: "message", customType: "review-level", data: {} },
		];
		const snapshot = transferableSettings(branch);
		expect(snapshot).toEqual([
			{ type: "permissions-core", data: { configured: "allow-all" } },
			{ type: "review-level", data: { level: "high" } },
		]);
		expect(transferableSettings(undefined)).toEqual([]);
	});
});
