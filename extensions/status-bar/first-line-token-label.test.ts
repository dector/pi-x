import { describe, expect, test } from "bun:test";
import { BORDER_TOTAL_USAGE_ICON } from "./compose.ts";
import { buildFirstLineTokenLabel } from "./index.ts";

type Ctx = Parameters<typeof buildFirstLineTokenLabel>[0];
type Theme = Parameters<typeof buildFirstLineTokenLabel>[1];

function makeCtx(percent: number | undefined): Ctx {
	return {
		getContextUsage: () => (percent === undefined ? undefined : { percent }),
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0 } },
				},
			],
		},
	} as unknown as Ctx;
}

const theme: Theme = {
	fg: (token, text) => `<${token}>${text}</${token}>`,
};

const TOKENS = "↑100/↓50/0";

describe("buildFirstLineTokenLabel", () => {
	test("styles the total-usage icon together with the token text", () => {
		expect(buildFirstLineTokenLabel(makeCtx(15.9), theme)).toBe(`<muted>${BORDER_TOTAL_USAGE_ICON}${TOKENS}</muted>`);
	});

	test("keeps the icon inside the themed color at every threshold", () => {
		expect(buildFirstLineTokenLabel(makeCtx(25), theme)).toBe(`<text>${BORDER_TOTAL_USAGE_ICON}${TOKENS}</text>`);
		expect(buildFirstLineTokenLabel(makeCtx(40), theme)).toBe(
			`<warning>${BORDER_TOTAL_USAGE_ICON}${TOKENS}</warning>`,
		);
		expect(buildFirstLineTokenLabel(makeCtx(60), theme)).toBe(`<error>${BORDER_TOTAL_USAGE_ICON}${TOKENS}</error>`);
	});

	test("returns an unstyled decorated label when usage is unavailable", () => {
		expect(buildFirstLineTokenLabel(makeCtx(undefined), theme)).toBe(`${BORDER_TOTAL_USAGE_ICON}${TOKENS}`);
	});
});
