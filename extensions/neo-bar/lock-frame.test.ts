import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FrameStatusEditor, placeFirstLineRightIndicators, placeRelocatedFrameLabels, placeRewireStatusLabel } from "./index.ts";

type Options = ConstructorParameters<typeof FrameStatusEditor>[3];

const GIT_STATS = { filesAdded: 1, filesRemoved: 2, filesModified: 4, linesAdded: 150, linesRemoved: 200 };

function makeEditor(mode: "new" | "legacy" = "new", decorationColors = false) {
	const relocatedLabels: NonNullable<Options["relocatedLabels"]> = {};
	const tui = { requestRender() {} } as ConstructorParameters<typeof FrameStatusEditor>[0];
	const theme = { borderColor: (text: string) => text } as ConstructorParameters<typeof FrameStatusEditor>[1];
	const editor = new FrameStatusEditor(tui, theme, {} as ConstructorParameters<typeof FrameStatusEditor>[2], {
		getDisplayMode: () => mode,
		getWorkingAnimation: () => "comet",
		interruptConfirmation: {} as Options["interruptConfirmation"],
		topLeft: () => "MODEL",
		topRightGitStats: () => GIT_STATS,
		bottomLeft: () => ({ usage: "USAGE", cost: "COST" }),
		bottomLeftStatus: () => "SAFE-MODE",
		lockedStripeColor: decorationColors ? (text) => `\u001b[2m${text}\u001b[0m` : undefined,
		lockedRuleColor: decorationColors ? (text) => `\u001b[90m${text}\u001b[0m` : undefined,
		bottomRightStash: () => "󱊖 2",
		bottomRightNotes: () => "󰈙 3",
		bottomRight: (text) => text ? `DRAFT ${text}` : undefined,
		relocatedLabels,
	});
	return { editor, relocatedLabels };
}

test("compact footer rotates git, policy, and extended token stats", () => {
	const labels = { git: "GIT", policy: "󰅟 ✓ · 󰚩 2", tokens: "󰊚 ↑10/↓2/5", separator: " · " };
	expect(placeFirstLineRightIndicators({ producer: "OTHER", ...labels, compact: true })).toBe("OTHER · GIT");
	expect(placeRelocatedFrameLabels({ ...labels, compact: true })).toEqual({
		left: "󰅟 ✓ · 󰚩 2", right: "󰊚 ↑10/↓2/5",
	});
	expect(placeRelocatedFrameLabels({ ...labels, cost: "COST", compact: true })).toEqual({
		left: "󰅟 ✓ · 󰚩 2 · COST", right: "󰊚 ↑10/↓2/5",
	});
	expect(placeFirstLineRightIndicators({ producer: "OTHER", ...labels, compact: false })).toBe("OTHER · 󰊚 ↑10/↓2/5");
	expect(placeRelocatedFrameLabels({ ...labels, cost: "COST", compact: false })).toEqual({
		left: "COST", right: "GIT · 󰅟 ✓ · 󰚩 2",
	});
});

test("mobile rewire indicator moves to a right-aligned third status line", () => {
	const label = "󰚩 ⇢ Inherit · high";
	const mobile = placeRewireStatusLabel(label, true, 60);
	expect(mobile.firstLine).toBeUndefined();
	expect(mobile.thirdLine.trimStart()).toBe(label);
	expect(visibleWidth(mobile.thirdLine)).toBe(60);
	expect(placeRewireStatusLabel(label, false, 80)).toEqual({ firstLine: label, thirdLine: "" });
	expect(placeRewireStatusLabel(undefined, true, 60)).toEqual({ firstLine: undefined, thirdLine: "" });
});

describe("locked editor frame", () => {
	test("keeps live border labels and draft stats while replacing only the body", () => {
		const { editor } = makeEditor();
		editor.setText("unsent");
		editor.setLocked(true);
		const lines = editor.render(80);
		expect(lines[0]).toStartWith("╭━╾ MODEL");
		expect(lines[0]).toEndWith("╮");
		expect(lines[0]).toContain(`󰐖 ${GIT_STATS.filesAdded}`);
		expect(lines.at(-1)).toContain("USAGE");
		expect(lines.at(-1)).toContain("COST");
		expect(lines.at(-1)).toContain("DRAFT unsent · 󰈙 3 · 󱊖 2 · COST");
		expect(lines.at(-1)?.indexOf("USAGE")).toBeLessThan(lines.at(-1)!.indexOf("DRAFT unsent"));
		expect(lines.at(-1)).toStartWith("╰");
		expect(lines.at(-1)).toEndWith("╯");
		expect(lines.slice(1, -1).join(" ")).toContain("LOCKED");
		expect(lines[2]).toContain("╱".repeat(72));
		expect(lines[3]).toContain("╱".repeat(72));
		expect(lines[4]).toContain("═".repeat(72));
		expect(lines[5]).toContain("  LOCKED  ");
		expect(lines[6]).toContain("═".repeat(72));
		expect(lines[7]).toContain("╱".repeat(72));
		expect(lines[8]).toContain("╱".repeat(72));
		expect(lines[10]).toContain("Ctrl+,  ·  L to unlock");
		expect(lines.slice(1, -1).join(" ")).not.toContain("unsent");
		expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
		editor.setLocked(false);
		expect(editor.getText()).toBe("unsent");
	});

	test("keeps counts with an empty draft and drops counts first on a narrow border", () => {
		const { editor } = makeEditor();
		editor.setLocked(true);
		expect(editor.render(80).at(-1)).toContain("󰈙 3 · 󱊖 2");
		editor.setText("unsent");
		const narrow = editor.render(55).at(-1)!;
		expect(narrow).toContain("DRAFT unsent");
		expect(narrow).not.toContain("COST");
		expect(visibleWidth(narrow)).toBe(55);
	});

	test("shows cost (including total) in the mobile top-right and moves policy to status line 2", () => {
		const relocatedLabels: NonNullable<Options["relocatedLabels"]> = {};
		const editor = new FrameStatusEditor(
			{ requestRender() {} } as ConstructorParameters<typeof FrameStatusEditor>[0],
			{ borderColor: (text: string) => text } as ConstructorParameters<typeof FrameStatusEditor>[1],
			{} as ConstructorParameters<typeof FrameStatusEditor>[2],
			{
				getDisplayMode: () => "new",
				interruptConfirmation: {} as Options["interruptConfirmation"],
				topLeft: () => "M",
				topRightGitStats: () => GIT_STATS,
				bottomLeft: () => ({ usage: "U", cost: "󰇁\u200b0.01 · 󰇁\u200b󰇁\u200b0.013" }),
				bottomLeftNetwork: () => "NET",
				bottomLeftSubagent: () => "SUB",
				relocatedLabels,
			},
		);
		editor.setLocked(true);
		const compact = editor.render(60);
		expect(compact[0]).not.toContain("󰐖");
		expect(compact[0]).toContain("󰇁\u200b0.01 · 󰇁\u200b󰇁\u200b0.013");
		expect(compact.at(-1)).toContain("U");
		expect(compact.at(-1)).not.toContain("NET");
		expect(compact.at(-1)).not.toContain("SUB");
		expect(relocatedLabels.gitStats).toEqual(GIT_STATS);
		expect(relocatedLabels.contextLabel).toBeUndefined();
		expect(relocatedLabels.policyLabel).toBe("󰅟 NET · 󰚩 SUB");

		const narrowTop = editor.render(24)[0];
		expect(narrowTop).toContain("󰇁\u200b0.01 · 󰇁\u200b󰇁\u200b0.013");
		expect(narrowTop).not.toContain("M");
		expect(relocatedLabels.contextLabel).toBeUndefined();

		const wide = editor.render(100);
		expect(wide[0]).toContain("󰐖");
		expect(wide.at(-1)).toContain("󰅟 NET · 󰚩 SUB");
		expect(wide.at(-1)).toContain("󰇁\u200b0.01 · 󰇁\u200b󰇁\u200b0.013");
		expect(relocatedLabels.gitStats).toBeUndefined();
		expect(relocatedLabels.contextLabel).toBeUndefined();
		expect(relocatedLabels.policyLabel).toBeUndefined();
	});

	test("keeps counts on the bottom while showing cost on top in mobile mode", () => {
		const { editor, relocatedLabels } = makeEditor();
		editor.setLocked(true);
		const lines = editor.render(43);
		expect(lines.at(-1)).toContain("󰈙 3 · 󱊖 2");
		expect(lines.at(-1)).not.toContain("COST");
		expect(lines[0]).toContain("COST");
		expect(relocatedLabels.contextLabel).toBeUndefined();
	});

	test("dims the stripes and grays the rules without dimming the lock label", () => {
		const { editor } = makeEditor("new", true);
		editor.setLocked(true);
		const lines = editor.render(80);
		expect(lines[2]).toContain(`\u001b[2m${"╱".repeat(72)}\u001b[0m`);
		expect(lines[4]).toContain(`\u001b[90m${"═".repeat(72)}\u001b[0m`);
		expect(lines[5]).toContain("  LOCKED  ");
		expect(lines[5]).not.toContain("\u001b[2m");
		expect(lines[10]).toContain("\u001b[90mCtrl+,  ·  L to unlock\u001b[0m");
		expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
		expect(editor.render(120)[2]).toContain("╱".repeat(96));
	});

	test("keeps narrow-frame relocation and legacy border behavior", () => {
		const { editor, relocatedLabels } = makeEditor();
		editor.setLocked(true);
		const lines = editor.render(20);
		expect(lines[0]).toContain("MODEL");
		expect(lines[0]).toStartWith("╭");
		expect(lines[0]).toEndWith("╮");
		expect(lines.at(-1)).toStartWith("╰");
		expect(lines.at(-1)).toEndWith("╯");
		expect(relocatedLabels.gitStats).toEqual(GIT_STATS);
		expect(lines[0]).toContain("COST");
		expect(relocatedLabels.contextLabel).toBeUndefined();
		expect(lines.every((line) => visibleWidth(line) === 20)).toBe(true);
		editor.renderTopBorder(5, 0);
		expect(relocatedLabels.contextLabel).toBe("COST");
		const tiny = editor.render(12);
		expect(tiny.join(" ")).toContain("LOCKED");
		expect(tiny.join(" ")).not.toContain("═");
		expect(tiny.every((line) => visibleWidth(line) === 12)).toBe(true);

		const legacy = makeEditor("legacy").editor;
		legacy.setLocked(true);
		const legacyLines = legacy.render(80);
		expect(legacyLines[0]).not.toContain("MODEL");
		expect(legacyLines.at(-1)).not.toContain("USAGE");
	});
});
