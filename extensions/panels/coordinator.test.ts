import { describe, expect, test } from "bun:test";
import {
	PANELS_ACTIVE_EVENT,
	PANELS_CONTENT_EVENT,
	PANELS_REGISTER_EVENT,
	PANELS_SYNC_EVENT,
	PANELS_VISIBILITY_EVENT,
	parsePanelActive,
	parsePanelContent,
	parsePanelRegistration,
	parsePanelVisibility,
} from "./contract.ts";
import { PanelCoordinator } from "./coordinator.ts";

/** Minimal panel content payload for ordering tests. */
function content(id: string, lines: string[] | undefined) {
	return { id, content: lines, render: (value: readonly string[]) => [...value] };
}

function makeCoordinator(): { coordinator: PanelCoordinator; active: Array<string | null> } {
	const active: Array<string | null> = [];
	const coordinator = new PanelCoordinator({ onActive: (id) => active.push(id) });
	return { coordinator, active };
}

function register(
	coordinator: PanelCoordinator,
	id: string,
	order: number,
	visible = true,
): void {
	coordinator.register({ id, label: id, order, visible });
}

describe("panel event contract", () => {
	test("exposes the documented channels", () => {
		expect(PANELS_REGISTER_EVENT).toBe("px:panels:register");
		expect(PANELS_VISIBILITY_EVENT).toBe("px:panels:visibility");
		expect(PANELS_CONTENT_EVENT).toBe("px:panels:content");
		expect(PANELS_SYNC_EVENT).toBe("px:panels:sync");
		expect(PANELS_ACTIVE_EVENT).toBe("px:panels:active");
	});

	test("parses a valid registration and drops malformed ones", () => {
		expect(parsePanelRegistration({ id: "subagents", label: "Subagents", order: 10, visible: false })).toEqual({
			id: "subagents",
			label: "Subagents",
			order: 10,
			visible: false,
		});
		expect(parsePanelRegistration({ id: "x", label: "X", order: 1, visible: true })).toEqual({
			id: "x",
			label: "X",
			order: 1,
			visible: true,
		});
		expect(parsePanelRegistration(null)).toBeUndefined();
		expect(parsePanelRegistration({ id: "", label: "X", order: 1, visible: true })).toBeUndefined();
		expect(parsePanelRegistration({ id: "x", label: "X", order: Number.NaN, visible: true })).toBeUndefined();
		expect(parsePanelRegistration({ id: "x", label: "X", order: 1, visible: "yes" })).toBeUndefined();
	});

	test("ignores obsolete home metadata", () => {
		// `home` no longer selects anything; it is dropped from the parsed payload.
		const parsed = parsePanelRegistration({ id: "subagents", label: "Subagents", order: 10, home: true, visible: true });
		expect(parsed).toEqual({ id: "subagents", label: "Subagents", order: 10, visible: true });
	});

	test("parses visibility and active payloads", () => {
		expect(parsePanelVisibility({ id: "subagents", visible: false })).toEqual({ id: "subagents", visible: false });
		expect(parsePanelVisibility({ id: "subagents" })).toBeUndefined();
		expect(parsePanelActive({ activeId: null })).toEqual({ activeId: null });
		expect(parsePanelActive({ activeId: "subagents" })).toEqual({ activeId: "subagents" });
		expect(parsePanelActive({ activeId: 3 })).toBeUndefined();
	});

	test("parses a content payload and drops malformed ones", () => {
		const render = (lines: readonly string[]) => [...lines];
		expect(parsePanelContent({ id: "subagents", content: ["a"], render })).toEqual({ id: "subagents", content: ["a"], render });
		expect(parsePanelContent({ id: "subagents", content: undefined, render })).toEqual({ id: "subagents", content: undefined, render });
		expect(parsePanelContent(null)).toBeUndefined();
		expect(parsePanelContent({ id: "", content: ["a"], render })).toBeUndefined();
		expect(parsePanelContent({ id: "subagents", content: ["a"] })).toBeUndefined();
		expect(parsePanelContent({ id: "subagents", content: "a", render })).toBeUndefined();
		expect(parsePanelContent({ id: "subagents", content: [1], render })).toBeUndefined();
	});
});

describe("panel coordinator defaults", () => {
	test("starts with every panel collapsed", () => {
		const { coordinator } = makeCoordinator();
		expect(coordinator.active).toBeNull();
	});

	test("registering a visible panel does not expand it", () => {
		const { coordinator, active } = makeCoordinator();
		register(coordinator, "subagents", 10);
		expect(coordinator.active).toBeNull();
		// The register broadcast is the collapsed default.
		expect(active).toEqual([null]);
	});

	test("rebroadcasts the active id on every registration", () => {
		const { coordinator, active } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20);
		expect(active).toEqual([null, null]);
	});

	test("registration order never selects a panel", () => {
		const { coordinator } = makeCoordinator();
		// Proc can load before subagent; neither becomes the default.
		register(coordinator, "processes", 20);
		expect(coordinator.active).toBeNull();
		register(coordinator, "subagents", 10);
		expect(coordinator.active).toBeNull();
	});

	test("uses order then id for a stable cycle", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "b", 10);
		register(coordinator, "a", 10);
		register(coordinator, "c", 20);
		expect(coordinator.list().map((panel) => panel.id)).toEqual(["a", "b", "c"]);
	});
});

describe("panel coordinator cycle", () => {
	test("cycles null -> subagents -> processes -> null", () => {
		const { coordinator, active } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20);
		active.length = 0;

		coordinator.cycle();
		expect(coordinator.active).toBe("subagents");
		coordinator.cycle();
		expect(coordinator.active).toBe("processes");
		coordinator.cycle();
		expect(coordinator.active).toBeNull();
		expect(active).toEqual(["subagents", "processes", null]);
	});

	test("uses order rather than registration order for the forward cycle", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "processes", 20);
		register(coordinator, "subagents", 10);
		coordinator.cycle();
		expect(coordinator.active).toBe("subagents");
		coordinator.cycle();
		expect(coordinator.active).toBe("processes");
		coordinator.cycle();
		expect(coordinator.active).toBeNull();
	});

	test("skips invisible panels", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10, false);
		register(coordinator, "processes", 20);
		coordinator.cycle();
		expect(coordinator.active).toBe("processes");
		coordinator.cycle();
		expect(coordinator.active).toBeNull();
		coordinator.cycle();
		expect(coordinator.active).toBe("processes");
	});

	test("collapses when nothing is visible", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10, false);
		coordinator.cycle();
		expect(coordinator.active).toBeNull();
	});

	test("a user's collapsed choice survives register and sync", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10);
		coordinator.cycle();
		expect(coordinator.active).toBe("subagents");
		coordinator.cycle();
		expect(coordinator.active).toBeNull();

		register(coordinator, "processes", 20);
		expect(coordinator.active).toBeNull();
		coordinator.sync();
		expect(coordinator.active).toBeNull();
	});
});

describe("panel coordinator reverse cycle", () => {
	test("cycles null -> processes -> subagents -> null", () => {
		const { coordinator, active } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20);
		active.length = 0;

		coordinator.cycleBackward();
		expect(coordinator.active).toBe("processes");
		coordinator.cycleBackward();
		expect(coordinator.active).toBe("subagents");
		coordinator.cycleBackward();
		expect(coordinator.active).toBeNull();
		expect(active).toEqual(["processes", "subagents", null]);
	});

	test("skips invisible panels in reverse", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20, false);
		coordinator.cycleBackward();
		expect(coordinator.active).toBe("subagents");
		coordinator.cycleBackward();
		expect(coordinator.active).toBeNull();
	});

	test("collapses when nothing is visible", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10, false);
		coordinator.cycleBackward();
		expect(coordinator.active).toBeNull();
	});

	test("forward and reverse are inverses in steady state", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20);
		coordinator.cycle();
		expect(coordinator.active).toBe("subagents");
		coordinator.cycleBackward();
		expect(coordinator.active).toBeNull();
		coordinator.cycleBackward();
		expect(coordinator.active).toBe("processes");
		coordinator.cycle();
		expect(coordinator.active).toBeNull();
	});
});

describe("panel coordinator visibility", () => {
	test("collapses all when the active panel disappears", () => {
		const { coordinator, active } = makeCoordinator();
		register(coordinator, "subagents", 10);
		coordinator.cycle();
		expect(coordinator.active).toBe("subagents");
		active.length = 0;

		coordinator.setVisibility("subagents", false);
		expect(coordinator.active).toBeNull();
		expect(active).toEqual([null]);
	});

	test("keeps the active panel when another panel disappears", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20);
		coordinator.cycle();
		coordinator.setVisibility("processes", false);
		expect(coordinator.active).toBe("subagents");
	});

	test("ignores visibility for unknown panels", () => {
		const { coordinator, active } = makeCoordinator();
		register(coordinator, "subagents", 10);
		active.length = 0;
		coordinator.setVisibility("ghost", false);
		expect(active).toEqual([]);
	});

	test("a disappearance stays collapsed until a cycle key", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10);
		coordinator.cycle();
		coordinator.setVisibility("subagents", false);
		expect(coordinator.active).toBeNull();
		coordinator.setVisibility("subagents", true);
		expect(coordinator.active).toBeNull();
		// A later registration must not sneak any panel back in either.
		register(coordinator, "subagents", 10);
		expect(coordinator.active).toBeNull();
		// Only an explicit cycle selects it again.
		coordinator.cycle();
		expect(coordinator.active).toBe("subagents");
	});

	test("does not steal the active panel when another panel reappears", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20, false);
		coordinator.cycle();
		expect(coordinator.active).toBe("subagents");
		coordinator.setVisibility("processes", true);
		expect(coordinator.active).toBe("subagents");
	});

	test("re-registering the active panel invisible collapses all", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20);
		coordinator.cycle();
		coordinator.cycle();
		expect(coordinator.active).toBe("processes");
		// Re-registering the invisible active panel is a disappearance.
		register(coordinator, "processes", 20, false);
		expect(coordinator.active).toBeNull();
	});

	test("unregistering the active panel collapses all", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20);
		coordinator.cycle();
		coordinator.cycle();
		coordinator.unregister("processes");
		expect(coordinator.active).toBeNull();
	});

	test("sync rebroadcasts without changing the active panel", () => {
		const { coordinator, active } = makeCoordinator();
		register(coordinator, "subagents", 10);
		active.length = 0;
		coordinator.sync();
		expect(active).toEqual([null]);

		coordinator.cycle();
		active.length = 0;
		coordinator.sync();
		expect(active).toEqual(["subagents"]);
		expect(coordinator.active).toBe("subagents");
	});
});

describe("panel coordinator content", () => {
	test("renders registered panels in order even when content arrives reversed", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20);
		// Processes publishes first, subagents second: arrival order must not matter.
		coordinator.setContent(content("processes", ["P"]));
		coordinator.setContent(content("subagents", ["S"]));
		expect(coordinator.renderAll(10)).toEqual(["S", "P"]);
	});

	test("a refresh keeps order and does not duplicate lines", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20);
		coordinator.setContent(content("subagents", ["S1"]));
		coordinator.setContent(content("processes", ["P1"]));
		coordinator.setContent(content("subagents", ["S2", "S3"]));
		expect(coordinator.renderAll(10)).toEqual(["S2", "S3", "P1"]);
	});

	test("undefined content removes a panel and empties the widget", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20);
		coordinator.setContent(content("subagents", ["S"]));
		coordinator.setContent(content("processes", ["P"]));
		expect(coordinator.hasContent()).toBe(true);

		coordinator.setContent(content("subagents", undefined));
		expect(coordinator.renderAll(10)).toEqual(["P"]);
		coordinator.setContent(content("processes", []));
		expect(coordinator.hasContent()).toBe(false);
		expect(coordinator.renderAll(10)).toEqual([]);
	});

	test("content published before registration renders once the panel registers", () => {
		const { coordinator } = makeCoordinator();
		coordinator.setContent(content("processes", ["P"]));
		expect(coordinator.renderAll(10)).toEqual([]);
		register(coordinator, "processes", 20);
		expect(coordinator.renderAll(10)).toEqual(["P"]);
	});

	test("unregister drops cached content", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "processes", 20);
		coordinator.setContent(content("processes", ["P"]));
		coordinator.unregister("processes");
		expect(coordinator.hasContent()).toBe(false);
	});

	test("clear forgets panels, content, and the collapsed selection", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "processes", 20);
		coordinator.cycle();
		expect(coordinator.active).toBe("processes");
		coordinator.setContent(content("processes", ["P"]));
		coordinator.clear();
		expect(coordinator.hasContent()).toBe(false);
		expect(coordinator.list()).toEqual([]);
		expect(coordinator.active).toBeNull();
	});

	test("onContent fires on content, register, and unregister", () => {
		const calls: number[] = [];
		const coordinator = new PanelCoordinator({ onContent: () => calls.push(1) });
		register(coordinator, "processes", 20);
		coordinator.setContent(content("processes", ["P"]));
		coordinator.unregister("processes");
		expect(calls).toHaveLength(3);
	});

	test("register refreshes content cached before the panel registered", () => {
		const refreshes: number[] = [];
		const coordinator = new PanelCoordinator({ onContent: () => refreshes.push(1) });
		coordinator.setContent(content("processes", ["P"]));
		expect(coordinator.hasContent()).toBe(false);
		register(coordinator, "processes", 20);
		// The register refresh is what lets the widget mount the cached content.
		expect(refreshes).toHaveLength(2);
		expect(coordinator.hasContent()).toBe(true);
	});

	test("a broken panel renderer does not blank the other panels", () => {
		const { coordinator } = makeCoordinator();
		register(coordinator, "subagents", 10);
		register(coordinator, "processes", 20);
		coordinator.setContent({ id: "subagents", content: ["S"], render: () => { throw new Error("boom"); } });
		coordinator.setContent(content("processes", ["P"]));
		expect(coordinator.renderAll(10)).toEqual(["P"]);
	});
});
