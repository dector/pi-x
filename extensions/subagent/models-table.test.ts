import { describe, expect, test } from "bun:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_MODEL_MAPPING,
	type AliasResolver,
} from "./model-mapping.ts";
import {
	agentModelSourceLabel,
	buildModelsTableRows,
	formatModelsTableText,
	mainAgentModelRow,
	modelsModeLabel,
	modelsTableColumnWidths,
	ModelsTableView,
	MODELS_TABLE_HELP,
	MODELS_TABLE_TITLE,
	type AgentModelAgent,
	type AgentModelRow,
	type ModelsTableNavigationKey,
	type ModelsTableResult,
} from "./models-table.ts";
import type { DispatchDefaults, SubagentRewireConfig } from "./types.ts";

const permissive: AliasResolver = (targets) =>
	targets[0]
		? {
				model: targets[0],
				supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
			}
		: undefined;

const unavailable: AliasResolver = () => undefined;

const AGENTS: AgentModelAgent[] = [
	{ name: "scout-fast", function: "scout", level: "xs" },
	{ name: "planner-strong", function: "plan", level: "xl" },
	{ name: "worker-fast", function: "work", level: "m" },
];

const PARENT: DispatchDefaults = { model: "parent/current", thinkingLevel: "max" };

function build(overrides: Partial<Parameters<typeof buildModelsTableRows>[0]> = {}) {
	return buildModelsTableRows({
		agents: AGENTS,
		mapping: DEFAULT_MODEL_MAPPING,
		parentDefaults: PARENT,
		resolveAlias: permissive,
		...overrides,
	});
}

function byAgent(rows: AgentModelRow[], agent: string): AgentModelRow {
	const row = rows.find((candidate) => candidate.agent === agent);
	if (!row) throw new Error(`missing row for ${agent}`);
	return row;
}

describe("buildModelsTableRows", () => {
	test("puts the current main-agent model first", () => {
		const rows = build();
		expect(rows[0]).toMatchObject({ agent: "main", source: "main", model: "parent/current", thinkingLevel: "max" });
		expect(rows).toHaveLength(AGENTS.length + 1);
	});

	test("mainAgentModelRow omits unknown model/effort", () => {
		expect(mainAgentModelRow({})).toMatchObject({ agent: "main", source: "main" });
		expect(mainAgentModelRow({}).model).toBeUndefined();
	});

	test("resolves each agent through the function/level mapping", () => {
		const rows = build();
		expect(byAgent(rows, "scout-fast")).toMatchObject({
			source: "mapping",
			alias: "mimo-v2.6-flash",
			model: "opencode-go/mimo-v2.6-flash",
			thinkingLevel: "low",
			fn: "scout",
			level: "xs",
		});
		expect(byAgent(rows, "planner-strong")).toMatchObject({
			source: "mapping",
			model: "openai-codex/gpt-6-sol",
			thinkingLevel: "high",
			level: "xl",
		});
		expect(byAgent(rows, "worker-fast")).toMatchObject({
			source: "mapping",
			model: "opencode-go/deepseek-v4.1-flash",
			thinkingLevel: "high",
		});
	});

	test("warns and falls back to general when an agent has no function", () => {
		const rows = build({ agents: [{ name: "legacy", model: "legacy/model", thinking: "low" }] });
		const row = byAgent(rows, "legacy");
		expect(row).toMatchObject({ source: "mapping", fn: "general", model: "opencode-go/deepseek-v4.1-flash" });
		expect(row.warnings.join(" ")).toContain("no `function`");
	});

	test("a fixed rewire overrides the mapping for every agent", () => {
		const rewire: SubagentRewireConfig = { enabled: true, model: "openai-codex/gpt-6-sol", thinkingLevel: "xhigh" };
		const rows = build({ rewire });
		for (const agent of AGENTS) {
			expect(byAgent(rows, agent.name)).toMatchObject({
				source: "rewire",
				model: "openai-codex/gpt-6-sol",
				thinkingLevel: "xhigh",
			});
		}
		// The main row still reflects the live parent, not the rewire target.
		expect(rows[0]).toMatchObject({ source: "main", model: "parent/current" });
	});

	test("inherit model follows the parent model and keeps the configured effort", () => {
		const rewire: SubagentRewireConfig = {
			enabled: true,
			model: "inherit",
			thinkingLevel: "low",
			inherit: true,
			inheritAll: false,
		};
		const rows = build({ rewire });
		for (const agent of AGENTS) {
			expect(byAgent(rows, agent.name)).toMatchObject({
				source: "rewire-inherit-model",
				model: "parent/current",
				thinkingLevel: "low",
			});
		}
	});

	test("inherit all follows both parent model and parent effort", () => {
		const rewire: SubagentRewireConfig = { enabled: true, model: "inherit-all", thinkingLevel: "low", inheritAll: true };
		const rows = build({ rewire });
		for (const agent of AGENTS) {
			expect(byAgent(rows, agent.name)).toMatchObject({
				source: "rewire-inherit-all",
				model: "parent/current",
				thinkingLevel: "max",
			});
		}
	});

	test("clamps an inherited effort through the injected hook", () => {
		const rewire: SubagentRewireConfig = {
			enabled: true,
			model: "inherit",
			thinkingLevel: "max",
			inherit: true,
			inheritAll: false,
		};
		const clampCalls: Array<[string | undefined, ThinkingLevel | undefined]> = [];
		const rows = build({
			rewire,
			clampInheritedThinking: (model, level) => {
				clampCalls.push([model, level]);
				return "medium";
			},
		});
		expect(byAgent(rows, "scout-fast").thinkingLevel).toBe("medium");
		expect(clampCalls.length).toBe(AGENTS.length);
		expect(clampCalls[0]).toEqual(["parent/current", "max"]);
	});

	test("marks an unavailable alias as an error row instead of substituting", () => {
		const rows = build({ resolveAlias: unavailable });
		const row = byAgent(rows, "scout-fast");
		expect(row.source).toBe("mapping");
		expect(row.model).toBeUndefined();
		expect(row.error).toContain("no available model");
	});
});

describe("modelsModeLabel", () => {
	test("labels mapping and each rewire mode", () => {
		expect(modelsModeLabel(undefined, PARENT)).toBe("Function/level mapping");
		expect(modelsModeLabel({ enabled: true, model: "openai-codex/gpt-6-sol", thinkingLevel: "high" }, PARENT)).toBe(
			"Rewired · openai-codex/gpt-6-sol · high",
		);
		expect(
			modelsModeLabel(
				{ enabled: true, model: "inherit", thinkingLevel: "low", inherit: true, inheritAll: false },
				PARENT,
			),
		).toBe("Inherit model · parent/current · low");
		expect(
			modelsModeLabel({ enabled: true, model: "inherit-all", thinkingLevel: "low", inheritAll: true }, PARENT),
		).toBe("Inherit All · parent/current · max");
	});

	test("labels every source", () => {
		expect(agentModelSourceLabel("main")).toBe("main");
		expect(agentModelSourceLabel("mapping")).toBe("mapping");
		expect(agentModelSourceLabel("rewire")).toBe("rewired");
		expect(agentModelSourceLabel("rewire-inherit-model")).toBe("inherit model");
		expect(agentModelSourceLabel("rewire-inherit-all")).toBe("inherit all");
	});
});

describe("models table layout", () => {
	test("keeps the model column readable at 80 columns", () => {
		const rows = build();
		const widths = modelsTableColumnWidths(rows, 80);
		// Agent, Model, Effort are the always-on core.
		expect(widths[0]).toBeGreaterThan(0);
		expect(widths[3]).toBeGreaterThanOrEqual(20);
		expect(widths[4]).toBeGreaterThan(0);
		// Level is the lowest-priority column and is dropped first.
		expect(widths[2]).toBe(0);
	});

	test("shows the mapping detail columns when the width allows", () => {
		const widths = modelsTableColumnWidths(build(), 200);
		for (const width of widths) expect(width).toBeGreaterThan(0);
	});

	test("plain text fallback includes the mode, headers, and rows", () => {
		const text = formatModelsTableText(build(), "Function/level mapping");
		expect(text).toContain("Mode: Function/level mapping");
		expect(text).toContain("Agent");
		expect(text).toContain("Model");
		expect(text).toContain("scout-fast");
		expect(text).toContain("opencode-go/mimo-v2.6-flash");
	});
});

const ESC = "\x1b";
const ENTER = "\r";
const colors: string[] = [];
const theme = {
	fg: (color: string, text: string) => {
		colors.push(color);
		return text;
	},
	bold: (text: string) => text,
};
const navigationKeys: Record<ModelsTableNavigationKey, string[]> = {
	"tui.select.up": ["\x1b[A"],
	"tui.select.down": ["\x1b[B"],
	"tui.select.confirm": [ENTER],
	"tui.select.cancel": [ESC],
};
const keybindings = {
	matches: (data: string, binding: ModelsTableNavigationKey) => navigationKeys[binding].includes(data),
};

function makeView(overrides: Partial<ConstructorParameters<typeof ModelsTableView>[0]> = {}) {
	const results: ModelsTableResult[] = [];
	let renders = 0;
	const view = new ModelsTableView({
		rows: build(),
		mode: "Function/level mapping",
		theme,
		keybindings,
		requestRender: () => {
			renders += 1;
		},
		done: (result) => results.push(result),
		...overrides,
	});
	return {
		view,
		results,
		get renders() {
			return renders;
		},
	};
}

describe("ModelsTableView", () => {
	test("renders the title, mode, headers, and rows read-only", () => {
		const { view } = makeView();
		const rendered = view.render(100).join("\n");
		expect(rendered).toContain(MODELS_TABLE_TITLE);
		expect(rendered).toContain("Function/level mapping");
		expect(rendered).toContain("Agent");
		expect(rendered).toContain("Model");
		expect(rendered).toContain("scout-fast");
		expect(rendered).toContain(MODELS_TABLE_HELP);
	});

	test("scrolls by one row with j/k and five rows with shift+j/k", () => {
		const rows = build({
			agents: Array.from({ length: 6 }, (_value, index) => ({
				name: `agent-${index}`,
				function: "work" as const,
			})),
		});
		const { view } = makeView({ rows, maxVisible: 1 });
		expect(view.render(100).join("\n")).toContain("1-1 of 7");
		view.handleInput("j");
		expect(view.render(100).join("\n")).toContain("2-2 of 7");
		view.handleInput("J"); // shift+j scrolls forward five rows
		expect(view.render(100).join("\n")).toContain("7-7 of 7");
		view.handleInput("K"); // shift+k scrolls back five rows
		expect(view.render(100).join("\n")).toContain("2-2 of 7");
		view.handleInput("k");
		expect(view.render(100).join("\n")).toContain("1-1 of 7");
	});

	test("closes on escape, enter, and q", () => {
		const escape = makeView();
		escape.view.handleInput(ESC);
		expect(escape.results).toEqual([{ type: "close" }]);
		const enter = makeView();
		enter.view.handleInput(ENTER);
		expect(enter.results).toEqual([{ type: "close" }]);
		const quit = makeView();
		quit.view.handleInput("q");
		expect(quit.results).toEqual([{ type: "close" }]);
	});
});
