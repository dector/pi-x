import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelPresetsPath, saveModelPresets } from "./model-presets.ts";
import { cycleMainModel, cycleMainThinkingLevel, cycleReviewerModel, cycleReviewerThinkingLevel } from "./model-hotkeys.ts";

const models = [
	{ provider: "provider", id: "alpha", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
	{ provider: "provider", id: "beta", reasoning: false },
	{ provider: "provider", id: "gamma", reasoning: true },
];

type Preset = { model: string; thinkingLevel: string; enabled?: boolean };

function setup(activeId = "beta", thinkingLevel = "medium", reviewer: Preset = { model: "provider/alpha", thinkingLevel: "medium", enabled: false }) {
	let active = models.find((model) => model.id === activeId)!;
	let thinking = thinkingLevel;
	let reviewerTarget = { ...reviewer };
	const notices: string[] = [];
	const pi = {
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: string) => { thinking = level; },
		setModel: async (model: (typeof models)[number]) => { active = model; return true; },
		events: {
			emit: (name: string, payload: any) => {
				if (name === "px:subagent:rewire:state:request") payload.reply(reviewerTarget);
				if (name === "px:subagent:rewire:target") {
					reviewerTarget = { ...reviewerTarget, model: payload.model, thinkingLevel: payload.thinkingLevel };
					payload.onApplied(reviewerTarget.enabled);
				}
			},
		},
	} as any;
	const ctx = {
		get model() { return active; },
		modelRegistry: { getAvailable: () => models },
		ui: { notify: (message: string) => { notices.push(message); } },
	} as any;
	return {
		pi,
		ctx,
		notices,
		get active() { return active; },
		get thinking() { return thinking; },
		get reviewer() { return reviewerTarget; },
	};
}

describe("model hotkeys", () => {
	let dir: string;
	let previousAgentDir: string | undefined;
	beforeEach(() => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-hotkeys-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		saveModelPresets([
			{ model: "provider/alpha", thinkingLevel: "low" },
			{ model: "provider/alpha", thinkingLevel: "medium" },
			{ model: "provider/missing", thinkingLevel: "high" },
			{ model: "provider/beta", thinkingLevel: "off" },
		]);
	});
	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("cycles complete main presets including different efforts for the same model", async () => {
		const state = setup("beta", "off");
		await cycleMainModel(state.pi, state.ctx, 1);
		expect([state.active.id, state.thinking]).toEqual(["alpha", "low"]);
		await cycleMainModel(state.pi, state.ctx, 1);
		expect([state.active.id, state.thinking]).toEqual(["alpha", "medium"]);
		await cycleMainModel(state.pi, state.ctx, 1);
		expect([state.active.id, state.thinking]).toEqual(["beta", "off"]);
		await cycleMainModel(state.pi, state.ctx, -1);
		expect([state.active.id, state.thinking]).toEqual(["alpha", "medium"]);
	});

	test("cycles thinking levels supported by the active main model with wrapping", () => {
		const state = setup("alpha", "xhigh");
		cycleMainThinkingLevel(state.pi, state.ctx, 1);
		expect(state.thinking).toBe("off");
		cycleMainThinkingLevel(state.pi, state.ctx, -1);
		expect(state.thinking).toBe("xhigh");
	});

	test("cycles complete reviewer presets without changing the main model or enabling rewiring", () => {
		const state = setup("gamma", "high", { model: "provider/beta", thinkingLevel: "off", enabled: false });
		cycleReviewerModel(state.pi, state.ctx, 1);
		expect(state.reviewer).toEqual({ model: "provider/alpha", thinkingLevel: "low", enabled: false });
		cycleReviewerModel(state.pi, state.ctx, 1);
		expect(state.reviewer.thinkingLevel).toBe("medium");
		cycleReviewerModel(state.pi, state.ctx, 1);
		expect(state.reviewer).toEqual({ model: "provider/beta", thinkingLevel: "off", enabled: false });
		cycleReviewerModel(state.pi, state.ctx, -1);
		expect(state.reviewer).toEqual({ model: "provider/alpha", thinkingLevel: "medium", enabled: false });
		expect(state.active.id).toBe("gamma");
		expect(state.thinking).toBe("high");
	});

	test("favorite order controls cycling and a non-favorite starts at either end", async () => {
		saveModelPresets([
			{ model: "provider/beta", thinkingLevel: "off" },
			{ model: "provider/alpha", thinkingLevel: "low" },
		]);
		const state = setup("gamma", "high", { model: "provider/gamma", thinkingLevel: "high" });
		await cycleMainModel(state.pi, state.ctx, 1);
		expect(state.active.id).toBe("beta");
		cycleReviewerModel(state.pi, state.ctx, -1);
		expect(state.reviewer.model).toBe("provider/alpha");
	});

	test("empty, unavailable, and malformed favorites do not fall back to all models", async () => {
		const state = setup("gamma", "high");
		for (const presets of [[], [{ model: "provider/missing", thinkingLevel: "high" as const }]]) {
			saveModelPresets(presets);
			await cycleMainModel(state.pi, state.ctx, 1);
			cycleReviewerModel(state.pi, state.ctx, 1);
		}
		fs.writeFileSync(modelPresetsPath(), "invalid json");
		await cycleMainModel(state.pi, state.ctx, 1);
		cycleReviewerModel(state.pi, state.ctx, 1);
		expect(state.active.id).toBe("gamma");
		expect(state.reviewer.model).toBe("provider/alpha");
		expect(state.notices).toHaveLength(6);
	});

	test("cycles reviewer thinking levels independently of main-model thinking", () => {
		const state = setup("beta", "low", { model: "provider/alpha", thinkingLevel: "medium", enabled: false });
		cycleReviewerThinkingLevel(state.pi, state.ctx, 1);
		expect(state.reviewer.thinkingLevel).toBe("high");
		cycleReviewerThinkingLevel(state.pi, state.ctx, -1);
		expect(state.reviewer.thinkingLevel).toBe("medium");
		expect(state.thinking).toBe("low");
	});
});
