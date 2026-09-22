import { describe, expect, test } from "bun:test";
import { BORDER_TOTAL_USAGE_ICON } from "./compose.ts";
import { buildFirstLineTokenLabel, buildFrameContextParts, styleDarkAccent } from "./index.ts";

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

describe("buildFrameContextParts", () => {
	test("uses the subdued accent for the first context-usage bucket", () => {
		const ctx = {
			getContextUsage: () => ({ percent: 15.9, tokens: 210_000 }),
			sessionManager: { getBranch: () => [] },
		} as unknown as Parameters<typeof buildFrameContextParts>[0];
		const frameTheme = {
			fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
			getFgAnsi: () => "\u001b[38;2;143;127;184m",
		} as unknown as Parameters<typeof buildFrameContextParts>[1];

		expect(buildFrameContextParts(ctx, frameTheme)).toEqual({
			usage: "\u001b[38;2;86;76;110m󰊚 15.9% 210k\u001b[39m",
			cost: "\u001b[38;2;86;76;110m󰇁 0.00\u001b[39m",
		});
	});
});

describe("styleDarkAccent", () => {
	const makeTheme = (ansi: string) =>
		({
			fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
			getFgAnsi: () => ansi,
		}) as unknown as Parameters<typeof styleDarkAccent>[0];

	test("blends the thinking color toward black", () => {
		expect(styleDarkAccent(makeTheme("\u001b[38;2;143;127;184m"), "x")).toBe(
			"\u001b[38;2;86;76;110mx\u001b[39m",
		);
	});

	test("falls back to the raw theme color when the ANSI is unparsable", () => {
		expect(styleDarkAccent(makeTheme(""), "x")).toBe("<thinkingOff>x</thinkingOff>");
	});
});

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
