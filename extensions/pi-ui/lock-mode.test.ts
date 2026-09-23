import { describe, expect, test } from "bun:test";
import piUiExtension from "./index";

describe("lock input gate", () => {
	test("blocks all keys including Esc and Ctrl+C, except Quick Actions; restores on unlock and shutdown", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		const shortcuts = new Map<string, (ctx: unknown) => Promise<void>>();
		const emitted: unknown[] = [];
		let inputListener: ((data: string) => { consume: boolean } | undefined) | undefined;
		let dialog: { handleInput(data: string): void } | undefined;
		let done: (() => void) | undefined;
		let removed = false;
		const tui = {
			addInputListener: (listener: typeof inputListener) => { inputListener = listener; return () => { removed = true; inputListener = undefined; }; },
			requestRender: () => {},
		};
		const ctx = {
			hasUI: true,
			isIdle: () => false,
			sessionManager: { getBranch: () => [] },
			ui: {
				theme: {},
				setWidget: (_key: string, factory: (tui: unknown) => unknown) => { factory(tui); },
				custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => typeof dialog) => new Promise<void>((resolve) => {
					done = resolve;
					dialog = factory(tui, {}, {}, resolve);
				}),
				select: async () => {}, confirm: async () => {}, input: async () => {}, editor: async () => {},
				notify: () => {},
			},
		};
		piUiExtension({
			on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => { handlers.set(name, fn); },
			registerShortcut: (key: string, option: { handler: (ctx: unknown) => Promise<void> }) => { shortcuts.set(key, option.handler); },
			registerCommand: () => {},
			events: { on: () => {}, emit: (...args: unknown[]) => { emitted.push(args); } },
		} as never);
		await handlers.get("session_start")?.({}, ctx);
		expect(inputListener?.("\x1b")).toBeUndefined();
		const opening = shortcuts.get("ctrl+,") ?? [...shortcuts.values()].at(-1)!;
		const opened = opening(ctx);
		dialog?.handleInput("L");
		await opened;
		expect(emitted).toContainEqual(["px:pi-ui:lock-state", { locked: true }]);
		for (const key of ["a", "\r", "\x1b", "\x03", "\x1b[A", "\x1b[<0;1;1M"]) {
			expect(inputListener?.(key)).toEqual({ consume: true });
		}
		expect(inputListener?.("\x1b[44;5u")).toBeUndefined(); // Ctrl+, is the only way back.
		const reopened = opening(ctx);
		expect(inputListener?.("\x1b[<0;1;1M")).toEqual({ consume: true });
		expect(inputListener?.("\x1b[100;6u")).toEqual({ consume: true }); // Ctrl+Shift+D
		dialog?.handleInput("r");
		expect(emitted).not.toContainEqual(["px:safe-mode:toggle-reader", { ctx }]);
		dialog?.handleInput("L");
		await reopened;
		expect(inputListener?.("\x1b")).toBeUndefined();
		await handlers.get("session_shutdown")?.({}, ctx);
		expect(removed).toBe(true);
		expect(inputListener).toBeUndefined();
		done?.();
	});
});
