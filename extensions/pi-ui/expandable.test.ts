import { beforeEach, describe, expect, test } from "bun:test";
import { Container } from "@earendil-works/pi-tui";
import {
	computeEntryPositions,
	findNextEntryTop,
	findPreviousEntryTop,
	installEntryTracking,
	isExpandableEntry,
	isTrackedEntry,
	listTrackedEntries,
	resetEntryTracking,
	scrollToEntry,
	toggleNewestExpandable,
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

class BashExecutionComponent extends FakeEntry {
	expanded = false;
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
}

class AssistantMessageComponent extends FakeEntry {}
class UserMessageComponent extends FakeEntry {}

/** Has setExpanded() but is not a transcript entry (e.g. the startup header). */
class ExpandableText extends FakeEntry {
	expanded = false;
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
}

class PlainText extends FakeEntry {}

interface FakeScrollView extends ScrollViewLike {
	scrollCalls: number[];
}

function createScrollView(content: Container, scrollTop = 0): FakeScrollView {
	const contentHeight = (content.children ?? []).reduce((total, child) => {
		const rendered = typeof (child as { render?: (width: number) => string[] }).render === "function"
			? (child as { render: (width: number) => string[] }).render(80).length
			: 0;
		return total + rendered;
	}, 0);
	const view: FakeScrollView = {
		scrollTop,
		viewportHeight: 1,
		primary: true,
		child: content,
		scrollCalls: [],
		scrollTo(top: number): void {
			this.scrollCalls.push(top);
			this.scrollTop = Math.max(0, Math.min(top, contentHeight - this.viewportHeight));
		},
		scrollBy(): void {},
	};
	return view;
}

installEntryTracking();

beforeEach(() => {
	resetEntryTracking();
});

describe("entry tracking", () => {
	test("tracks entries in append order and ignores other components", () => {
		const container = new Container();
		container.addChild(new PlainText());
		container.addChild(new ExpandableText());
		container.addChild(new ToolExecutionComponent());
		container.addChild(new CustomMessageComponent());
		container.addChild(new AssistantMessageComponent());
		container.addChild(new UserMessageComponent());

		expect(listTrackedEntries()).toEqual([
			"ToolExecutionComponent",
			"CustomMessageComponent",
			"AssistantMessageComponent",
			"UserMessageComponent",
		]);
	});

	test("classifies entries as expandable or not", () => {
		const tool = new ToolExecutionComponent();
		const custom = new CustomMessageComponent();
		const assistant = new AssistantMessageComponent();
		const header = new ExpandableText();

		expect(isTrackedEntry(tool)).toBe(true);
		expect(isTrackedEntry(assistant)).toBe(true);
		expect(isTrackedEntry(header)).toBe(false);
		expect(isExpandableEntry(tool)).toBe(true);
		expect(isExpandableEntry(custom)).toBe(true);
		expect(isExpandableEntry(assistant)).toBe(false);
	});

	test("ignores non-container additions", () => {
		const container = new Container();
		container.addChild(undefined);
		container.addChild("text");
		container.addChild({ setExpanded: () => {} });

		expect(listTrackedEntries()).toEqual([]);
	});

	test("registers each component once", () => {
		const container = new Container();
		const tool = new ToolExecutionComponent();
		container.addChild(tool);
		container.addChild(tool);

		expect(listTrackedEntries()).toEqual(["ToolExecutionComponent"]);
	});

	test("drops entries removed from their container", () => {
		const container = new Container();
		container.addChild(new ToolExecutionComponent());
		const bash = new BashExecutionComponent();
		container.addChild(bash);

		container.removeChild(bash);

		expect(listTrackedEntries()).toEqual(["ToolExecutionComponent"]);
	});

	test("drops entries when the container is cleared", () => {
		const container = new Container();
		container.addChild(new ToolExecutionComponent());
		container.addChild(new BashExecutionComponent());

		container.clear();

		expect(listTrackedEntries()).toEqual([]);
		expect(toggleNewestExpandable()).toBeUndefined();
	});

	test("backfills entries that existed before tracking started", () => {
		const container = new Container();
		container.addChild(new ToolExecutionComponent());
		container.addChild(new AssistantMessageComponent());

		// Simulates `/reload`: the transcript is already rendered, nothing is re-added.
		resetEntryTracking();
		expect(listTrackedEntries()).toEqual([]);

		container.render(80);

		expect(listTrackedEntries()).toEqual(["ToolExecutionComponent", "AssistantMessageComponent"]);
	});

	test("installing twice does not double-track", () => {
		installEntryTracking();

		const container = new Container();
		container.addChild(new ToolExecutionComponent());

		expect(listTrackedEntries()).toEqual(["ToolExecutionComponent"]);
	});
});

describe("toggle newest expandable", () => {
	test("skips entries that cannot be toggled", () => {
		const container = new Container();
		const tool = new ToolExecutionComponent();
		container.addChild(tool);
		container.addChild(new AssistantMessageComponent());
		container.addChild(new UserMessageComponent());

		expect(toggleNewestExpandable()).toEqual({ name: "ToolExecutionComponent", expanded: true });
		expect(tool.expanded).toBe(true);
		expect(tool.invalidations).toBe(1);

		expect(toggleNewestExpandable()).toEqual({ name: "ToolExecutionComponent", expanded: false });
		expect(tool.expanded).toBe(false);
	});

	test("reads the _expanded field used by custom messages", () => {
		const container = new Container();
		const custom = new CustomMessageComponent();
		container.addChild(custom);

		expect(toggleNewestExpandable()?.expanded).toBe(true);
		expect(custom._expanded).toBe(true);
	});

	test("returns undefined without tracked expandable entries", () => {
		const container = new Container();
		container.addChild(new AssistantMessageComponent());

		expect(toggleNewestExpandable()).toBeUndefined();
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

		const positions = computeEntryPositions(document, 80);

		expect(positions.map((position) => [position.top, position.height])).toEqual([
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

		const positions = computeEntryPositions(chat, 80);

		expect(positions.map((position) => [position.top, position.height])).toEqual([
			[0, 4],
			[4, 7],
		]);
	});

	test("ignores invalid roots and widths", () => {
		expect(computeEntryPositions(undefined, 80)).toEqual([]);
		expect(computeEntryPositions(new Container(), 0)).toEqual([]);
	});
});

describe("entry navigation", () => {
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

	test("scrollToEntry aligns entries and clamps at the ends", () => {
		const chat = new Container();
		chat.addChild(new UserMessageComponent(2));
		chat.addChild(new ToolExecutionComponent(5));
		chat.addChild(new AssistantMessageComponent(1));
		chat.mouseLayout = {
			width: 80,
			children: [
				{ component: chat.children[0], height: 2 },
				{ component: chat.children[1], height: 5 },
				{ component: chat.children[2], height: 1 },
			],
		};

		const scrollView = createScrollView(chat);
		const tui = { getPrimaryScrollView: () => scrollView, terminal: { columns: 80 } };

		expect(scrollToEntry(tui, 1)).toEqual({ index: 1, total: 3, name: "ToolExecutionComponent", top: 2 });
		expect(scrollToEntry(tui, 1)).toEqual({ index: 2, total: 3, name: "AssistantMessageComponent", top: 7 });

		// Past the last entry: request the document end.
		expect(scrollToEntry(tui, 1)).toEqual({ index: -1, total: 3, name: "start/end", top: Number.MAX_SAFE_INTEGER });

		// Back up to the first entry, then to the very top.
		expect(scrollToEntry(tui, -1)).toEqual({ index: 1, total: 3, name: "ToolExecutionComponent", top: 2 });
		expect(scrollToEntry(tui, -1)).toEqual({ index: 0, total: 3, name: "UserMessageComponent", top: 0 });
		expect(scrollToEntry(tui, -1)).toEqual({ index: -1, total: 3, name: "start/end", top: 0 });

		expect(scrollView.scrollCalls).toEqual([2, 7, Number.MAX_SAFE_INTEGER, 2, 0, 0]);
	});

	test("scrollToEntry finds the scroll view by walking the layout tree", () => {
		const chat = new Container();
		chat.addChild(new UserMessageComponent(1));
		chat.addChild(new ToolExecutionComponent(3));
		chat.addChild(new AssistantMessageComponent(3));
		chat.mouseLayout = {
			width: 80,
			children: [
				{ component: chat.children[0], height: 1 },
				{ component: chat.children[1], height: 3 },
				{ component: chat.children[2], height: 3 },
			],
		};

		const scrollView = createScrollView(chat);
		const tui = {
			mode: "fullscreen",
			layoutRoot: { children: [{ children: [scrollView] }] },
			terminal: { columns: 80 },
		};

		expect(scrollToEntry(tui, 1)?.name).toBe("ToolExecutionComponent");
		expect(scrollToEntry(tui, 1)?.name).toBe("AssistantMessageComponent");
	});

	test("scrollToEntry reports unavailability instead of throwing", () => {
		expect(scrollToEntry(undefined, 1)).toBeUndefined();
		expect(scrollToEntry({ terminal: { columns: 80 } }, 1)).toBeUndefined();

		const empty = new Container();
		const scrollView = createScrollView(empty);
		expect(scrollToEntry({ getPrimaryScrollView: () => scrollView }, 1)).toBeUndefined();
	});
});
