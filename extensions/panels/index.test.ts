import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	PANELS_ACTIVE_EVENT,
	PANELS_CONTENT_EVENT,
	PANELS_REGISTER_EVENT,
	PANELS_SYNC_EVENT,
	PANELS_VISIBILITY_EVENT,
	type PanelActive,
} from "./contract.ts";
import panelsExtension from "./index.ts";
import { PANELS_WIDGET_ID } from "./widget.ts";

interface FakeBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

interface FakeComponent {
	render(width: number): string[];
	invalidate(): void;
}

interface Harness {
	pi: ExtensionAPI;
	bus: FakeBus;
	active: Array<string | null>;
	shortcuts: Map<string, (ctx: ExtensionContext) => void>;
	lifecycle: Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>;
	ctx: ExtensionContext;
	component(): FakeComponent | undefined;
	widgetCalls: Array<{ kind: "mount" | "clear"; placement?: string }>;
	requestRenders(): number;
	startSession(): void;
}

function createHarness(): Harness {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const bus: FakeBus = {
		emit(channel, data) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
	};

	const active: Array<string | null> = [];
	const shortcuts = new Map<string, (ctx: ExtensionContext) => void>();
	const lifecycle = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();

	let mounted: FakeComponent | undefined;
	let renders = 0;
	const widgetCalls: Array<{ kind: "mount" | "clear"; placement?: string }> = [];
	const tui = {
		requestRender: () => {
			renders += 1;
		},
	};
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	const ui = {
		setWidget: (
			key: string,
			content: ((tui: unknown, theme: unknown) => FakeComponent) | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		) => {
			expect(key).toBe(PANELS_WIDGET_ID);
			if (content === undefined) {
				mounted = undefined;
				widgetCalls.push({ kind: "clear", placement: options?.placement });
				return;
			}
			mounted = content(tui, theme);
			widgetCalls.push({ kind: "mount", placement: options?.placement });
		},
		notify: () => {},
		theme,
	};
	const ctx = { hasUI: true, ui } as unknown as ExtensionContext;

	const pi = {
		events: {
			emit: (channel: string, data: unknown) => {
				if (channel === PANELS_ACTIVE_EVENT) active.push((data as PanelActive).activeId);
				bus.emit(channel, data);
			},
			on: bus.on,
		},
		registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => void }) => {
			shortcuts.set(key, options.handler);
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			const list = lifecycle.get(event) ?? [];
			list.push(handler);
			lifecycle.set(event, list);
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		bus,
		active,
		shortcuts,
		lifecycle,
		ctx,
		component: () => mounted,
		widgetCalls,
		requestRenders: () => renders,
		startSession: () => {
			for (const handler of lifecycle.get("session_start") ?? []) handler({}, ctx);
		},
	};
}

const ALT_P = Key.alt("p");
const ALT_SHIFT_P = Key.altShift("p");
const identityRender = (content: readonly string[]) => [...content];

function registerPanel(harness: Harness, id: string, order: number, visible = true): void {
	harness.bus.emit(PANELS_REGISTER_EVENT, { id, label: id, order, visible });
}

function publishContent(harness: Harness, id: string, content: string[] | undefined): void {
	harness.bus.emit(PANELS_CONTENT_EVENT, { id, content, render: identityRender });
}

describe("panels coordinator wiring", () => {
	test("registers Alt+P and Alt+Shift+P exactly once", () => {
		const { pi, shortcuts } = createHarness();
		panelsExtension(pi);
		expect([...shortcuts.keys()].sort()).toEqual([ALT_P, ALT_SHIFT_P].sort());
	});

	test("broadcasts the collapsed default on register and sync", () => {
		const { pi, bus, active } = createHarness();
		panelsExtension(pi);

		bus.emit(PANELS_REGISTER_EVENT, { id: "subagents", label: "Subagents", order: 10, visible: false });
		bus.emit(PANELS_REGISTER_EVENT, { id: "processes", label: "Processes", order: 20, visible: true });
		bus.emit(PANELS_SYNC_EVENT, {});

		expect(active).toEqual([null, null, null]);
	});

	test("Alt+P cycles null -> subagents -> processes -> null", () => {
		const { pi, bus, active, shortcuts, ctx } = createHarness();
		panelsExtension(pi);
		bus.emit(PANELS_REGISTER_EVENT, { id: "subagents", label: "Subagents", order: 10, visible: true });
		bus.emit(PANELS_REGISTER_EVENT, { id: "processes", label: "Processes", order: 20, visible: true });
		active.length = 0;

		const handler = shortcuts.get(ALT_P);
		handler?.(ctx);
		expect(active).toEqual(["subagents"]);
		handler?.(ctx);
		expect(active).toEqual(["subagents", "processes"]);
		handler?.(ctx);
		expect(active).toEqual(["subagents", "processes", null]);
	});

	test("Alt+Shift+P walks null -> processes -> subagents -> null", () => {
		const { pi, bus, active, shortcuts, ctx } = createHarness();
		panelsExtension(pi);
		bus.emit(PANELS_REGISTER_EVENT, { id: "subagents", label: "Subagents", order: 10, visible: true });
		bus.emit(PANELS_REGISTER_EVENT, { id: "processes", label: "Processes", order: 20, visible: true });
		active.length = 0;

		const handler = shortcuts.get(ALT_SHIFT_P);
		handler?.(ctx);
		expect(active).toEqual(["processes"]);
		handler?.(ctx);
		expect(active).toEqual(["processes", "subagents"]);
		handler?.(ctx);
		expect(active).toEqual(["processes", "subagents", null]);
	});

	test("visibility collapse reaches the panels", () => {
		const { pi, bus, active, shortcuts, ctx } = createHarness();
		panelsExtension(pi);
		bus.emit(PANELS_REGISTER_EVENT, { id: "subagents", label: "Subagents", order: 10, visible: true });
		shortcuts.get(ALT_P)?.(ctx);
		active.length = 0;
		bus.emit(PANELS_VISIBILITY_EVENT, { id: "subagents", visible: false });
		expect(active).toEqual([null]);
	});
});

describe("panels single widget", () => {
	test("mounts one px-panels component and stacks panels in order", () => {
		const harness = createHarness();
		panelsExtension(harness.pi);
		harness.startSession();
		registerPanel(harness, "subagents", 10, true);
		registerPanel(harness, "processes", 20);

		// Processes publishes first: arrival order must not change display order.
		publishContent(harness, "processes", ["P"]);
		publishContent(harness, "subagents", ["S"]);

		expect(harness.widgetCalls).toEqual([{ kind: "mount", placement: "aboveEditor" }]);
		expect(harness.component()?.render(20)).toEqual(["S", "P"]);
	});

	test("a refresh updates the mounted component without remounting", () => {
		const harness = createHarness();
		panelsExtension(harness.pi);
		harness.startSession();
		registerPanel(harness, "subagents", 10, true);
		registerPanel(harness, "processes", 20);
		publishContent(harness, "subagents", ["S"]);
		publishContent(harness, "processes", ["P"]);
		const before = harness.requestRenders();

		publishContent(harness, "processes", ["P2"]);

		expect(harness.widgetCalls).toEqual([{ kind: "mount", placement: "aboveEditor" }]);
		expect(harness.requestRenders()).toBeGreaterThan(before);
		expect(harness.component()?.render(20)).toEqual(["S", "P2"]);
	});

	test("undefined content removes the panel and clears the widget when empty", () => {
		const harness = createHarness();
		panelsExtension(harness.pi);
		harness.startSession();
		registerPanel(harness, "subagents", 10, true);
		registerPanel(harness, "processes", 20);
		publishContent(harness, "subagents", ["S"]);
		publishContent(harness, "processes", ["P"]);

		publishContent(harness, "subagents", undefined);
		expect(harness.component()?.render(20)).toEqual(["P"]);

		publishContent(harness, "processes", undefined);
		expect(harness.widgetCalls[harness.widgetCalls.length - 1]).toEqual({ kind: "clear", placement: "aboveEditor" });
	});

	test("content published before session_start mounts when the context arrives", () => {
		const harness = createHarness();
		panelsExtension(harness.pi);
		registerPanel(harness, "processes", 20);
		publishContent(harness, "processes", ["P"]);
		expect(harness.component()).toBeUndefined();

		harness.startSession();
		expect(harness.component()?.render(20)).toEqual(["P"]);
	});

	test("a late registration mounts content that arrived before it", () => {
		const harness = createHarness();
		panelsExtension(harness.pi);
		harness.startSession();
		publishContent(harness, "processes", ["P"]);
		expect(harness.component()).toBeUndefined();

		registerPanel(harness, "processes", 20);
		expect(harness.component()?.render(20)).toEqual(["P"]);
	});

	test("session_shutdown clears the widget and drops every bus subscription", () => {
		const harness = createHarness();
		panelsExtension(harness.pi);
		harness.startSession();
		registerPanel(harness, "subagents", 10, true);
		publishContent(harness, "subagents", ["S"]);
		for (const handler of harness.lifecycle.get("session_shutdown") ?? []) handler({}, harness.ctx);

		expect(harness.widgetCalls[harness.widgetCalls.length - 1]?.kind).toBe("clear");
		harness.active.length = 0;
		harness.bus.emit(PANELS_REGISTER_EVENT, { id: "subagents", label: "Subagents", order: 10, visible: true });
		harness.bus.emit(PANELS_SYNC_EVENT, {});
		expect(harness.active).toEqual([]);
	});
});
