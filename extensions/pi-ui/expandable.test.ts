import { beforeEach, describe, expect, test } from "bun:test";
import { Container } from "@earendil-works/pi-tui";
import {
	installExpandableTracking,
	listTrackedExpandables,
	resetExpandableTracking,
	toggleNewestExpandable,
} from "./index";

/** Stand-ins for pi transcript components (matched by constructor name). */
class ToolExecutionComponent {
	expanded = false;
	invalidations = 0;
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	invalidate(): void {
		this.invalidations += 1;
	}
}

class CustomMessageComponent {
	_expanded = false;
	setExpanded(expanded: boolean): void {
		this._expanded = expanded;
	}
}

class BashExecutionComponent {
	expanded = false;
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
}

/** Has setExpanded() but is not a transcript entry (e.g. the startup header). */
class ExpandableText {
	expanded = false;
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
}

class PlainText {}

installExpandableTracking();

beforeEach(() => {
	resetExpandableTracking();
});

describe("expandable tracking", () => {
	test("tracks whitelisted expandable entries in append order", () => {
		const container = new Container();
		container.addChild(new PlainText());
		container.addChild(new ExpandableText());
		container.addChild(new ToolExecutionComponent());
		container.addChild(new CustomMessageComponent());

		expect(listTrackedExpandables()).toEqual(["ToolExecutionComponent", "CustomMessageComponent"]);
	});

	test("ignores non-container additions", () => {
		const container = new Container();
		container.addChild(undefined);
		container.addChild("text");
		container.addChild({ setExpanded: () => {} });

		expect(listTrackedExpandables()).toEqual([]);
	});

	test("registers each component once", () => {
		const container = new Container();
		const tool = new ToolExecutionComponent();
		container.addChild(tool);
		container.addChild(tool);

		expect(listTrackedExpandables()).toEqual(["ToolExecutionComponent"]);
	});

	test("toggles only the newest entry", () => {
		const container = new Container();
		const older = new ToolExecutionComponent();
		const newer = new CustomMessageComponent();
		container.addChild(older);
		container.addChild(newer);

		expect(toggleNewestExpandable()).toEqual({ name: "CustomMessageComponent", expanded: true });
		expect(newer._expanded).toBe(true);
		expect(older.expanded).toBe(false);

		expect(toggleNewestExpandable()).toEqual({ name: "CustomMessageComponent", expanded: false });
		expect(newer._expanded).toBe(false);

		expect(toggleNewestExpandable()).toEqual({ name: "CustomMessageComponent", expanded: true });
		expect(older.expanded).toBe(false);
	});

	test("invalidates the toggled entry", () => {
		const container = new Container();
		const tool = new ToolExecutionComponent();
		container.addChild(tool);

		toggleNewestExpandable();

		expect(tool.invalidations).toBe(1);
	});

	test("returns undefined without tracked entries", () => {
		expect(toggleNewestExpandable()).toBeUndefined();
	});

	test("drops entries removed from their container", () => {
		const container = new Container();
		const tool = new ToolExecutionComponent();
		const bash = new BashExecutionComponent();
		container.addChild(tool);
		container.addChild(bash);

		container.removeChild(bash);

		expect(listTrackedExpandables()).toEqual(["ToolExecutionComponent"]);
		expect(toggleNewestExpandable()?.name).toBe("ToolExecutionComponent");
	});

	test("drops entries when the container is cleared", () => {
		const container = new Container();
		container.addChild(new ToolExecutionComponent());
		container.addChild(new BashExecutionComponent());

		container.clear();

		expect(listTrackedExpandables()).toEqual([]);
		expect(toggleNewestExpandable()).toBeUndefined();
	});

	test("keeps other containers untouched when one is cleared", () => {
		const first = new Container();
		const second = new Container();
		first.addChild(new ToolExecutionComponent());
		second.addChild(new BashExecutionComponent());

		first.clear();

		expect(listTrackedExpandables()).toEqual(["BashExecutionComponent"]);
	});

	test("reset forgets tracked entries", () => {
		const container = new Container();
		container.addChild(new ToolExecutionComponent());

		resetExpandableTracking();

		expect(listTrackedExpandables()).toEqual([]);
	});

	test("installing twice does not double-track", () => {
		installExpandableTracking();

		const container = new Container();
		container.addChild(new ToolExecutionComponent());

		expect(listTrackedExpandables()).toEqual(["ToolExecutionComponent"]);
	});
});
