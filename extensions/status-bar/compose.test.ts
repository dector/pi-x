import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	chooseTopBorderSegments,
	compactFrameLabel,
	composeBorderBottomLeft,
	composeLegacyLeftSection,
	composeSafeModeNetworkGroup,
	composeSectionItems,
	composeTopLeftModelReview,
	decorateBorderContextLabel,
	decorateBorderGitStats,
	decorateBorderPathBranch,
	decorateBorderSafeModeLabel,
	decorateBorderTotalUsage,
	FRAME_LABEL_CLOSE,
	FRAME_LABEL_JOIN,
	FRAME_LABEL_OPEN,
	FRAME_LEFT_CORNER_OPEN,
	FRAME_RIGHT_CORNER_CLOSE,
	formatRewireStatusLabel,
	hasVisibleText,
	sanitizeStatusText,
	styleSafeModeLabel,
	renderStatusPill,
} from "./compose.ts";
import { resolveNetworkStatus, type NetworkPermissionState } from "./network.ts";

// Wrap colored fragments so tests can assert exactly where a themed separator
// landed instead of only seeing the plain text.
const border = (text: string) => `«${text}»`;
const accent = (text: string) => `‹${text}›`;
const smartPill = renderStatusPill("󰕥 SMART", "#554075", "#dbc8f4");
const paranoidPill = renderStatusPill("󰕥 PARANOID", "#284d80", "#c1d9ff");

const LEGACY_IDS = ["safe-mode", "switch-thinking"];

function legacyContent(overrides: Record<string, string | undefined> = {}) {
	const content: Record<string, string | undefined> = {
		"safe-mode": "SMART",
		"switch-thinking": "favorites",
		...overrides,
	};
	return (id: string) => content[id];
}

function networkState(overrides: Partial<NetworkPermissionState> = {}): NetworkPermissionState {
	return {
		configured: "auto",
		effective: "ask-all",
		autoEffective: "ask-all",
		overriddenByParanoid: false,
		...overrides,
	};
}

describe("pure text helpers", () => {
	test("sanitizeStatusText collapses control whitespace and trims", () => {
		expect(sanitizeStatusText("  a\r\nb\tc  ")).toBe("a  b c");
	});

	test("hasVisibleText rejects missing and blank strings", () => {
		expect(hasVisibleText(undefined)).toBe(false);
		expect(hasVisibleText("   ")).toBe(false);
		expect(hasVisibleText("x")).toBe(true);
	});

	test("formats the rewire target with provider and model aliases", () => {
		expect(
			formatRewireStatusLabel(
				"openai-codex/gpt-5.6-sol",
				"high",
				{ "openai-codex": "cdx" },
				{ "gpt-5.6-sol": "5.6-sol" },
			),
		).toBe("󰚩 󰒟 cdx/5.6-sol · high");
	});

	test("keeps full unaliased model names and supports provider-less ids", () => {
		expect(formatRewireStatusLabel("anthropic/claude-sonnet", "medium")).toBe(
			"󰚩 󰒟 anthropic/claude-sonnet · medium",
		);
		expect(formatRewireStatusLabel("local-model", "off", {}, { "local-model": "local" })).toBe(
			"󰚩 󰒟 local · off",
		);
	});

	test("labels an inherited rewire target without an effort suffix", () => {
		expect(formatRewireStatusLabel("parent/fallback", "high", {}, {}, true)).toBe("󰚩 󰒟 Inherit");
	});

	test("compactFrameLabel removes value spacing without damaging ANSI colors", () => {
		const colored = "\u001b[32m+1\u001b[0m \u001b[31m-2\u001b[0m M4 · +150 -200";
		expect(compactFrameLabel(colored)).toBe("\u001b[32m+1\u001b[0m\u001b[31m-2\u001b[0mM4·+150-200");
	});

	test("frame labels use spaces instead of angle tacks", () => {
		expect(FRAME_LABEL_OPEN).toBe(" ");
		expect(FRAME_LABEL_CLOSE).toBe(" ");
		expect(FRAME_LEFT_CORNER_OPEN).toBe("━╾ ");
		expect(FRAME_RIGHT_CORNER_CLOSE).toBe(" ╼━");
	});

	test("the label bridge tapers at both label sides", () => {
		expect(FRAME_LABEL_JOIN).toBe("╼━╾");
	});

	test("styleSafeModeLabel recolors only SMART/SMART+", () => {
		expect(styleSafeModeLabel("SMART", border)).toBe("«SMART»");
		expect(styleSafeModeLabel("SMART+", border)).toBe("«SMART+»");
		expect(styleSafeModeLabel("PARANOID", border)).toBe("PARANOID");
	});

	test("decorateBorderSafeModeLabel colors the icon like the text it prefixes", () => {
		expect(decorateBorderSafeModeLabel("SMART", border)).toBe("«󰕥 »«SMART»");
		expect(decorateBorderSafeModeLabel("PARANOID", border)).toBe("󰕥 PARANOID");
		expect(decorateBorderSafeModeLabel("\u001b[1m\u001b[38;5;196mPARANOID\u001b[0m", border)).toBe(
			"\u001b[1m\u001b[38;5;196m󰕥 \u001b[0m\u001b[1m\u001b[38;5;196mPARANOID\u001b[0m",
		);
	});
});

describe("top-left model/review composition", () => {
	test("appends review after model effort with a border-colored separator", () => {
		expect(composeTopLeftModelReview("󰙴 cdx/5.6-sol · high", "󰡬 ", border)).toBe(
			"󰙴 cdx/5.6-sol · high« · 󰡬 »",
		);
	});

	test("keeps the model label unchanged when review is absent", () => {
		expect(composeTopLeftModelReview("󰙴 cdx/5.6-sol · high", undefined, border)).toBe(
			"󰙴 cdx/5.6-sol · high",
		);
	});
});

describe("chooseTopBorderSegments", () => {
	const fullModel = `${FRAME_LEFT_CORNER_OPEN}󰙴 cdx/5.6-sol · med${FRAME_LABEL_CLOSE}`;
	const compactModel = `${FRAME_LEFT_CORNER_OPEN}󰙴 cdx/5.6-sol · 🡺${FRAME_LABEL_CLOSE}`;
	const fullGit = `${FRAME_LABEL_OPEN}󰐖 1 󰍵 0 󰦓 1 · 󰐖 93 󰍵 0${FRAME_RIGHT_CORNER_CLOSE}`;
	const compactGit = `${FRAME_LABEL_OPEN}󰐖1󰍵0󰦓1·󰐖93󰍵0${FRAME_RIGHT_CORNER_CLOSE}`;
	const filesGit = `${FRAME_LABEL_OPEN}󰐖1󰍵0󰦓1${FRAME_RIGHT_CORNER_CLOSE}`;
	const choose = (width: number) =>
		chooseTopBorderSegments({
			width,
			leftSegments: [fullModel, compactModel],
			rightSegments: [fullGit, compactGit, filesGit],
			minimumGap: 1,
			visibleWidth,
		});

	test("uses one border dash as the minimum gap", () => {
		const chosen = choose(visibleWidth(fullModel) + visibleWidth(fullGit) + 1);
		expect(chosen).toEqual({ left: fullModel, right: fullGit });
	});

	test("shortens git to the compact split form before dropping the line group", () => {
		const chosen = choose(visibleWidth(fullModel) + visibleWidth(compactGit) + 1);
		expect(chosen.left).toBe(fullModel);
		expect(chosen.right).toBe(compactGit);
	});

	test("drops the changed-line group before dropping the model", () => {
		const chosen = choose(visibleWidth(fullModel) + visibleWidth(compactGit));
		expect(chosen.left).toBe(fullModel);
		expect(chosen.right).toBe(filesGit);
		expect(chosen.right).not.toContain("·");
		expect(chosen.right).not.toContain("93");
	});

	test("keeps the model alone when no git form fits", () => {
		const chosen = choose(visibleWidth(fullModel) + 1);
		expect(chosen).toEqual({ left: fullModel, right: "" });
	});
});

describe("composeBorderBottomLeft (editor border)", () => {
	test("renders safe mode then network in one label, then context after the border bridge", () => {
		const out = composeBorderBottomLeft({
			contextLabel: "15.9% 210k · 0.03$",
			statusLabel: "SMART",
			networkLabel: "?",
			borderColor: border,
		});

		expect(out).toBe(`«━╾ »${smartPill}« · »«󰅟 ?»« ╼━╾ »15.9% 210k · 0.03$« »`);
		expect(out.indexOf("SMART")).toBeLessThan(out.indexOf("󰅟 ?"));
		expect(out.indexOf("󰅟 ?")).toBeLessThan(out.indexOf("15.9%"));
	});

	test("renders the subagent depth immediately after network", () => {
		const out = composeBorderBottomLeft({
			statusLabel: "SMART",
			networkLabel: "?",
			subagentLabel: "󰚩 ✓",
			borderColor: border,
		});

		expect(out).toBe(`«━╾ »${smartPill}« · »«󰅟 ?»« · »«󰚩 ✓»« »`);
		expect(out.indexOf("󰅟 ?")).toBeLessThan(out.indexOf("󰚩 ✓"));
	});

	test("uses one producer color for the whole recursive subagent indicator", () => {
		const out = composeBorderBottomLeft({
			subagentLabel: "\u001b[38;5;220m󰚩 2\u001b[0m",
			borderColor: border,
		});

		expect(out).toBe("«━╾ »\u001b[38;5;220m󰚩 \u001b[0m\u001b[38;5;220m2\u001b[0m« »");
	});

	test("tapers the context bridge so its light halves face the labels", () => {
		const out = composeBorderBottomLeft({
			contextLabel: "15.9% 210k",
			statusLabel: "SMART",
			networkLabel: "?",
			borderColor: border,
		});

		expect(out).toBe(`«━╾ »${smartPill}« · »«󰅟 ?»« ╼━╾ »15.9% 210k« »`);
		expect(out).not.toContain("━━━");
	});

	test("joins safe mode and network with exactly one border-colored ` · `", () => {
		const out = composeBorderBottomLeft({
			statusLabel: "SMART",
			networkLabel: "✓?",
			borderColor: border,
		});
		expect(out).toBe(`«━╾ »${smartPill}« · »«󰅟 ✓?»« »`);
	});

	test("uses pill colors for every safe mode, including outer-access variants", () => {
		for (const [label, bg, fg] of [
			["SMART+", "#554075", "#dbc8f4"],
			["READER", "#215d39", "#bce4c5"],
			["READER+", "#215d39", "#bce4c5"],
			["YOLO", "#d70000", "#ffe0e0"],
			["PARANOID", "#284d80", "#c1d9ff"],
		] as const) {
			const out = composeBorderBottomLeft({ statusLabel: label, borderColor: border });
			expect(out).toBe(`«━╾ »${renderStatusPill(`󰕥 ${label}`, bg, fg)}« »`);
		}
	});

	test("yolo+ has a red shield-only pill", () => {
		const shield = "\x1b[48;5;88;38;2;211;143;143m󰕥\x1b[0m";
		const pill = "\x1b[38;5;88m\x1b[0m\x1b[48;5;88;38;2;211;143;143m󰕥\x1b[0m\x1b[38;5;88m\x1b[0m";
		expect(composeBorderBottomLeft({ statusLabel: shield, networkLabel: "?", borderColor: border })).toBe(
			`«━╾ »${pill}« · »«󰅟 ?»« »`,
		);
		expect(composeBorderBottomLeft({ statusLabel: shield, contextLabel: "CTX", borderColor: border })).toBe(
			`«━╾ »${pill}« ╼━╾ »CTX« »`,
		);
		expect(composeBorderBottomLeft({ statusLabel: shield, borderColor: border })).toBe(
			`«━╾ »${pill}« »`,
		);
	});

	test("unknown producer labels still render without a pill", () => {
		const out = composeBorderBottomLeft({ statusLabel: "__proto__", borderColor: border });
		expect(out).toBe("«━╾ »󰕥 __proto__« »");
	});

	test("keeps the network indicator with no safe-mode producer", () => {
		const out = composeBorderBottomLeft({ networkLabel: "✓", borderColor: border });
		expect(out).toBe("«━╾ »«󰅟 ✓»« »");
	});

	test("uses one producer color for the whole exceptional network indicator", () => {
		const out = composeBorderBottomLeft({
			networkLabel: "\u001b[1m\u001b[38;5;196m!\u001b[0m",
			borderColor: border,
		});
		expect(out).toBe("«━╾ »\u001b[1m\u001b[38;5;196m󰅟 \u001b[0m\u001b[1m\u001b[38;5;196m!\u001b[0m« »");
	});

	test("colors a neutral network token with the accent color, not the border", () => {
		const out = composeBorderBottomLeft({ networkLabel: "?", borderColor: border, accentColor: accent });
		expect(out).toBe("«━╾ »‹󰅟 ?›« »");
	});

	test("colors the top-level subagent check with the accent color", () => {
		const out = composeBorderBottomLeft({ subagentLabel: "󰚩 ✓", borderColor: border, accentColor: accent });
		expect(out).toBe("«━╾ »‹󰚩 ✓›« »");
	});

	test("keeps a producer-colored subagent depth ahead of the accent", () => {
		const out = composeBorderBottomLeft({
			subagentLabel: "\u001b[38;5;220m󰚩 2\u001b[0m",
			borderColor: border,
			accentColor: accent,
		});
		expect(out).toBe("«━╾ »\u001b[38;5;220m󰚩 \u001b[0m\u001b[38;5;220m2\u001b[0m« »");
	});

	test("keeps safe mode when the core is absent", () => {
		const out = composeBorderBottomLeft({ statusLabel: "PARANOID", borderColor: border });
		expect(out).toBe(`«━╾ »${paranoidPill}« »`);
	});

	test("uses the mode's pill palette, not the producer's foreground styling", () => {
		const out = composeBorderBottomLeft({
			statusLabel: "\u001b[1m\u001b[38;5;196mPARANOID\u001b[0m",
			borderColor: border,
		});
		expect(out).toBe(`«━╾ »${paranoidPill}« »`);
	});

	test("context-only output still renders", () => {
		const out = composeBorderBottomLeft({ contextLabel: "15.9% 210k", borderColor: border });
		expect(out).toBe("«━╾ »15.9% 210k« »");
	});

	test("renders nothing when every part is empty", () => {
		expect(composeBorderBottomLeft({ borderColor: border })).toBe("");
		expect(composeBorderBottomLeft({ statusLabel: "  ", networkLabel: "", borderColor: border })).toBe("");
	});
});

describe("decorateBorderGitStats", () => {
	const stats =
		"\u001b[32m+1\u001b[0m \u001b[31m-2\u001b[0m \u001b[38;5;208mM4\u001b[0m · \u001b[32m+150\u001b[0m \u001b[31m-200\u001b[0m";

	test("splits the file and changed-line groups, files first", () => {
		expect(decorateBorderGitStats(stats)).toBe(
			"\u001b[32m󰐖 1\u001b[0m \u001b[31m󰍵 2\u001b[0m \u001b[38;5;208m󰦓 4\u001b[0m · \u001b[32m󰐖 150\u001b[0m \u001b[31m󰍵 200\u001b[0m",
		);
	});

	test("colors the group divider with the separator style", () => {
		expect(decorateBorderGitStats(stats, { separator: (text) => `<sep>${text}</sep>` })).toBe(
			"\u001b[32m󰐖 1\u001b[0m \u001b[31m󰍵 2\u001b[0m \u001b[38;5;208m󰦓 4\u001b[0m<sep> · </sep>\u001b[32m󰐖 150\u001b[0m \u001b[31m󰍵 200\u001b[0m",
		);
	});

	test("drops the changed-line group for narrow frames", () => {
		expect(decorateBorderGitStats(stats, { includeLineCounts: false })).toBe(
			"\u001b[32m󰐖 1\u001b[0m \u001b[31m󰍵 2\u001b[0m \u001b[38;5;208m󰦓 4\u001b[0m",
		);
	});

	test("mutes zero-valued items in both groups", () => {
		const mute = (text: string) => `<mute>${text}</mute>`;
		expect(decorateBorderGitStats("+1 -0 M7 · +353 -69", { mute })).toBe(
			"󰐖 1 <mute>󰍵 0</mute> 󰦓 7 · 󰐖 353 󰍵 69",
		);
		expect(decorateBorderGitStats("+0 -0 M2 · +0 -0", { mute })).toBe(
			"<mute>󰐖 0</mute> <mute>󰍵 0</mute> 󰦓 2 · <mute>󰐖 0</mute> <mute>󰍵 0</mute>",
		);
		expect(decorateBorderGitStats("+0 -5 M7 · +0 -69", { mute })).toBe(
			"<mute>󰐖 0</mute> 󰍵 5 󰦓 7 · <mute>󰐖 0</mute> 󰍵 69",
		);
	});

	test("treats a file-only label as just the files group", () => {
		expect(decorateBorderGitStats("\u001b[32m+1\u001b[0m \u001b[31m-2\u001b[0m \u001b[38;5;208mM4\u001b[0m")).toBe(
			"\u001b[32m󰐖 1\u001b[0m \u001b[31m󰍵 2\u001b[0m \u001b[38;5;208m󰦓 4\u001b[0m",
		);
	});
});

describe("decorateBorderContextLabel", () => {
	test("prefixes context and current price, dropping the price `$`", () => {
		expect(decorateBorderContextLabel("15.9% 210k · 0.03$")).toBe("󰊚 15.9% 210k · 󰇁 0.03");
	});

	test("prefixes the total price with `Tot` after the current price", () => {
		expect(decorateBorderContextLabel("15.9% 210k · 0.03$ | 0.034$")).toBe(
			"󰊚 15.9% 210k · 󰇁 0.03 Tot󰇁 0.034",
		);
	});

	test("handles the small-value placeholders without a price", () => {
		expect(decorateBorderContextLabel("-- -- · <0.01$")).toBe("󰊚 -- -- · 󰇁 <0.01");
	});

	test("leaves a context-only label with just the context icon", () => {
		expect(decorateBorderContextLabel("15.9% 210k")).toBe("󰊚 15.9% 210k");
	});
});

describe("decorateBorderPathBranch", () => {
	test("appends the branch with the spaced border branch icon", () => {
		expect(decorateBorderPathBranch({ path: "~/pi-x", branch: "trunk" })).toBe("~/pi-x (\ueafe trunk)");
	});

	test("keeps the path alone when the branch is absent or blank", () => {
		expect(decorateBorderPathBranch({ path: "~/pi-x" })).toBe("~/pi-x");
		expect(decorateBorderPathBranch({ path: "~/pi-x", branch: "  " })).toBe("~/pi-x");
	});
});

describe("decorateBorderTotalUsage", () => {
	test("prefixes the token usage breakdown with the total-usage icon", () => {
		expect(decorateBorderTotalUsage("↑0/↓0/0")).toBe("\u{000f04e1} ↑0/↓0/0");
	});
});

describe("composeLegacyLeftSection (status line)", () => {
	test("keeps the spaced safe · network dot under the compact item separator", () => {
		const out = composeLegacyLeftSection({
			ids: LEGACY_IDS,
			getContent: legacyContent(),
			networkLabel: "<muted>NET?</muted>",
			networkSeparator: "« · »",
			itemSeparator: "«·»",
			safeModeId: "safe-mode",
		});

		expect(out).toBe("SMART« · »<muted>NET?</muted>«·»favorites");
		// Safe mode then network immediately, then the other item.
		expect(out.indexOf("SMART")).toBeLessThan(out.indexOf("NET?"));
		expect(out.indexOf("NET?")).toBeLessThan(out.indexOf("favorites"));
		// The safe/network group uses the spaced dot, not the compact one.
		expect(out).toContain("SMART« · »<muted>NET?");
		expect(out).not.toContain("SMART«·»");
		// Exactly one network token: no duplication.
		expect(out.match(/NET\??\+?/g)).toEqual(["NET?"]);
	});

	test("keeps delegation policy after network under compact layout", () => {
		const out = composeLegacyLeftSection({
			ids: LEGACY_IDS,
			getContent: legacyContent(),
			networkLabel: "NET",
			subagentLabel: "󰚩 1",
			networkSeparator: " · ",
			itemSeparator: "·",
			safeModeId: "safe-mode",
		});
		expect(out).toBe("SMART · NET · 󰚩 1·favorites");
	});

	test("uses the compact separator for the remaining section items", () => {
		const out = composeLegacyLeftSection({
			ids: LEGACY_IDS,
			getContent: legacyContent(),
			networkLabel: "NET",
			networkSeparator: " · ",
			itemSeparator: "·",
			safeModeId: "safe-mode",
		});
		expect(out).toBe("SMART · NET·favorites");
	});

	test("network token leads when safe mode is absent", () => {
		const out = composeLegacyLeftSection({
			ids: LEGACY_IDS,
			getContent: legacyContent({ "safe-mode": undefined }),
			networkLabel: "NET+",
			networkSeparator: " · ",
			itemSeparator: "·",
			safeModeId: "safe-mode",
		});
		expect(out).toBe("NET+·favorites");
	});

	test("leaves the section unchanged when the core is absent", () => {
		const out = composeLegacyLeftSection({
			ids: LEGACY_IDS,
			getContent: legacyContent(),
			networkLabel: undefined,
			networkSeparator: " · ",
			itemSeparator: "·",
			safeModeId: "safe-mode",
		});
		expect(out).toBe("SMART·favorites");
		expect(out).not.toContain("NET");
	});

	test("applies caller overrides in place (compact thinking)", () => {
		const out = composeLegacyLeftSection({
			ids: LEGACY_IDS,
			getContent: legacyContent(),
			networkLabel: "NET",
			networkSeparator: " · ",
			itemSeparator: "·",
			safeModeId: "safe-mode",
			overrides: new Map([["switch-thinking", "med"]]),
		});
		expect(out).toBe("SMART · NET·med");
	});
});

describe("composeSectionItems", () => {
	test("omits blanks and joins the rest", () => {
		const content: Record<string, string | undefined> = { a: "A", b: "  ", c: "C" };
		expect(composeSectionItems(["a", "b", "c"], (id) => content[id], " · ")).toBe("A · C");
		expect(composeSectionItems([], () => undefined, " · ")).toBeUndefined();
	});
});

describe("surface ownership (no duplication)", () => {
	test("legacy renders the token on the status line only", () => {
		const resolution = resolveNetworkStatus({ displayMode: "legacy", state: networkState(), theme: { fg: (_t, s) => s } });
		expect(resolution?.surface).toBe("status-line");

		const statusLine = composeLegacyLeftSection({
			ids: LEGACY_IDS,
			getContent: legacyContent(),
			networkLabel: resolution?.label,
			networkSeparator: "« · »",
			itemSeparator: "«·»",
			safeModeId: "safe-mode",
		});
		// The border is not given the label in legacy mode.
		const borderLabel = composeBorderBottomLeft({
			contextLabel: "15.9% 210k",
			statusLabel: "SMART",
			networkLabel: undefined,
			borderColor: border,
		});

		expect(statusLine?.match(/NET\??\+?/g)).toEqual(["NET?"]);
		expect(borderLabel).not.toContain("NET");
	});

	test("new renders the token on the border only", () => {
		const resolution = resolveNetworkStatus({ displayMode: "new", state: networkState(), theme: { fg: (_t, s) => s } });
		expect(resolution?.surface).toBe("border");

		const statusLine = composeLegacyLeftSection({
			ids: LEGACY_IDS,
			getContent: legacyContent(),
			networkLabel: undefined,
			networkSeparator: "« · »",
			itemSeparator: "«·»",
			safeModeId: "safe-mode",
		});
		const borderLabel = composeBorderBottomLeft({
			contextLabel: "15.9% 210k",
			statusLabel: "SMART",
			networkLabel: resolution?.label,
			borderColor: border,
		});

		expect(statusLine).not.toContain("NET");
		expect(borderLabel).toContain("󰅟 ?");
	});
});

describe("composeSafeModeNetworkGroup", () => {
	test("returns undefined only when both parts are absent", () => {
		expect(composeSafeModeNetworkGroup({ separator: " · " })).toBeUndefined();
		expect(composeSafeModeNetworkGroup({ safeMode: "  ", network: "", separator: " · " })).toBeUndefined();
		expect(composeSafeModeNetworkGroup({ network: "NET", separator: " · " })).toBe("NET");
	});
});
