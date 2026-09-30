import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import piUiExtension, { renderStartupMark } from "./index";
import { STARTUP_MOTTOS, pickStartupMotto } from "./startup-mottos";

const RESET = "\x1b[39m";
const CYAN_TRUE = "\x1b[38;2;1;205;254m";
const PINK_TRUE = "\x1b[38;2;255;113;206m";
const PURPLE_TRUE = "\x1b[38;2;185;103;255m";
const DUSTY_BLUE_TRUE = "\x1b[38;2;120;155;181m";

function stripAnsi(input: string): string {
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("startup header mark", () => {
	test("paints /ᴘx▌ with the synthwave truecolor palette", () => {
		expect(renderStartupMark({ getColorMode: () => "truecolor" })).toBe(
			`${CYAN_TRUE}/${RESET}${PINK_TRUE}ᴘ${RESET}${PURPLE_TRUE}x${RESET}${DUSTY_BLUE_TRUE}▌${RESET}`,
		);
	});

	test("falls back to the nearest xterm-256 colours", () => {
		expect(renderStartupMark({ getColorMode: () => "256color" })).toBe(
			`\x1b[38;5;45m/${RESET}\x1b[38;5;206mᴘ${RESET}\x1b[38;5;135mx${RESET}\x1b[38;5;103m▌${RESET}`,
		);
	});

	test("defaults to truecolor without a theme or colour mode", () => {
		expect(renderStartupMark()).toBe(renderStartupMark({ getColorMode: () => "truecolor" }));
		expect(renderStartupMark({})).toBe(renderStartupMark({ getColorMode: () => "truecolor" }));
	});
});

type HeaderFactory = (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void };

interface ExtensionHarness {
	handlers: Map<string, (event: unknown, ctx: unknown) => Promise<void>>;
	headerFactories: HeaderFactory[];
	ctx: Record<string, unknown>;
}

function createHarness(mode: string, hasUI = true, withHeader = true): ExtensionHarness {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const headerFactories: HeaderFactory[] = [];
	const tui = {
		addInputListener: () => () => {},
		requestRender: () => {},
	};
	const ctx: Record<string, unknown> = {
		mode,
		hasUI,
		isIdle: () => false,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: {},
			setWidget: (_key: string, factory: (tui: unknown) => unknown) => {
				factory(tui);
			},
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			editor: async () => undefined,
			custom: async () => undefined,
			notify: () => {},
			...(withHeader
				? { setHeader: (factory: HeaderFactory) => headerFactories.push(factory) }
				: {}),
		},
	};

	piUiExtension({
		on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => {
			handlers.set(name, fn);
		},
		registerShortcut: () => {},
		registerCommand: () => {},
		events: { on: () => {}, emit: () => {} },
	} as never);

	return { handlers, headerFactories, ctx };
}

afterEach(() => {
	delete process.env.PI_UI_STARTUP_HEADER;
});

describe("startup mottos", () => {
	test("has at least 100 unique, compact mottos", () => {
		expect(STARTUP_MOTTOS.length).toBeGreaterThanOrEqual(100);
		expect(new Set(STARTUP_MOTTOS).size).toBe(STARTUP_MOTTOS.length);
		expect(STARTUP_MOTTOS.every((motto) => motto.length > 0 && motto.length <= 48 && !motto.includes("\n"))).toBe(true);
	});

	test("can select the first and last motto", () => {
		const random = spyOn(Math, "random").mockReturnValue(0);
		try {
			expect(pickStartupMotto()).toBe(STARTUP_MOTTOS[0]);
			random.mockReturnValue(0.999999);
			expect(pickStartupMotto()).toBe(STARTUP_MOTTOS[STARTUP_MOTTOS.length - 1]);
		} finally {
			random.mockRestore();
		}
	});

	test("picks on session start and keeps the motto stable on redraw", async () => {
		const random = spyOn(Math, "random").mockReturnValue(0);
		try {
			const harness = createHarness("tui");
			await harness.handlers.get("session_start")?.({}, harness.ctx);
			random.mockReturnValue(0.999999);
			const factory = harness.headerFactories[0];
			const theme = { getColorMode: () => "truecolor" };
			const component = factory?.({}, theme);
			expect(stripAnsi(component?.render(80)[1] ?? "")).toContain(STARTUP_MOTTOS[0]);
			component?.invalidate();
			expect(stripAnsi(component?.render(80)[1] ?? "")).toContain(STARTUP_MOTTOS[0]);
			expect(stripAnsi(factory?.({}, theme).render(80)[1] ?? "")).toContain(STARTUP_MOTTOS[0]);
			await harness.handlers.get("session_start")?.({}, harness.ctx);
			expect(stripAnsi(harness.headerFactories[1]?.({}, theme).render(80)[1] ?? "")).toContain(STARTUP_MOTTOS[STARTUP_MOTTOS.length - 1]);
		} finally {
			random.mockRestore();
		}
	});
});

describe("startup header installation", () => {
	test("replaces the stock header in the TUI with the compact mark line", async () => {
		const harness = createHarness("tui");
		await harness.handlers.get("session_start")?.({}, harness.ctx);

		expect(harness.headerFactories).toHaveLength(1);
		const component = harness.headerFactories[0]?.({}, { getColorMode: () => "truecolor" });
		if (!component) throw new Error("header factory returned no component");

		expect(typeof component.invalidate).toBe("function");
		const lines = component.render(80);
		expect(lines).toHaveLength(2);
		expect(stripAnsi(lines[0] ?? "").trim()).toBe("");
		const header = stripAnsi(lines[1] ?? "").trim();
		expect(header).toStartWith("/ᴘx▌  ");
		expect(STARTUP_MOTTOS).toContain(header.slice("/ᴘx▌  ".length));
		expect(visibleWidth(lines[1] ?? "")).toBe(80);
		expect(lines[1]).toContain(`${CYAN_TRUE}/`);
		expect(lines[1]).toContain(`${PINK_TRUE}ᴘ`);
		expect(lines[1]).toContain(`${PURPLE_TRUE}x`);
	});

	test("stays compact at narrow widths", async () => {
		const harness = createHarness("tui");
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const component = harness.headerFactories[0]?.({}, { getColorMode: () => "truecolor" });
		const lines = component?.render(20) ?? [];
		expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
	});

	test("does not touch the header outside the TUI", async () => {
		for (const mode of ["print", "json", "rpc"]) {
			const harness = createHarness(mode);
			await harness.handlers.get("session_start")?.({}, harness.ctx);
			expect(harness.headerFactories).toHaveLength(0);
		}
	});

	test("can be disabled with PI_UI_STARTUP_HEADER=false", async () => {
		process.env.PI_UI_STARTUP_HEADER = "false";
		const harness = createHarness("tui");
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		expect(harness.headerFactories).toHaveLength(0);
	});

	test("is skipped when the UI has no setHeader", async () => {
		const harness = createHarness("tui", true, false);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		expect(harness.headerFactories).toHaveLength(0);
	});

	test("is skipped when the TUI reports no UI", async () => {
		const harness = createHarness("tui", false);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		expect(harness.headerFactories).toHaveLength(0);
	});
});
