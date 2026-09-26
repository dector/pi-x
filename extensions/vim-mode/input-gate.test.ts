import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiInputListener, TuiInputListenerResult } from "@earendil-works/pi-tui";
import vimModeExtension, { isPromptEditorFocused } from "./index";

/** Minimal stand-in for pi's prompt editor. */
const editor = { getText: () => "", setText: () => {} };
/** ModelSelectorComponent and friends are Containers with no getText/setText. */
const selector = { getSearchInput: () => ({}) };

/** Kitty CSI-u: Esc press, Esc release, Ctrl+L press. */
const ESC_PRESS = "\x1b[27u";
const ESC_RELEASE = "\x1b[27;1:3u";
const CTRL_L = "\x1b[108;5u";

const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

describe("isPromptEditorFocused", () => {
	test("true while the prompt editor is focused", () => {
		expect(isPromptEditorFocused({ getFocusedComponent: () => editor })).toBe(true);
	});

	test("false while a built-in selector (e.g. model picker) is focused", () => {
		expect(isPromptEditorFocused({ getFocusedComponent: () => selector })).toBe(false);
	});

	test("false when nothing is focused", () => {
		expect(isPromptEditorFocused({ getFocusedComponent: () => null })).toBe(false);
		expect(isPromptEditorFocused({ getFocusedComponent: () => undefined })).toBe(false);
	});

	test("assumes editor when the accessor is unavailable (older pi-tui)", () => {
		expect(isPromptEditorFocused({})).toBe(true);
		expect(isPromptEditorFocused(undefined)).toBe(true);
	});

	test("false for non-object focus targets", () => {
		expect(isPromptEditorFocused({ getFocusedComponent: () => "editor" })).toBe(false);
	});
});

interface ModeEvent {
	name: string;
	payload: { mode?: string };
}

/**
 * Drive the real extension through a fake TUI so the gate's reaction to real
 * Kitty key sequences can be asserted end-to-end.
 */
function harness() {
	let focused: unknown = editor;
	const modeEvents: ModeEvent[] = [];
	let listener: TuiInputListener | undefined;

	const tui = {
		[VIEWPORT_TUI]: true,
		terminal: { columns: 80 },
		addInputListener(next: TuiInputListener): () => void {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		requestRender(): void {},
		hasOverlay(): boolean {
			return false;
		},
		getFocusedComponent(): unknown {
			return focused;
		},
	};

	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void {
			handlers.set(event, handler);
		},
		events: {
			emit(name: string, payload: { mode?: string }): void {
				if (name === "px:status-bar:input-mode:set") modeEvents.push({ name, payload });
			},
			on(): void {},
		},
		registerCommand(): void {},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setWidget(_key: string, factory: (captured: unknown) => unknown): void {
				factory(tui);
			},
			notify(): void {},
		},
	} as unknown as ExtensionContext;

	vimModeExtension(pi);

	return {
		modeEvents,
		async start(): Promise<void> {
			await handlers.get("session_start")?.({}, ctx);
		},
		setFocused(component: unknown): void {
			focused = component;
		},
		send(data: string): TuiInputListenerResult {
			if (!listener) throw new Error("vim gate was not installed");
			return listener(data);
		},
		lastMode(): string | undefined {
			return modeEvents.at(-1)?.payload.mode;
		},
	};
}

describe("vim-mode gate with Kitty key events", () => {
	test("opening and closing the model picker with Esc keeps insert mode", async () => {
		const h = harness();
		await h.start();

		// Insert mode: Ctrl+L (modifier chord) passes through to pi.
		h.setFocused(editor);
		expect(h.send(CTRL_L)).toBeUndefined();

		// Selector is now focused: its Esc press must pass through, not switch mode.
		h.setFocused(selector);
		expect(h.send(ESC_PRESS)).toBeUndefined();
		expect(h.lastMode()).not.toBe("normal");

		// Selector closed, editor focused again. The Esc *release* that follows
		// must not be treated as a fresh Esc (that was the regression).
		h.setFocused(editor);
		expect(h.send(ESC_RELEASE)).toBeUndefined();
		expect(h.lastMode()).not.toBe("normal");
	});

	test("Esc press in the editor still enters normal mode", async () => {
		const h = harness();
		await h.start();

		h.setFocused(editor);
		expect(h.send(ESC_PRESS)).toEqual({ consume: true });
		expect(h.lastMode()).toBe("normal");
	});
});
