import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadModelPresets, saveModelPresets, showModelPresetList, selectPresetOption, moveModelPreset, openModelPresets, cycleModelPresets, cycleRewireModelPresets } from "./model-presets.ts";

const presets = [
	{ model: "provider/luna", thinkingLevel: "high" as const },
	{ model: "provider/sol", thinkingLevel: "medium" as const },
];
const picker = (actions?: Parameters<typeof showModelPresetList>[3]) => {
	let view!: { handleInput: (data: string) => void; render: (width: number) => string[] };
	const result = showModelPresetList({ ui: { custom: (factory: Function) => new Promise((done) => {
		view = factory({ requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, { matches: (data: string, binding: string) => ({ "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B", "tui.select.confirm": "\r", "tui.select.cancel": "\x1b" } as Record<string, string>)[binding] === data }, done);
	}) } } as any, presets, 0, actions);
	return { get view() { return view; }, result };
};

const withTempAgentDir = async (run: () => Promise<void>) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-picker-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try { await run(); }
	finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
};

describe("model presets", () => {
	test("Ctrl+9 cycles favorite model and thinking level, skipping unavailable entries and wrapping", async () => {
		await withTempAgentDir(async () => {
			saveModelPresets([presets[0]!, { model: "provider/unavailable", thinkingLevel: "high" }, presets[1]!]);
			let model = { provider: "provider", id: "other", reasoning: true };
			let thinking = "low";
			const notices: string[] = [];
			const ctx = {
				get model() { return model; },
				modelRegistry: { getAvailable: () => [{ provider: "provider", id: "luna", reasoning: true }, { provider: "provider", id: "sol", reasoning: true }] },
				ui: { notify: (message: string) => { notices.push(message); } },
			} as any;
			const pi = {
				getThinkingLevel: () => thinking,
				setThinkingLevel: (level: string) => { thinking = level; },
				setModel: async (next: typeof model) => { model = next; return true; },
			} as any;
			await cycleModelPresets(pi, ctx);
			expect([model.id, thinking]).toEqual(["luna", "high"]);
			await cycleModelPresets(pi, ctx);
			expect([model.id, thinking]).toEqual(["sol", "medium"]);
			await cycleModelPresets(pi, ctx);
			expect([model.id, thinking]).toEqual(["luna", "high"]);
			expect(notices).toHaveLength(3);
		});
	});

	test("Ctrl+8 cycles main favorites backwards, skipping unavailable entries and wrapping", async () => {
		await withTempAgentDir(async () => {
			saveModelPresets([presets[0]!, { model: "provider/unavailable", thinkingLevel: "high" }, presets[1]!]);
			let model = { provider: "provider", id: "other", reasoning: true };
			let thinking = "low";
			const ctx = {
				get model() { return model; },
				modelRegistry: { getAvailable: () => [{ provider: "provider", id: "luna", reasoning: true }, { provider: "provider", id: "sol", reasoning: true }] },
				ui: { notify() {} },
			} as any;
			const pi = {
				getThinkingLevel: () => thinking,
				setThinkingLevel: (level: string) => { thinking = level; },
				setModel: async (next: typeof model) => { model = next; return true; },
			} as any;
			await cycleModelPresets(pi, ctx, -1);
			expect([model.id, thinking]).toEqual(["sol", "medium"]);
			await cycleModelPresets(pi, ctx, -1);
			expect([model.id, thinking]).toEqual(["luna", "high"]);
			await cycleModelPresets(pi, ctx, -1);
			expect([model.id, thinking]).toEqual(["sol", "medium"]);
		});
	});

	test("cycling reports empty and unavailable favorites without changing models", async () => {
		await withTempAgentDir(async () => {
			const notices: string[] = [];
			const ctx = { model: undefined, modelRegistry: { getAvailable: () => [] }, ui: { notify: (message: string) => { notices.push(message); } } } as any;
			const pi = { getThinkingLevel: () => "off", setModel: async () => { throw new Error("should not switch"); } } as any;
			await cycleModelPresets(pi, ctx);
			saveModelPresets(presets);
			await cycleModelPresets(pi, ctx);
			expect(notices).toEqual(["No favorite models. Add one with Ctrl+, then m.", "No favorite models are available."]);
		});
	});
	test("Ctrl+7 cycles rewire targets without changing main model or enabling rewiring", async () => {
		await withTempAgentDir(async () => {
			saveModelPresets([presets[0]!, { model: "provider/unavailable", thinkingLevel: "high" }, presets[1]!]);
			let target: (typeof presets)[number] | undefined;
			const applied: string[] = [];
			const notices: string[] = [];
			const ctx = {
				model: { provider: "provider", id: "other" },
				modelRegistry: { getAvailable: () => [{ provider: "provider", id: "luna", reasoning: true }, { provider: "provider", id: "sol", reasoning: true }] },
				ui: { notify: (message: string) => { notices.push(message); } },
			} as any;
			const pi = {
				getThinkingLevel: () => "low",
				setModel: () => { throw new Error("must not switch main model"); },
				events: { emit: (name: string, payload: any) => {
					if (name.endsWith(":state:request")) payload.reply(target);
					if (name.endsWith(":target")) { target = { model: payload.model, thinkingLevel: payload.thinkingLevel }; applied.push(payload.model); payload.onApplied(false); }
				} },
			} as any;
			cycleRewireModelPresets(pi, ctx);
			cycleRewireModelPresets(pi, ctx);
			cycleRewireModelPresets(pi, ctx);
			expect(applied).toEqual(["provider/luna", "provider/sol", "provider/luna"]);
			expect(target).toEqual(presets[0]);
			expect(notices).toEqual([]);
			expect(ctx.model.id).toBe("other");
		});
	});

	test("Ctrl+6 cycles rewire targets backwards, skipping unavailable favorites", async () => {
		await withTempAgentDir(async () => {
			saveModelPresets([presets[0]!, { model: "provider/unavailable", thinkingLevel: "high" }, presets[1]!]);
			let target: (typeof presets)[number] | undefined;
			const ctx = {
				modelRegistry: { getAvailable: () => [{ provider: "provider", id: "luna", reasoning: true }, { provider: "provider", id: "sol", reasoning: true }] },
				ui: { notify() {} },
			} as any;
			const pi = { events: { emit: (name: string, payload: any) => {
				if (name.endsWith(":state:request")) payload.reply(target);
				if (name.endsWith(":target")) { target = { model: payload.model, thinkingLevel: payload.thinkingLevel }; payload.onApplied(false); }
			} } } as any;
			cycleRewireModelPresets(pi, ctx, -1);
			expect(target).toEqual(presets[1]);
			cycleRewireModelPresets(pi, ctx, -1);
			expect(target).toEqual(presets[0]);
			cycleRewireModelPresets(pi, ctx, -1);
			expect(target).toEqual(presets[1]);
		});
	});

	test("rewire cycling warns when the subagent listener is missing", async () => {
		await withTempAgentDir(async () => {
			saveModelPresets(presets);
			const notices: string[] = [];
			const ctx = { modelRegistry: { getAvailable: () => [{ provider: "provider", id: "luna", reasoning: true }] }, ui: { notify: (message: string) => { notices.push(message); } } } as any;
			cycleRewireModelPresets({ events: { emit() {} } } as any, ctx);
			expect(notices).toEqual(["Could not set rewire target. Is the subagent extension loaded?"]);
		});
	});

	test("round trips and rejects invalid files", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-presets-"));
		const file = path.join(dir, "nested", "presets.json");
		try {
			expect(loadModelPresets(file)).toEqual([]);
			saveModelPresets(presets, file);
			expect(loadModelPresets(file)).toEqual(presets);
			fs.writeFileSync(file, '{"presets":[42]}');
			expect(() => loadModelPresets(file)).toThrow();
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});

	test("Enter and Alt+Enter act without dismissing the picker", async () => {
		let main = presets[0];
		let rewire = presets[1];
		const ui = picker({ getMain: () => main, getRewire: () => rewire, onUse: async (preset) => { main = preset; }, onRewire: (preset) => { rewire = preset; } });
		const initial = ui.view.render(80).join("\n");
		expect(initial).toContain("󰙴  provider/luna · high");
		expect(initial).toContain(" ⇢provider/sol · medium");
		ui.view.handleInput("j");
		ui.view.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(main).toEqual(presets[1]);
		ui.view.handleInput("\x1b\r");
		expect(rewire).toEqual(presets[1]);
		expect(ui.view.render(80).join("\n")).toContain("󰙴⇢provider/sol · medium");
		ui.view.handleInput("\x1b");
		expect(await ui.result).toEqual({ type: "cancel" });
	});

	test("/ searches model and effort; no match cannot be selected", async () => {
		let applied: string | undefined;
		const ui = picker({ getMain: () => undefined, getRewire: () => undefined, onUse: async (preset) => { applied = preset.model; }, onRewire: () => {} });
		ui.view.handleInput("/");
		for (const char of "SOL med") ui.view.handleInput(char);
		expect(ui.view.render(80).join("\n")).toContain("provider/sol · medium");
		expect(ui.view.render(80).join("\n")).not.toContain("provider/luna · high");
		ui.view.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(applied).toBe("provider/sol");
		for (const char of "xyz") ui.view.handleInput(char);
		expect(ui.view.render(80).join("\n")).toContain("No matching presets");
		ui.view.handleInput("\r");
		expect(applied).toBe("provider/sol");
		ui.view.handleInput("\x1b");
		ui.view.handleInput("\x1b");
		expect(await ui.result).toEqual({ type: "cancel" });
	});

	test("main and rewire configurations missing from saved list become muted, temporary rows", async () => {
		const main = { model: "provider/other", thinkingLevel: "low" as const };
		const rewire = { model: "provider/agent", thinkingLevel: "high" as const };
		const applied: string[] = [];
		const ui = picker({ getMain: () => main, getRewire: () => rewire, onUse: async (preset) => { applied.push(preset.model); }, onRewire: (preset) => { applied.push(preset.model); } });
		const lines = ui.view.render(80).join("\n");
		expect(lines.indexOf("provider/agent")).toBeGreaterThan(lines.indexOf("provider/other"));
		expect(lines).toContain("󰙴  provider/other · low");
		expect(lines).toContain(" ⇢provider/agent · high");
		ui.view.handleInput("j");
		ui.view.handleInput("j");
		ui.view.handleInput("d");
		ui.view.handleInput("J");
		ui.view.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(applied).toEqual(["provider/other"]);
		ui.view.handleInput("\x1b");
		expect(await ui.result).toEqual({ type: "cancel" });
	});

	test("switching the main model does not replace the original muted row", async () => {
		let main = { model: "provider/other", thinkingLevel: "low" as const } as (typeof presets)[number] | { model: string; thinkingLevel: "low" };
		const ui = picker({ getMain: () => main, getRewire: () => undefined, onUse: async (preset) => { main = preset; }, onRewire: () => {} });
		expect(ui.view.render(80).join("\n")).toContain("󰙴  provider/other · low");
		ui.view.handleInput("\r"); // select saved luna instead
		await new Promise((resolve) => setTimeout(resolve, 0));
		const after = ui.view.render(80).join("\n");
		expect(after).toContain("󰙴  provider/luna · high");
		expect(after).toContain("provider/other · low");
		expect(after).not.toContain("󰙴  provider/other · low");
		ui.view.handleInput("j");
		ui.view.handleInput("j");
		ui.view.handleInput("\r"); // still selects original, not a replaced row
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(main).toEqual({ model: "provider/other", thinkingLevel: "low" });
		ui.view.handleInput("\x1b");
		expect(await ui.result).toEqual({ type: "cancel" });
	});

	test("same missing main and rewire configuration shares one temporary row", async () => {
		const target = { model: "provider/other", thinkingLevel: "low" as const };
		const ui = picker({ getMain: () => target, getRewire: () => target, onUse: async () => {}, onRewire: () => {} });
		const text = ui.view.render(80).join("\n");
		expect(text.match(/provider\/other/g)).toHaveLength(1);
		expect(text).toContain("󰙴⇢provider/other · low");
		ui.view.handleInput("\x1b");
		await ui.result;
	});

	test("/ searches both model and effort choice pickers", async () => {
		for (const [options, query, expected] of [
			[["provider/luna", "provider/sol"], "sol", "provider/sol"],
			[["off", "medium", "high"], "HIGH", "high"],
		] as const) {
			let view!: { handleInput: (data: string) => void; render: (width: number) => string[] };
			const result = selectPresetOption({ ui: { custom: (factory: Function) => new Promise((done) => {
				view = factory({ requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {
					matches: (data: string, binding: string) => binding === "tui.select.confirm" && data === "\r",
				}, done);
			}) } } as any, "Choose", [...options]);
			view.handleInput("/");
			for (const char of query) view.handleInput(char);
			expect(view.render(80).join("\n")).toContain(expected);
			view.handleInput("\r");
			expect(await result).toBe(expected);
		}
	});

	test("Shift+j/k requests reordering and boundaries do not move", async () => {
		const ui = picker();
		ui.view.handleInput("J");
		expect(await ui.result).toEqual({ type: "move", index: 0, delta: 1 });
		const items = [...presets];
		expect(moveModelPreset(items, 0, 1)).toBe(1);
		expect(items).toEqual([presets[1], presets[0]]);
		expect(moveModelPreset(items, 0, -1)).toBe(0);
		const up = picker();
		up.view.handleInput("j");
		up.view.handleInput("K");
		expect(await up.result).toEqual({ type: "move", index: 1, delta: -1 });
	});

	test("openModelPresets keeps both selections in one dialog even when rewiring is off", async () => {
		await withTempAgentDir(async () => {
			saveModelPresets(presets);
			let rewire = { ...presets[0], enabled: false };
			let main = { provider: "provider", id: "luna", reasoning: true };
			let thinking = "high";
			let calls = 0;
			const ctx = {
				mode: "tui", get model() { return main; },
				modelRegistry: { getAvailable: () => [{ provider: "provider", id: "luna", reasoning: true }, { provider: "provider", id: "sol", reasoning: true }] },
				ui: {
					custom: (factory: Function) => new Promise((done) => {
						calls++;
						const view = factory({ requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, { matches: (key: string, binding: string) => binding === "tui.select.confirm" && key === "\r" || binding === "tui.select.cancel" && key === "\x1b" }, done);
						view.handleInput("j");
						view.handleInput("\x1b\r");
						view.handleInput("\r");
						setTimeout(() => view.handleInput("\x1b"), 0);
					}),
					notify() {},
				},
			} as any;
			const pi = {
				getThinkingLevel: () => thinking,
				setThinkingLevel: (level: string) => { thinking = level; },
				setModel: async (model: typeof main) => { main = model; return true; },
				events: { emit: (name: string, payload: any) => {
					if (name.endsWith(":state:request")) payload.reply(rewire);
					if (name.endsWith(":target")) { rewire = { model: payload.model, thinkingLevel: payload.thinkingLevel, enabled: rewire.enabled }; payload.onApplied(rewire.enabled); }
				} },
			} as any;
			await openModelPresets(pi, ctx);
			expect(calls).toBe(1);
			expect(rewire).toEqual({ ...presets[1], enabled: false });
			expect(main.id).toBe("sol");
			expect(thinking).toBe("medium");
		});
	});

	test("opening with an unsaved main model selects its temporary row and can switch to a saved model", async () => {
		await withTempAgentDir(async () => {
			saveModelPresets(presets);
			let main = { provider: "provider", id: "other", reasoning: true };
			let thinking: string = "low";
			let initial = "";
			let after = "";
			let selectedModelCalls = 0;
			const ctx = {
				mode: "tui", get model() { return main; },
				modelRegistry: { getAvailable: () => [{ provider: "provider", id: "luna", reasoning: true }, { provider: "provider", id: "sol", reasoning: true }] },
				ui: { custom: (factory: Function) => new Promise((done) => {
					const view = factory({ requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, { matches: (key: string, binding: string) => binding === "tui.select.confirm" && key === "\r" || binding === "tui.select.cancel" && key === "\x1b" }, done);
					initial = view.render(80).join("\n");
					view.handleInput("j"); // wraps from the temporary main row to the first saved row
					view.handleInput("\r");
					setTimeout(() => { after = view.render(80).join("\n"); view.handleInput("\x1b"); }, 0);
				}), notify() {} },
			} as any;
			const pi = {
				getThinkingLevel: () => thinking,
				setThinkingLevel: (level: string) => { thinking = level; },
				setModel: async (model: typeof main) => { selectedModelCalls++; main = model; return true; },
				events: { emit() {} },
			} as any;
			await openModelPresets(pi, ctx);
			expect(initial).toContain("→ 󰙴  provider/other · low");
			expect(selectedModelCalls).toBe(1);
			expect(main.id).toBe("luna");
			expect(thinking).toBe("high");
			expect(after).toContain("󰙴  provider/luna · high");
			expect(after).toContain("provider/other · low");
		});
	});

	test("a delayed ctx.model update does not turn the old muted row into a phantom effort", async () => {
		await withTempAgentDir(async () => {
			saveModelPresets(presets);
			const oldModel = { provider: "provider", id: "other", reasoning: true };
			let thinking: string = "high";
			let rendered = "";
			const ctx = {
				mode: "tui", model: oldModel, // Pi may not expose the newly selected model until the dialog exits.
				modelRegistry: { getAvailable: () => [{ provider: "provider", id: "sol", reasoning: true }] },
				ui: { custom: (factory: Function) => new Promise((done) => {
					const view = factory({ requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, { matches: (key: string, binding: string) => binding === "tui.select.confirm" && key === "\r" || binding === "tui.select.cancel" && key === "\x1b" }, done);
					view.render(80); // snapshot the initial unsaved main model at high
					view.handleInput("k"); // sol medium
					view.handleInput("\r");
					setTimeout(() => { rendered = view.render(80).join("\n"); view.handleInput("\x1b"); }, 0);
				}), notify() {} },
			} as any;
			const pi = {
				getThinkingLevel: () => thinking,
				setThinkingLevel: (level: string) => { thinking = level; },
				setModel: async () => true,
				events: { emit() {} },
			} as any;
			await openModelPresets(pi, ctx);
			expect(thinking).toBe("medium");
			expect(rendered).toContain("󰙴  provider/sol · medium");
			expect(rendered).toContain("provider/other · high");
			expect(rendered).not.toContain("provider/other · medium");
		});
	});

	test("Shift+j persists order without changing model", async () => {
		await withTempAgentDir(async () => {
			saveModelPresets(presets);
			const results = [{ type: "move", index: 0, delta: 1 }, { type: "cancel" }];
			const ctx = { mode: "tui", ui: { custom: () => Promise.resolve(results.shift()), notify() {} } } as any;
			await openModelPresets({ events: { emit() {} } } as any, ctx);
			expect(loadModelPresets()).toEqual([presets[1], presets[0]]);
		});
	});

	test("n creates, d requests deletion, and narrow rendering fits", async () => {
		const ui = picker();
		expect(ui.view.render(18).every((line) => visibleWidth(line) <= 18)).toBe(true);
		ui.view.handleInput("d");
		expect(await ui.result).toEqual({ type: "delete", index: 0 });
		const next = picker();
		next.view.handleInput("n");
		expect(await next.result).toEqual({ type: "new" });
	});
});
