import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	chooseTopBorderSegments,
	compactFrameLabel,
	composeBorderBottomLeft,
	composeLegacyLeftSection,
	composeSafeModeNetworkGroup,
	composeSectionItems,
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
	hasVisibleText,
	sanitizeStatusText,
	styleSafeModeLabel,
} from "./compose.ts";
import { resolveNetworkStatus, type NetworkPermissionState } from "./network.ts";

// Wrap colored fragments so tests can assert exactly where a themed separator
// landed instead of only seeing the plain text.
const border = (text: string) => `«${text}»`;

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
			networkLabel: "<muted>NET?</muted>",
			borderColor: border,
		});

		expect(out).toBe("«━╾ »«󰕥 »«SMART»« · »󰅟  <muted>NET?</muted>« ╼━╾ »15.9% 210k · 0.03$« »");
		// Order: safe mode, then network, then context.
		expect(out.indexOf("SMART")).toBeLessThan(out.indexOf("NET?"));
		expect(out.indexOf("NET?")).toBeLessThan(out.indexOf("15.9%"));
		// Exactly one network token: no duplication.
		expect(out.match(/NET\??\+?/g)).toEqual(["NET?"]);
	});

	test("tapers the context bridge so its light halves face the labels", () => {
		const out = composeBorderBottomLeft({
			contextLabel: "15.9% 210k",
			statusLabel: "SMART",
			networkLabel: "NET?",
			borderColor: border,
		});

		expect(out).toBe("«━╾ »«󰕥 »«SMART»« · »󰅟  NET?« ╼━╾ »15.9% 210k« »");
		expect(out).not.toContain("━━━");
	});

	test("joins safe mode and network with exactly one border-colored ` · `", () => {
		const out = composeBorderBottomLeft({
			statusLabel: "SMART",
			networkLabel: "NET+",
			borderColor: border,
		});
		expect(out).toBe("«━╾ »«󰕥 »«SMART»« · »󰅟  NET+« »");
		expect(out.match(/NET\??\+?/g)).toEqual(["NET+"]);
	});

	test("keeps the network token with no safe-mode producer", () => {
		const out = composeBorderBottomLeft({ networkLabel: "NET", borderColor: border });
		expect(out).toBe("«━╾ »󰅟  NET« »");
		expect(out).not.toContain("«󰅟");
	});

	test("colors the network icon like the token's producer, not the border", () => {
		const out = composeBorderBottomLeft({
			networkLabel: "\u001b[1m\u001b[38;5;34mNET+\u001b[0m",
			borderColor: border,
		});
		expect(out).toBe("«━╾ »\u001b[1m\u001b[38;5;34m󰅟  \u001b[0m\u001b[1m\u001b[38;5;34mNET+\u001b[0m« »");
	});

	test("keeps safe mode when the core is absent", () => {
		const out = composeBorderBottomLeft({ statusLabel: "PARANOID", borderColor: border });
		expect(out).toBe("«━╾ »󰕥 PARANOID« »");
	});

	test("colors the safe-mode icon like the producer, not the border", () => {
		const out = composeBorderBottomLeft({
			statusLabel: "\u001b[1m\u001b[38;5;196mPARANOID\u001b[0m",
			borderColor: border,
		});
		expect(out).toBe("«━╾ »\u001b[1m\u001b[38;5;196m󰕥 \u001b[0m\u001b[1m\u001b[38;5;196mPARANOID\u001b[0m« »");
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

	test("prefixes the total price with `Tot:` after the current price", () => {
		expect(decorateBorderContextLabel("15.9% 210k · 0.03$ | 0.034$")).toBe(
			"󰊚 15.9% 210k · 󰇁 0.03 Tot:󰇁 0.034",
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
		expect(borderLabel.match(/NET\??\+?/g)).toEqual(["NET?"]);
	});
});

describe("composeSafeModeNetworkGroup", () => {
	test("returns undefined only when both parts are absent", () => {
		expect(composeSafeModeNetworkGroup({ separator: " · " })).toBeUndefined();
		expect(composeSafeModeNetworkGroup({ safeMode: "  ", network: "", separator: " · " })).toBeUndefined();
		expect(composeSafeModeNetworkGroup({ network: "NET", separator: " · " })).toBe("NET");
	});
});
