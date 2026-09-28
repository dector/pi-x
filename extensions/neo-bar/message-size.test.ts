import { describe, expect, test } from "bun:test";
import { BORDER_MESSAGE_ICON, estimateMessageTokens } from "./compose.ts";
import { GIT_STATS_COLORS } from "./git-stats.ts";
import { buildMessageSizeLabel } from "./index.ts";

const label = (text: string) => `${GIT_STATS_COLORS.removed}${BORDER_MESSAGE_ICON}${text}\x1b[39m`;

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
	test("uses the text icon", () => {
		expect(BORDER_MESSAGE_ICON).toBe("󰦨 ");
	});

	test("hides drafts below 1k tokens, including empty drafts", () => {
		expect(buildMessageSizeLabel("")).toBeUndefined();
		expect(buildMessageSizeLabel("   \n")).toBeUndefined();
		expect(buildMessageSizeLabel("a".repeat(3996))).toBeUndefined();
		expect(buildMessageSizeLabel("abcd", -5)).toBeUndefined();
	});

	test("shows drafts at 1k tokens and above in git red", () => {
		expect(buildMessageSizeLabel("a".repeat(4000))).toBe(label("1.0k"));
		expect(buildMessageSizeLabel("a".repeat(4800))).toBe(label("1.2k"));
	});

	test("shows pasted images even below the text threshold", () => {
		expect(buildMessageSizeLabel("abcd", 50)).toBe(label("51"));
		expect(buildMessageSizeLabel("", 994)).toBe(label("994"));
	});
});
