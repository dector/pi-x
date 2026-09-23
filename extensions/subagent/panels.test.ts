import { describe, expect, test } from "bun:test";
import {
	SUBAGENT_PANEL_ID,
	SUBAGENT_PANEL_LABEL,
	SUBAGENT_PANEL_ORDER,
	SubagentPanelBridge,
	isSubagentPanelCollapsed,
} from "./panels.ts";

describe("subagent panel id", () => {
	test("uses the agreed contract values", () => {
		expect(SUBAGENT_PANEL_ID).toBe("subagents");
		expect(SUBAGENT_PANEL_LABEL).toBe("Subagents");
		expect(SUBAGENT_PANEL_ORDER).toBe(10);
	});
});

describe("isSubagentPanelCollapsed", () => {
	test("stays collapsed while no coordinator has broadcast", () => {
		expect(isSubagentPanelCollapsed(undefined, false)).toBe(true);
	});

	test("expands only when the subagent panel is active", () => {
		expect(isSubagentPanelCollapsed(SUBAGENT_PANEL_ID, false)).toBe(false);
	});

	test("collapses when all panels are collapsed", () => {
		expect(isSubagentPanelCollapsed(null, false)).toBe(true);
	});

	test("collapses when another panel is active", () => {
		expect(isSubagentPanelCollapsed("processes", false)).toBe(true);
	});

	test("watch suppression collapses regardless of the active panel", () => {
		expect(isSubagentPanelCollapsed(SUBAGENT_PANEL_ID, true)).toBe(true);
		expect(isSubagentPanelCollapsed(undefined, true)).toBe(true);
	});
});

describe("SubagentPanelBridge", () => {
	test("defaults to collapsed before any broadcast", () => {
		const bridge = new SubagentPanelBridge(() => {});
		expect(bridge.collapsed).toBe(true);
	});

	test("applies the active broadcast to the widget", () => {
		const applied: boolean[] = [];
		const bridge = new SubagentPanelBridge((collapsed) => applied.push(collapsed));

		bridge.handleActive(SUBAGENT_PANEL_ID);
		expect(applied).toEqual([false]);
		bridge.handleActive("processes");
		expect(applied).toEqual([false, true]);
		bridge.handleActive(null);
		expect(applied).toEqual([false, true, true]);
	});

	test("an explicit collapsed broadcast keeps the widget collapsed", () => {
		const applied: boolean[] = [];
		const bridge = new SubagentPanelBridge((collapsed) => applied.push(collapsed));
		bridge.handleActive(null);
		expect(applied).toEqual([true]);
		expect(bridge.collapsed).toBe(true);
	});

	test("watch restore re-derives from the current cycle change", () => {
		const applied: boolean[] = [];
		const bridge = new SubagentPanelBridge((collapsed) => applied.push(collapsed));

		// Widget expanded because subagents is active.
		bridge.handleActive(SUBAGENT_PANEL_ID);
		expect(bridge.collapsed).toBe(false);

		// Watch opens: suppress to collapsed.
		bridge.setWatchSuppress(true);
		expect(bridge.collapsed).toBe(true);

		// The user cycles to another panel while Watch is open.
		bridge.handleActive("processes");
		expect(bridge.collapsed).toBe(true);

		// Watch closes: the restore must not override the cycle change.
		bridge.setWatchSuppress(false);
		expect(bridge.collapsed).toBe(true);

		// Cycling back to subagents expands again.
		bridge.handleActive(SUBAGENT_PANEL_ID);
		expect(bridge.collapsed).toBe(false);

		expect(applied).toEqual([false, true, true, true, false]);
	});

	test("watch suppression is idempotent", () => {
		const applied: boolean[] = [];
		const bridge = new SubagentPanelBridge((collapsed) => applied.push(collapsed));
		bridge.handleActive(SUBAGENT_PANEL_ID);
		bridge.setWatchSuppress(true);
		bridge.setWatchSuppress(true);
		bridge.setWatchSuppress(false);
		bridge.setWatchSuppress(false);
		expect(applied).toEqual([false, true, false]);
	});

	test("visibility announcements are de-duplicated", () => {
		const bridge = new SubagentPanelBridge(() => {});
		expect(bridge.noteVisibility(false)).toBe(true);
		expect(bridge.noteVisibility(false)).toBe(false);
		expect(bridge.noteVisibility(true)).toBe(true);
		expect(bridge.noteVisibility(true)).toBe(false);
	});

	test("reset forgets active, suppression, and visibility", () => {
		const bridge = new SubagentPanelBridge(() => {});
		bridge.handleActive("processes");
		bridge.setWatchSuppress(true);
		bridge.noteVisibility(true);
		bridge.reset();
		expect(bridge.collapsed).toBe(true);
		expect(bridge.noteVisibility(true)).toBe(true);
	});
});
