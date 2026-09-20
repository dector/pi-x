import { describe, expect, test } from "bun:test";
import {
	composeBorderBottomLeft,
	composeLegacyLeftSection,
	composeSafeModeNetworkGroup,
	composeSectionItems,
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

	test("styleSafeModeLabel recolors only SMART/SMART+", () => {
		expect(styleSafeModeLabel("SMART", border)).toBe("«SMART»");
		expect(styleSafeModeLabel("SMART+", border)).toBe("«SMART+»");
		expect(styleSafeModeLabel("PARANOID", border)).toBe("PARANOID");
	});
});

describe("composeBorderBottomLeft (editor border)", () => {
	test("renders safe mode then network in one label, then context in its own tacks", () => {
		const out = composeBorderBottomLeft({
			contextLabel: "15.9% 210k · 0.03$",
			statusLabel: "SMART",
			networkLabel: "<muted>NET?</muted>",
			borderColor: border,
		});

		expect(out).toBe("«-< »«SMART»« · »<muted>NET?</muted>« >»«-·-< »15.9% 210k · 0.03$« >-»");
		// Order: safe mode, then network, then context.
		expect(out.indexOf("SMART")).toBeLessThan(out.indexOf("NET?"));
		expect(out.indexOf("NET?")).toBeLessThan(out.indexOf("15.9%"));
		// Exactly one network token: no duplication.
		expect(out.match(/NET\??\+?/g)).toEqual(["NET?"]);
	});

	test("joins safe mode and network with exactly one border-colored ` · `", () => {
		const out = composeBorderBottomLeft({
			statusLabel: "SMART",
			networkLabel: "NET+",
			borderColor: border,
		});
		expect(out).toBe("«-< »«SMART»« · »NET+« >-»");
		expect(out.match(/NET\??\+?/g)).toEqual(["NET+"]);
	});

	test("keeps the network token with no safe-mode producer", () => {
		const out = composeBorderBottomLeft({ networkLabel: "NET", borderColor: border });
		expect(out).toBe("«-< »NET« >-»");
	});

	test("keeps safe mode when the core is absent", () => {
		const out = composeBorderBottomLeft({ statusLabel: "PARANOID", borderColor: border });
		expect(out).toBe("«-< »PARANOID« >-»");
	});

	test("context-only output still renders", () => {
		const out = composeBorderBottomLeft({ contextLabel: "15.9% 210k", borderColor: border });
		expect(out).toBe("«-< »15.9% 210k« >-»");
	});

	test("renders nothing when every part is empty", () => {
		expect(composeBorderBottomLeft({ borderColor: border })).toBe("");
		expect(composeBorderBottomLeft({ statusLabel: "  ", networkLabel: "", borderColor: border })).toBe("");
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
