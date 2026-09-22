import { beforeEach, describe, expect, test } from "bun:test";
import { Container } from "@earendil-works/pi-tui";
import {
	computeEntryPositions,
	describeEntry,
	findNextEntryTop,
	findPreviousEntryTop,
	getSelectedEntry,
	getTuiReference,
	captureTuiReference,
	isExpandableEntry,
	isTrackedEntry,
	navigablePositions,
	selectAdjacentEntry,
	setSelectedEntry,
	showEntryChip,
	toggleSelectedEntry,
	type ScrollViewLike,
} from "./index";

class FakeEntry {
	constructor(private readonly height = 1) {}
	render(): string[] {
		return Array.from({ length: this.height }, () => "");
	}
}

class ToolExecutionComponent extends FakeEntry {
	expanded = false;
	invalidations = 0;
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	invalidate(): void {
		this.invalidations += 1;
	}
}

class CustomMessageComponent extends FakeEntry {
	_expanded = false;
	setExpanded(expanded: boolean): void {
		this._expanded = expanded;
	}
}

class AssistantMessageComponent extends FakeEntry {
	hideThinkingBlock = false;
	lastMessage: { content?: Array<{ type?: string; text?: string }> } | undefined;
}

class UserMessageComponent extends FakeEntry {}

/** Has setExpanded() but is not a transcript entry (e.g. the startup header). */
class ExpandableText extends FakeEntry {
	expanded = false;
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
}

class PlainText extends FakeEntry {}

interface OverlayCall {
	component: { render(width: number): string[] };
	options: Record<string, unknown>;
}

interface FakeTui {
	terminal: { columns: number };
	getPrimaryScrollView(): ScrollViewLike | undefined;
	showOverlay(component: unknown, options?: Record<string, unknown>): { hide(): void };
	overlayCalls: OverlayCall[];
	hidden: number;
}

interface FakeScrollView extends ScrollViewLike {
	scrollCalls: number[];
}

function createScrollView(content: Container, scrollTop = 0): FakeScrollView {
	const contentHeight = (content.children ?? []).reduce((total, child) => {
		const rendered =
			typeof (child as { render?: (width: number) => string[] }).render === "function"
				? (child as { render: (width: number) => string[] }).render(80).length
				: 0;
		return total + rendered;
	}, 0);
	return {
		scrollTop,
		viewportHeight: 1,
		primary: true,
		child: content,
		scrollCalls: [],
		scrollTo(this: FakeScrollView, top: number): void {
			this.scrollCalls.push(top);
			this.scrollTop = Math.max(0, Math.min(top, contentHeight - this.viewportHeight));
		},
		scrollBy(): void {},
	};
}

function createTui(scrollView: ScrollViewLike | undefined): FakeTui {	const tui: FakeTui = {
		terminal: { columns: 80 },
		overlayCalls: [],
		hidden: 0,
		getPrimaryScrollView: () => scrollView,
		showOverlay(component: unknown, options?: Record<string, unknown>) {
			tui.overlayCalls.push({
				component: component as OverlayCall["component"],
				options: options ?? {},
			});
			return {
				hide: () => {
					tui.hidden += 1;
				},
			};
		},
	};
	return tui;
}

/** Chat container with a tool entry followed by entries of the given heights. */
function createChat(offsets?: Array<{ component: Container["children"][number]; height: number }>): Container {
	const chat = new Container();
	if (!offsets) {
		chat.addChild(new UserMessageComponent(2));
		chat.addChild(new ToolExecutionComponent(5));
		chat.addChild(new AssistantMessageComponent(1));
	}
	chat.mouseLayout = {
		width: 80,
		children: (offsets ?? [
			{ component: chat.children[0], height: 2 },
			{ component: chat.children[1], height: 5 },
			{ component: chat.children[2], height: 1 },
		]) as Array<{ component: unknown; height: number }>,
	};
	return chat;
}

beforeEach(() => {
	setSelectedEntry(undefined);
});

describe("entry classification", () => {
	test("recognises transcript entries and expandable ones", () => {
		expect(isTrackedEntry(new ToolExecutionComponent())).toBe(true);
		expect(isTrackedEntry(new AssistantMessageComponent())).toBe(true);
		expect(isTrackedEntry(new UserMessageComponent())).toBe(true);
		expect(isTrackedEntry(new PlainText())).toBe(false);
		expect(isTrackedEntry(new ExpandableText())).toBe(false);
		expect(isTrackedEntry("text")).toBe(false);

		expect(isExpandableEntry(new ToolExecutionComponent())).toBe(true);
		expect(isExpandableEntry(new CustomMessageComponent())).toBe(true);
		expect(isExpandableEntry(new AssistantMessageComponent())).toBe(false);
		expect(isExpandableEntry(new ExpandableText())).toBe(false);
	});

	test("describes entries with short labels", () => {
		expect(describeEntry(new ToolExecutionComponent())).toBe("tool");
		expect(describeEntry(new AssistantMessageComponent())).toBe("assistant");
		expect(describeEntry({ constructor: { name: "SomethingElseComponent" } })).toBe("SomethingElse");
		expect(describeEntry(undefined)).toBe("entry");
	});
});

describe("entry positions", () => {
	test("walks nested containers and carries offsets", () => {
		const chat = new Container();
		chat.addChild(new UserMessageComponent(2));
		chat.addChild(new ToolExecutionComponent(5));
		chat.addChild(new AssistantMessageComponent(1));

		const document = new Container();
		document.addChild(new ExpandableText(3));
		document.addChild(chat);

		expect(computeEntryPositions(document, 80).map((position) => [position.top, position.height])).toEqual([
			[3, 2],
			[5, 5],
			[10, 1],
		]);
	});

	test("prefers heights recorded by the last render", () => {
		const chat = new Container();
		const user = new UserMessageComponent(1);
		const tool = new ToolExecutionComponent(1);
		chat.addChild(user);
		chat.addChild(tool);
		chat.mouseLayout = {
			width: 80,
			children: [
				{ component: user, height: 4 },
				{ component: tool, height: 7 },
			],
		};

		expect(computeEntryPositions(chat, 80).map((position) => [position.top, position.height])).toEqual([
			[0, 4],
			[4, 7],
		]);
	});

	test("ignores invalid roots and widths", () => {
		expect(computeEntryPositions(undefined, 80)).toEqual([]);
		expect(computeEntryPositions(new Container(), 0)).toEqual([]);
	});
});

describe("entry lookup", () => {
	const positions = [
		{ component: new UserMessageComponent(), top: 0, height: 2 },
		{ component: new ToolExecutionComponent(), top: 2, height: 5 },
		{ component: new AssistantMessageComponent(), top: 7, height: 1 },
	];

	test("findNextEntryTop moves below the current offset", () => {
		expect(findNextEntryTop(positions, 0)).toBe(2);
		expect(findNextEntryTop(positions, 2)).toBe(7);
		expect(findNextEntryTop(positions, 6)).toBe(7);
		expect(findNextEntryTop(positions, 7)).toBeUndefined();
	});

	test("findPreviousEntryTop moves above the current offset", () => {
		expect(findPreviousEntryTop(positions, 7)).toBe(2);
		expect(findPreviousEntryTop(positions, 3)).toBe(2);
		expect(findPreviousEntryTop(positions, 2)).toBe(0);
		expect(findPreviousEntryTop(positions, 0)).toBeUndefined();
	});
});

describe("tui capture", () => {
	test("captures the tui through the widget factory", () => {
		const fakeTui = createTui(undefined);
		const ctx = {
			hasUI: true,
			ui: {
				setWidget: (_key: string, factory: (tui: unknown, theme: unknown) => unknown) => {
					factory(fakeTui, {});
				},
			},
		};

		expect(captureTuiReference(ctx as never)).toBe(fakeTui as never);
		expect(getTuiReference()).toBe(fakeTui as never);
	});

	test("keeps the previous reference when there is no ui", () => {
		const fakeTui = createTui(undefined);
		let widgetCalls = 0;
		const withUi = {
			hasUI: true,
			ui: {
				setWidget: (_key: string, factory: (tui: unknown, theme: unknown) => unknown) => {
					widgetCalls += 1;
					factory(fakeTui, {});
				},
			},
		};
		captureTuiReference(withUi as never);

		expect(captureTuiReference({ hasUI: false, ui: {} } as never)).toBe(fakeTui as never);
		expect(widgetCalls).toBe(1);
	});
});

describe("entry chip", () => {
	function captureWithTheme(theme: unknown): void {
		captureTuiReference({
			hasUI: true,
			ui: { theme, setWidget: (_key: string, factory: (tui: unknown) => unknown) => factory(createTui(undefined)) },
		} as never);
	}

	test("draws a non-capturing overlay at the given row", () => {
		captureWithTheme(undefined);
		const tui = createTui(undefined);

		expect(showEntryChip(tui, 7, "12/379 tool")).toBe(true);
		expect(tui.overlayCalls).toHaveLength(1);

		const call = tui.overlayCalls[0];
		expect(call?.options).toMatchObject({ row: 7, col: 0, nonCapturing: true });
		expect(call?.options.width).toBe(" 12/379 tool ".length);
		expect(call?.component.render(80)[0]).toBe("\x1b[7m 12/379 tool \x1b[27m");
	});

	test("styles the chip with the captured theme purple", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}`,
			bold: (text: string) => `*${text}*`,
		};
		captureWithTheme(theme);
		const tui = createTui(undefined);

		showEntryChip(tui, 0, "480/482 tool");

		const line = tui.overlayCalls.at(-1)?.component.render(80)[0] ?? "";
		expect(line).toContain("<thinkingHigh>*▌ 480/482 tool*");
	});

	test("replaces the previous chip and hides it", () => {
		const tui = createTui(undefined);

		showEntryChip(tui, 1, "first");
		showEntryChip(tui, 2, "second");

		expect(tui.hidden).toBe(1);
		expect(tui.overlayCalls).toHaveLength(2);
	});

	test("is unavailable without overlay support", () => {
		expect(showEntryChip(undefined, 0, "chip")).toBe(false);
		expect(showEntryChip({ terminal: { columns: 80 } }, 0, "chip")).toBe(false);
	});
});

describe("selection navigation", () => {
	test("skips zero-height entries and hidden placeholder messages", () => {
		const chat = new Container();
		const user = new UserMessageComponent(2);
		const placeholder = new AssistantMessageComponent(2);
		placeholder.hideThinkingBlock = true;
		placeholder.lastMessage = { content: [{ type: "thinking" }, { type: "toolCall" }] };
		const tool = new ToolExecutionComponent(3);
		const withText = new AssistantMessageComponent(2);
		withText.hideThinkingBlock = true;
		withText.lastMessage = { content: [{ type: "thinking" }, { type: "text", text: "visible" }] };
		const invisible = new AssistantMessageComponent(0);
		invisible.lastMessage = { content: [{ type: "text", text: "scrolled into nothing" }] };

		chat.addChild(user);
		chat.addChild(placeholder);
		chat.addChild(tool);
		chat.addChild(withText);
		chat.addChild(invisible);
		chat.mouseLayout = {
			width: 80,
			children: [user, placeholder, tool, withText, invisible].map((component, index) => ({
				component,
				height: index === 4 ? 0 : [2, 2, 3, 2, 0][index] ?? 1,
			})),
		};

		const positions = computeEntryPositions(chat, 80);
		expect(positions).toHaveLength(5);
		expect(navigablePositions(positions).map((position) => describeEntry(position.component))).toEqual([
			"user",
			"tool",
			"assistant",
		]);

		// Visible assistant messages stay navigable when thinking is shown.
		const shown = new AssistantMessageComponent(2);
		shown.hideThinkingBlock = false;
		shown.lastMessage = { content: [{ type: "thinking" }] };
		expect(navigablePositions([{ component: shown, top: 0, height: 2 }])).toHaveLength(1);
	});

	test("selects the entry below the current scroll offset first", () => {
		const chat = createChat();
		const scrollView = createScrollView(chat);
		const tui = createTui(scrollView);

		const outcome = selectAdjacentEntry(tui, 1);

		expect(outcome.status).toBe("moved");
		expect(outcome.status === "moved" && outcome.result).toMatchObject({
			index: 1,
			total: 3,
			label: "tool",
			top: 2,
			row: 0,
			atStart: false,
			atEnd: false,
		});
		expect(getSelectedEntry()).toBe(chat.children[1]);
		expect(scrollView.scrollCalls).toEqual([2]);
		expect(tui.overlayCalls[0]?.options.row).toBe(0);
	});

	test("steps strictly through entries once something is selected", () => {
		const chat = createChat();
		const scrollView = createScrollView(chat);
		const tui = createTui(scrollView);

		selectAdjacentEntry(tui, 1);
		const second = selectAdjacentEntry(tui, 1);
		const third = selectAdjacentEntry(tui, 1);

		expect(second.status === "moved" && second.result.index).toBe(2);
		expect(second.status === "moved" && second.result.label).toBe("assistant");
		expect(third.status === "moved" && third.result.atEnd).toBe(true);
		expect(getSelectedEntry()).toBe(chat.children[2]);

		const back = selectAdjacentEntry(tui, -1);
		expect(back.status === "moved" && back.result.index).toBe(1);
		expect(getSelectedEntry()).toBe(chat.children[1]);
	});

	test("falls back to the scroll position when the selection is gone", () => {
		const chat = createChat();
		const scrollView = createScrollView(chat, 2);
		const tui = createTui(scrollView);
		setSelectedEntry(new ToolExecutionComponent());

		const outcome = selectAdjacentEntry(tui, 1);

		expect(outcome.status === "moved" && outcome.result.index).toBe(2);
	});

	test("reports empty and unavailable transcripts", () => {
		const emptyChat = createChat([]);
		emptyChat.mouseLayout = { width: 80, children: [] };
		expect(selectAdjacentEntry(createTui(createScrollView(emptyChat)), 1).status).toBe("empty");
		expect(selectAdjacentEntry(undefined, 1).status).toBe("unavailable");
		expect(selectAdjacentEntry(createTui(undefined), 1).status).toBe("unavailable");
	});
});

describe("selection toggle", () => {
	test("requires a selection", () => {
		const tui = createTui(createScrollView(createChat()));

		expect(toggleSelectedEntry(tui).status).toBe("no-selection");
	});

	test("toggles the selected expandable entry", () => {
		const chat = createChat();
		const scrollView = createScrollView(chat);
		const tui = createTui(scrollView);
		const tool = chat.children[1] as ToolExecutionComponent;
		setSelectedEntry(tool);

		const first = toggleSelectedEntry(tui);
		expect(first.status).toBe("toggled");
		expect(first.status === "toggled" && first).toMatchObject({ label: "tool", expanded: true, index: 1, total: 3 });
		expect(tool.expanded).toBe(true);
		expect(tool.invalidations).toBe(1);
		expect(tui.overlayCalls[0]?.component.render(80)[0]).toContain("→ expanded");

		const second = toggleSelectedEntry(tui);
		expect(second.status === "toggled" && second.expanded).toBe(false);
		expect(tool.expanded).toBe(false);
	});

	test("reports entries that cannot be collapsed", () => {
		const chat = createChat();
		const tui = createTui(createScrollView(chat));
		setSelectedEntry(chat.children[2]);

		const outcome = toggleSelectedEntry(tui);

		expect(outcome.status).toBe("not-expandable");
		expect(outcome.status === "not-expandable" && outcome.label).toBe("assistant");
	});

	test("reports a stale selection", () => {
		const tui = createTui(createScrollView(createChat()));
		setSelectedEntry(new ToolExecutionComponent());

		expect(toggleSelectedEntry(tui).status).toBe("no-selection");
	});

	test("reports an unavailable transcript", () => {
		const tui = createTui(undefined);
		setSelectedEntry(new ToolExecutionComponent());

		expect(toggleSelectedEntry(tui).status).toBe("unavailable");
	});
});
