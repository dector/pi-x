import { describe, expect, test } from "bun:test";
import { BORDER_MESSAGE_ICON, estimateMessageTokens } from "./compose.ts";
import { buildMessageSizeLabel } from "./index.ts";

const theme = {
	fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
} as unknown as Parameters<typeof buildMessageSizeLabel>[1];

const label = (text: string) => `<text>${BORDER_MESSAGE_ICON}${text}</text>`;

describe("estimateMessageTokens", () => {
	test("uses pi's conservative chars/4 heuristic", () => {
		expect(estimateMessageTokens("abcd")).toBe(1);
		expect(estimateMessageTokens("a".repeat(4000))).toBe(1000);
	});

	test("treats empty and whitespace-only text as zero", () => {
		expect(estimateMessageTokens("")).toBe(0);
		expect(estimateMessageTokens("   \n\t ")).toBe(0);
	});

	test("ignores surrounding whitespace, matching pi's submit trim", () => {
		expect(estimateMessageTokens("  abcd  ")).toBe(1);
	});
});

describe("buildMessageSizeLabel", () => {
	test("returns undefined for an empty message so the corner stays clear", () => {
		expect(buildMessageSizeLabel("", theme)).toBeUndefined();
		expect(buildMessageSizeLabel("   \n", theme)).toBeUndefined();
	});

	test("renders the size in the normal text color", () => {
		expect(buildMessageSizeLabel("abcd", theme)).toBe(label("1"));
	});

	test("formats large sizes compactly", () => {
		expect(buildMessageSizeLabel("a".repeat(4800), theme)).toBe(label("1.2k"));
	});

	test("adds the image token estimate on top of the text", () => {
		expect(buildMessageSizeLabel("abcd", theme, 994)).toBe(label("995"));
		expect(buildMessageSizeLabel("abcd", theme, -5)).toBe(label("1"));
	});

	test("shows only the image tokens when the text is empty", () => {
		expect(buildMessageSizeLabel("", theme, 994)).toBe(label("994"));
	});
});
