import { describe, expect, test } from "bun:test";
import {
	computeEntryPositions,
	findNextEntryTop,
	findPreviousEntryTop,
	getPrimaryScrollView,
	jumpToAdjacentEntry,
	messagePositions,
	navigablePositions,
	scrollReadingArea,
	scrollToEdge,
	type ScrollViewLike,
} from "./scroll";

/** Minimal ScrollView stand-in: clamps like the real one and records calls. */
interface FakeScrollView extends ScrollViewLike {
	calls: number[];
	max: number;
}

function makeScrollView(top = 0, max = 100): FakeScrollView {
	const view: FakeScrollView = {
		scrollTop: top,
		max,
		calls: [],
		scrollBy(delta: number): void {
			view.calls.push(delta);
			view.scrollTop = Math.max(0, Math.min(view.max, view.scrollTop + delta));
		},
		scrollTo(next: number): void {
			view.scrollTop = next;
		},
		primary: true,
	};
	return view;
}

describe("getPrimaryScrollView", () => {
	test("prefers the TUI accessor when it returns a scroll view", () => {
		const view = makeScrollView();
		const tui = { getPrimaryScrollView: () => view };
		expect(getPrimaryScrollView(tui)).toBe(view);
	});

	test("walks layoutRoot children when there is no usable accessor", () => {
		const view = makeScrollView();
		const tui = { layoutRoot: { children: [{ children: [{ children: [view] }] }] } };
		expect(getPrimaryScrollView(tui)).toBe(view);
	});

	test("falls back to walking the TUI itself when layoutRoot is absent", () => {
		const view = makeScrollView();
		const tui = { children: [{ children: [view] }] };
		expect(getPrimaryScrollView(tui)).toBe(view);
	});

	test("ignores an accessor that returns a non-scroll-view", () => {
		const view = makeScrollView();
		const tui = { getPrimaryScrollView: () => ({ nope: true }), children: [view] };
		expect(getPrimaryScrollView(tui)).toBe(view);
	});

	test("skips scroll views that are not flagged primary", () => {
		const secondary = makeScrollView();
		secondary.primary = false;
		const primary = makeScrollView();
		const tui = { children: [secondary, { children: [primary] }] };
		expect(getPrimaryScrollView(tui)).toBe(primary);
	});

	test("returns undefined when nothing looks like a scroll view", () => {
		expect(getPrimaryScrollView(undefined)).toBeUndefined();
		expect(getPrimaryScrollView({})).toBeUndefined();
		expect(getPrimaryScrollView({ children: [{ children: [] }] })).toBeUndefined();
	});
});

describe("scrollReadingArea", () => {
	test("scrolls down for a positive delta and up for a negative one", () => {
		const view = makeScrollView(10);
		const tui = { getPrimaryScrollView: () => view };

		expect(scrollReadingArea(tui, 5)).toBe(true);
		expect(view.calls).toEqual([5]);
		expect(view.scrollTop).toBe(15);

		expect(scrollReadingArea(tui, -3)).toBe(true);
		expect(view.calls).toEqual([5, -3]);
		expect(view.scrollTop).toBe(12);
	});

	test("reports no movement at the scroll boundary", () => {
		const view = makeScrollView(0);
		const tui = { getPrimaryScrollView: () => view };
		expect(scrollReadingArea(tui, -1)).toBe(false);
		expect(view.calls).toEqual([-1]);
	});

	test("prefers a numeric return value when scrollBy provides one", () => {
		const view = {
			scrollTop: 0,
			scrollBy(): number {
				return 0;
			},
			scrollTo(): void {},
			primary: true,
		};
		expect(scrollReadingArea({ getPrimaryScrollView: () => view }, 1)).toBe(false);
	});

	test("does nothing without a scroll view", () => {
		expect(scrollReadingArea({}, 1)).toBe(false);
		expect(scrollReadingArea(undefined, 1)).toBe(false);
	});

	test("ignores zero and non-finite deltas", () => {
		const view = makeScrollView(5);
		const tui = { getPrimaryScrollView: () => view };
		expect(scrollReadingArea(tui, 0)).toBe(false);
		expect(scrollReadingArea(tui, Number.NaN)).toBe(false);
		expect(view.calls).toEqual([]);
	});
});

// --- Phase 3: entry positions and jumps -----------------------------------

// Fake entry components carry the constructor names pi uses, so the tracked-set
// lookup sees them exactly like the real transcript components.
class UserMessageComponent {
	lines: string[];
	constructor(lines: string[] = ["user"]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
}

class AssistantMessageComponent {
	lines: string[];
	constructor(lines: string[] = ["assistant"]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
}

class ToolExecutionComponent {
	lines: string[];
	constructor(lines: string[] = ["tool"]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
}

class NotAnEntryComponent {
	lines: string[];
	constructor(lines: string[] = ["plain"]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
}

describe("computeEntryPositions", () => {
	test("walks children and records entry tops in order", () => {
		const root = {
			children: [
				new NotAnEntryComponent(["header"]), // height 1, not tracked
				new UserMessageComponent(["u1", "u2"]), // top 1, height 2
				new ToolExecutionComponent(["t1", "t2", "t3"]), // top 3, height 3
			],
		};
		expect(
			computeEntryPositions(root, 80).map((p) => [p.component.constructor?.name, p.top, p.height]),
		).toEqual([
			["UserMessageComponent", 1, 2],
			["ToolExecutionComponent", 3, 3],
		]);
	});

	test("prefers recorded mouseLayout heights when the width matches", () => {
		const user = new UserMessageComponent(["u"]);
		const tool = new ToolExecutionComponent(["t"]);
		const root = {
			mouseLayout: {
				width: 80,
				children: [
					{ component: user, height: 7 },
					{ component: tool, height: 4 },
				],
			},
			children: [user, tool],
		};
		const positions = computeEntryPositions(root, 80);
		expect(positions.map((p) => p.height)).toEqual([7, 4]);
		expect(positions.map((p) => p.top)).toEqual([0, 7]);
	});

	test("falls back to render height when the recorded width differs", () => {
		const user = new UserMessageComponent(["a", "b"]);
		const root = {
			mouseLayout: { width: 40, children: [{ component: user, height: 99 }] },
			children: [user],
		};
		expect(computeEntryPositions(root, 80)).toEqual([{ component: user, top: 0, height: 2 }]);
	});

	test("recurses into non-entry containers and preserves their offset", () => {
		const user = new UserMessageComponent(["u"]);
		const tool = new ToolExecutionComponent(["t"]);
		const root = {
			children: [
				new NotAnEntryComponent(["a", "b"]), // 2 unaccounted lines
				{ children: [new NotAnEntryComponent(["x"]), user, tool] }, // nested at top 2
			],
		};
		expect(
			computeEntryPositions(root, 80).map((p) => [p.component.constructor?.name, p.top, p.height]),
		).toEqual([
			["UserMessageComponent", 3, 1],
			["ToolExecutionComponent", 4, 1],
		]);
	});

	test("returns nothing for invalid roots or widths", () => {
		expect(computeEntryPositions(undefined, 80)).toEqual([]);
		expect(computeEntryPositions({}, 0)).toEqual([]);
	});
});

describe("navigablePositions", () => {
	test("drops zero-height entries", () => {
		const user = new UserMessageComponent(["u"]);
		const tool = new ToolExecutionComponent(["t"]);
		expect(
			navigablePositions([
				{ component: user, top: 0, height: 0 },
				{ component: tool, top: 0, height: 3 },
			]).map((p) => p.component),
		).toEqual([tool]);
	});

	test("drops assistant placeholders that hide thinking with no visible text", () => {
		const placeholder = new AssistantMessageComponent([]);
		Object.assign(placeholder, {
			hideThinkingBlock: true,
			lastMessage: { content: [{ type: "thinking", text: "hidden" }] },
		});
		const real = new AssistantMessageComponent(["hi"]);
		Object.assign(real, {
			hideThinkingBlock: true,
			lastMessage: { content: [{ type: "text", text: "hi" }] },
		});
		expect(
			navigablePositions([
				{ component: placeholder, top: 0, height: 1 },
				{ component: real, top: 1, height: 1 },
			]).map((p) => p.component),
		).toEqual([real]);
	});
});

describe("messagePositions", () => {
	test("keeps only user and assistant entries", () => {
		const user = new UserMessageComponent(["u"]);
		const tool = new ToolExecutionComponent(["t"]);
		const assistant = new AssistantMessageComponent(["a"]);
		expect(
			messagePositions([
				{ component: user, top: 0, height: 1 },
				{ component: tool, top: 1, height: 1 },
				{ component: assistant, top: 2, height: 1 },
			]).map((p) => p.component),
		).toEqual([user, assistant]);
	});
});

describe("findNextEntryTop / findPreviousEntryTop", () => {
	const positions = [
		{ component: new UserMessageComponent(["a"]), top: 0, height: 2 },
		{ component: new ToolExecutionComponent(["b"]), top: 5, height: 3 },
		{ component: new AssistantMessageComponent(["c"]), top: 12, height: 1 },
	];

	test("findNextEntryTop is strictly greater than scrollTop", () => {
		expect(findNextEntryTop(positions, 0)).toBe(5);
		expect(findNextEntryTop(positions, 5)).toBe(12);
		expect(findNextEntryTop(positions, 6)).toBe(12);
		expect(findNextEntryTop(positions, 12)).toBeUndefined();
	});

	test("findPreviousEntryTop is strictly less than scrollTop", () => {
		expect(findPreviousEntryTop(positions, 12)).toBe(5);
		expect(findPreviousEntryTop(positions, 5)).toBe(0);
		expect(findPreviousEntryTop(positions, 13)).toBe(12);
		expect(findPreviousEntryTop(positions, 0)).toBeUndefined();
	});

	test("returns undefined for an empty position list", () => {
		expect(findNextEntryTop([], 0)).toBeUndefined();
		expect(findPreviousEntryTop([], 0)).toBeUndefined();
	});
});

describe("jumpToAdjacentEntry", () => {
	function transcript() {
		return {
			children: [
				new NotAnEntryComponent(["header"]),
				new UserMessageComponent(["u"]),
				new ToolExecutionComponent(["t"]),
				new AssistantMessageComponent(["a"]),
			],
		};
	}

	function setup(scrollTop = 0) {
		const view = makeScrollView(scrollTop);
		view.child = transcript();
		const tui = { getPrimaryScrollView: () => view, terminal: { columns: 80 } };
		return { view, tui };
	}

	test("steps over every entry for scope all", () => {
		const { view, tui } = setup(0);
		expect(jumpToAdjacentEntry(tui, 1, "all")).toEqual({ status: "moved", top: 1 });
		expect(view.scrollTop).toBe(1);
		expect(jumpToAdjacentEntry(tui, 1, "all")).toEqual({ status: "moved", top: 2 });
		expect(jumpToAdjacentEntry(tui, 1, "all")).toEqual({ status: "moved", top: 3 });
		expect(jumpToAdjacentEntry(tui, 1, "all")).toEqual({ status: "boundary" });
		expect(view.scrollTop).toBe(3);
	});

	test("skips tools for scope messages", () => {
		const { view, tui } = setup(0);
		expect(jumpToAdjacentEntry(tui, 1, "messages")).toEqual({ status: "moved", top: 1 });
		expect(jumpToAdjacentEntry(tui, 1, "messages")).toEqual({ status: "moved", top: 3 });
		expect(jumpToAdjacentEntry(tui, 1, "messages")).toEqual({ status: "boundary" });
		expect(view.scrollTop).toBe(3);
	});

	test("steps backward strictly above scrollTop", () => {
		const { view, tui } = setup(3);
		expect(jumpToAdjacentEntry(tui, -1, "all")).toEqual({ status: "moved", top: 2 });
		expect(jumpToAdjacentEntry(tui, -1, "all")).toEqual({ status: "moved", top: 1 });
		expect(jumpToAdjacentEntry(tui, -1, "all")).toEqual({ status: "boundary" });
		expect(view.scrollTop).toBe(1);
	});

	test("reports unavailable without a scroll view", () => {
		expect(jumpToAdjacentEntry({}, 1, "all")).toEqual({ status: "unavailable" });
		expect(jumpToAdjacentEntry(undefined, 1, "all")).toEqual({ status: "unavailable" });
	});

	test("reports empty when no navigable entries exist", () => {
		const view = makeScrollView(0);
		view.child = { children: [new NotAnEntryComponent(["header"])] };
		const tui = { getPrimaryScrollView: () => view, terminal: { columns: 80 } };
		expect(jumpToAdjacentEntry(tui, 1, "all")).toEqual({ status: "empty" });
	});
});

describe("scrollToEdge", () => {
	function viewWithEdges(top = 0, max = 100): FakeScrollView & { started?: boolean; ended?: boolean } {
		const view = makeScrollView(top, max) as FakeScrollView & { started?: boolean; ended?: boolean };
		view.scrollToStart = () => {
			view.started = true;
			view.scrollTop = 0;
		};
		view.scrollToEnd = () => {
			view.ended = true;
			view.scrollTop = view.max;
		};
		return view;
	}

	test("uses scrollToStart/scrollToEnd when available", () => {
		const topView = viewWithEdges(5);
		expect(scrollToEdge({ getPrimaryScrollView: () => topView }, "top")).toBe(true);
		expect(topView.started).toBe(true);
		expect(topView.scrollTop).toBe(0);

		const bottomView = viewWithEdges(5);
		expect(scrollToEdge({ getPrimaryScrollView: () => bottomView }, "bottom")).toBe(true);
		expect(bottomView.ended).toBe(true);
		expect(bottomView.scrollTop).toBe(100);
	});

	test("falls back to scrollTo(0) for the top", () => {
		const view = makeScrollView(42);
		expect(scrollToEdge({ getPrimaryScrollView: () => view }, "top")).toBe(true);
		expect(view.scrollTop).toBe(0);
	});

	test("falls back to the computed max for the bottom", () => {
		const view = makeScrollView(0, 100);
		view.viewportHeight = 2;
		view.child = { render: () => Array.from({ length: 10 }, () => "x") };
		const tui = { getPrimaryScrollView: () => view, terminal: { columns: 80 } };
		expect(scrollToEdge(tui, "bottom")).toBe(true);
		expect(view.scrollTop).toBe(8);
	});

	test("returns false without a scroll view", () => {
		expect(scrollToEdge({}, "top")).toBe(false);
		expect(scrollToEdge(undefined, "bottom")).toBe(false);
	});
});
