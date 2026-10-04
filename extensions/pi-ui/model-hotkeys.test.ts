import { describe, expect, test } from "bun:test";
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
	test("cycles all available main models and preserves a supported thinking level", async () => {
		const state = setup("beta", "high");
		await cycleMainModel(state.pi, state.ctx, -1);
		expect(state.active.id).toBe("alpha");
		expect(state.thinking).toBe("high");
		await cycleMainModel(state.pi, state.ctx, 1);
		expect(state.active.id).toBe("beta");
		expect(state.thinking).toBe("off");
	});

	test("cycles thinking levels supported by the active main model with wrapping", () => {
		const state = setup("alpha", "xhigh");
		cycleMainThinkingLevel(state.pi, state.ctx, 1);
		expect(state.thinking).toBe("off");
		cycleMainThinkingLevel(state.pi, state.ctx, -1);
		expect(state.thinking).toBe("xhigh");
	});

	test("cycles reviewer models without changing the main model or enabling rewiring", () => {
		const state = setup("gamma", "low", { model: "provider/alpha", thinkingLevel: "high", enabled: false });
		cycleReviewerModel(state.pi, state.ctx, 1);
		expect(state.reviewer).toEqual({ model: "provider/beta", thinkingLevel: "off", enabled: false });
		expect(state.active.id).toBe("gamma");
		cycleReviewerModel(state.pi, state.ctx, -1);
		expect(state.reviewer.model).toBe("provider/alpha");
		expect(state.reviewer.thinkingLevel).toBe("off");
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
