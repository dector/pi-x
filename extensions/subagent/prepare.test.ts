/**
 * Stage 2 preparation tests.
 *
 * These cover the single validated path that runs before any child can start:
 * mode/task-count validation, agent discovery, unknown-agent rejection,
 * project-agent approval, snapshots, and up-front ID allocation. All side
 * effects are injected so the tests never touch the Pi runtime.
 */

import { describe, expect, test } from "bun:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentConfig, AgentScope } from "./agents.ts";
import { MAX_PARALLEL_TASKS, prepareSubagentDispatch, type PreparationDependencies } from "./prepare.ts";
import type { SafeModeSnapshot } from "./safe-mode.ts";

function agent(name: string, source: "user" | "project" = "user"): AgentConfig {
	return {
		name,
		description: `${name} description`,
		systemPrompt: "",
		source,
		filePath: `/agents/${name}.md`,
	};
}

interface HarnessOptions {
	agents?: AgentConfig[];
	projectAgentsDir?: string | null;
	permission?: string | undefined;
	cwd?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	safeMode?: SafeModeSnapshot;
	runIds?: string[];
	dispatchIds?: string[];
}

function createHarness(options: HarnessOptions = {}) {
	const calls = {
		discover: [] as Array<{ cwd: string; scope: AgentScope }>,
		permission: [] as Array<{ what: string; data: Record<string, unknown> }>,
		safeMode: 0,
		nextDispatchId: 0,
		nextRunId: 0,
		/** Ordered effect log, so tests can assert allocation order. */
		order: [] as string[],
	};
	const runIds = [...(options.runIds ?? [])];
	const dispatchIds = [...(options.dispatchIds ?? [])];
	const agents = options.agents ?? [agent("scout"), agent("worker")];

	const deps: PreparationDependencies = {
		discoverAgents: (cwd, scope) => {
			calls.discover.push({ cwd, scope });
			return { agents, projectAgentsDir: options.projectAgentsDir ?? null };
		},
		requestPermission: async (what, data) => {
			calls.permission.push({ what, data });
			calls.order.push("permission");
			return options.permission;
		},
		snapshotSafeMode: async () => {
			calls.safeMode += 1;
			calls.order.push("safe-mode");
			return options.safeMode;
		},
		nextDispatchId: () => {
			calls.nextDispatchId += 1;
			calls.order.push("dispatch-id");
			return dispatchIds.shift() ?? `dispatch-${calls.nextDispatchId}`;
		},
		nextRunId: () => {
			calls.nextRunId += 1;
			calls.order.push("run-id");
			return runIds.shift() ?? `sa-${calls.nextRunId}`;
		},
		context: {
			cwd: options.cwd ?? "/work",
			model: options.model,
			thinkingLevel: options.thinkingLevel,
		},
	};

	return { deps, calls, agents };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content[0];
	return part && part.type === "text" ? part.text ?? "" : "";
}

describe("single preparation", () => {
	test("snapshots context and allocates the dispatch/run IDs", async () => {
		const { deps, calls } = createHarness({
			agents: [agent("scout"), agent("worker")],
			projectAgentsDir: "/repo/.pi/agents",
			cwd: "/work/repo",
			model: "anthropic/claude",
			thinkingLevel: "high",
			safeMode: { mode: "smart", outerAccess: false },
			runIds: ["sa-1"],
			dispatchIds: ["dispatch-1"],
		});

		const result = await prepareSubagentDispatch({ agent: "scout", task: "do it", cwd: "/work/sub" }, deps);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dispatch).toEqual({
			dispatchId: "dispatch-1",
			execution: "blocking",
			mode: "single",
			agentScope: "user",
			projectAgentsDir: "/repo/.pi/agents",
			agents: [agent("scout"), agent("worker")],
			dispatchDefaults: { model: "anthropic/claude", thinkingLevel: "high" },
			cwd: "/work/repo",
			safeModeSnapshot: { mode: "smart", outerAccess: false },
			items: [{ runId: "sa-1", agent: "scout", task: "do it", cwd: "/work/sub" }],
		});
		expect(calls.discover).toEqual([{ cwd: "/work/repo", scope: "user" }]);
		expect(calls.permission).toHaveLength(0);
		expect(calls.safeMode).toBe(1);
	});

	test("defaults to user scope and omits undefined snapshots", async () => {
		const { deps, calls } = createHarness({ runIds: ["sa-1"], dispatchIds: ["d-1"] });
		const result = await prepareSubagentDispatch({ agent: "scout", task: "t" }, deps);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dispatch.agentScope).toBe("user");
		expect(result.dispatch.dispatchDefaults).toEqual({ model: undefined, thinkingLevel: undefined });
		expect(result.dispatch.safeModeSnapshot).toBeUndefined();
		expect(calls.discover).toEqual([{ cwd: "/work", scope: "user" }]);
	});
});

describe("parallel preparation", () => {
	test("allocates one run ID per task in input order", async () => {
		const { deps } = createHarness({ runIds: ["sa-a", "sa-b", "sa-c"], dispatchIds: ["d-1"] });
		const result = await prepareSubagentDispatch(
			{
				tasks: [
					{ agent: "scout", task: "1" },
					{ agent: "worker", task: "2", cwd: "/x" },
					{ agent: "scout", task: "3" },
				],
			},
			deps,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dispatch.mode).toBe("parallel");
		expect(result.dispatch.items).toEqual([
			{ runId: "sa-a", agent: "scout", task: "1" },
			{ runId: "sa-b", agent: "worker", task: "2", cwd: "/x" },
			{ runId: "sa-c", agent: "scout", task: "3" },
		]);
	});

	test(`accepts exactly ${MAX_PARALLEL_TASKS} tasks`, async () => {
		const tasks = Array.from({ length: MAX_PARALLEL_TASKS }, (_, index) => ({
			agent: "scout",
			task: `task-${index}`,
		}));
		const { deps } = createHarness();
		const result = await prepareSubagentDispatch({ tasks }, deps);
		expect(result.ok).toBe(true);
	});

	test(`rejects more than ${MAX_PARALLEL_TASKS} tasks before any ID allocation`, async () => {
		const tasks = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, () => ({ agent: "scout", task: "t" }));
		const { deps, calls } = createHarness();

		const result = await prepareSubagentDispatch({ tasks }, deps);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(textOf(result.result)).toBe(
			`Too many parallel tasks (${MAX_PARALLEL_TASKS + 1}). Max is ${MAX_PARALLEL_TASKS}.`,
		);
		expect(result.result.details?.mode).toBe("parallel");
		expect(result.result.details?.dispatchStatus).toBe("failed");
		expect(result.result.details?.results).toEqual([]);
		expect(result.result.isError).toBeUndefined();
		expect(calls.nextRunId).toBe(0);
		expect(calls.nextDispatchId).toBe(0);
		expect(calls.safeMode).toBe(0);
	});
});

describe("chain preparation", () => {
	test("allocates every step up front and numbers them", async () => {
		const { deps, calls } = createHarness({ runIds: ["sa-1", "sa-2", "sa-3"], dispatchIds: ["d-1"] });
		const result = await prepareSubagentDispatch(
			{
				chain: [
					{ agent: "scout", task: "first" },
					{ agent: "worker", task: "use {previous}" },
					{ agent: "worker", task: "again", cwd: "/x" },
				],
			},
			deps,
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dispatch.mode).toBe("chain");
		// Chain tasks are not interpolated at preparation time; the runner does that.
		expect(result.dispatch.items).toEqual([
			{ runId: "sa-1", agent: "scout", task: "first", step: 1 },
			{ runId: "sa-2", agent: "worker", task: "use {previous}", step: 2 },
			{ runId: "sa-3", agent: "worker", task: "again", cwd: "/x", step: 3 },
		]);
		expect(calls.nextRunId).toBe(3);
	});
});

describe("validation failures", () => {
	test("rejects an empty request", async () => {
		const { deps, calls } = createHarness();
		const result = await prepareSubagentDispatch({}, deps);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(textOf(result.result)).toBe(
			"Invalid parameters. Provide exactly one mode.\nAvailable agents: scout (user), worker (user)",
		);
		expect(result.result.details?.mode).toBe("single");
		expect(result.result.details?.dispatchStatus).toBe("failed");
		expect(result.result.details?.results).toEqual([]);
		expect(result.result.isError).toBeUndefined();
		expect(calls.nextRunId).toBe(0);
		expect(calls.nextDispatchId).toBe(0);
		expect(calls.safeMode).toBe(0);
	});

	test("rejects multiple modes", async () => {
		const { deps } = createHarness();
		const result = await prepareSubagentDispatch(
			{ agent: "scout", task: "t", tasks: [{ agent: "scout", task: "t" }] },
			deps,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(textOf(result.result)).toContain("Invalid parameters. Provide exactly one mode.");
		expect(result.result.details?.mode).toBe("single");
	});

	test("rejects a single request missing its task", async () => {
		const { deps } = createHarness();
		const result = await prepareSubagentDispatch({ agent: "scout" }, deps);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(textOf(result.result)).toContain("Invalid parameters. Provide exactly one mode.");
	});

	test("reports the discovered agent list when validation fails", async () => {
		const { deps } = createHarness({ agents: [agent("scout"), agent("worker", "project")] });
		const result = await prepareSubagentDispatch({ agent: "scout" }, deps);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(textOf(result.result)).toContain("scout (user), worker (project)");
	});
});

describe("unknown agents", () => {
	test("rejects an unknown single agent before allocating IDs", async () => {
		const { deps, calls } = createHarness({ runIds: ["sa-1"], dispatchIds: ["d-1"] });
		const result = await prepareSubagentDispatch({ agent: "ghost", task: "t" }, deps);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(textOf(result.result)).toBe(
			'Unknown agent: "ghost". Available agents: scout (user), worker (user).',
		);
		expect(result.result.details?.mode).toBe("single");
		expect(result.result.details?.dispatchStatus).toBe("failed");
		expect(result.result.isError).toBe(true);
		expect(calls.nextRunId).toBe(0);
		expect(calls.nextDispatchId).toBe(0);
		expect(calls.safeMode).toBe(0);
	});

	test("rejects the whole parallel dispatch when any agent is unknown", async () => {
		const { deps, calls } = createHarness();
		const result = await prepareSubagentDispatch(
			{
				tasks: [
					{ agent: "scout", task: "1" },
					{ agent: "ghost", task: "2" },
				],
			},
			deps,
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(textOf(result.result)).toContain('Unknown agent: "ghost"');
		expect(result.result.details?.mode).toBe("parallel");
		expect(result.result.isError).toBe(true);
		expect(calls.nextRunId).toBe(0);
	});

	test("deduplicates unknown names in input order", async () => {
		const { deps } = createHarness();
		const result = await prepareSubagentDispatch(
			{
				chain: [
					{ agent: "ghost", task: "1" },
					{ agent: "scout", task: "2" },
					{ agent: "phantom", task: "3" },
					{ agent: "ghost", task: "4" },
				],
			},
			deps,
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(textOf(result.result)).toBe(
			'Unknown agents: "ghost", "phantom". Available agents: scout (user), worker (user).',
		);
	});
});

describe("project-agent approval", () => {
	test("denies a project agent when the hub does not allow it", async () => {
		const { deps, calls } = createHarness({
			agents: [agent("scout"), agent("worker", "project")],
			projectAgentsDir: "/repo/.pi/agents",
			permission: "deny",
			cwd: "/work",
		});

		const result = await prepareSubagentDispatch(
			{ agent: "worker", task: "t", agentScope: "both" },
			deps,
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(textOf(result.result)).toBe("Canceled: project-local agents not approved.");
		expect(result.result.details?.mode).toBe("single");
		expect(result.result.details?.dispatchStatus).toBe("aborted");
		expect(result.result.isError).toBeUndefined();
		expect(calls.permission).toEqual([
			{
				what: "perm:agent",
				data: { agents: "worker", source: "/repo/.pi/agents", cwd: "/work" },
			},
		]);
		expect(calls.nextRunId).toBe(0);
		expect(calls.nextDispatchId).toBe(0);
		expect(calls.safeMode).toBe(0);
	});

	test("treats a missing permission response as denial", async () => {
		const { deps } = createHarness({
			agents: [agent("worker", "project")],
			projectAgentsDir: "/repo/.pi/agents",
			permission: undefined,
		});
		const result = await prepareSubagentDispatch(
			{ agent: "worker", task: "t", agentScope: "project" },
			deps,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.result.details?.dispatchStatus).toBe("aborted");
	});

	test("proceeds when the hub allows the project agent", async () => {
		const { deps, calls } = createHarness({
			agents: [agent("worker", "project")],
			projectAgentsDir: "/repo/.pi/agents",
			permission: "allow",
			runIds: ["sa-1"],
			dispatchIds: ["d-1"],
		});
		const result = await prepareSubagentDispatch(
			{ agent: "worker", task: "t", agentScope: "project" },
			deps,
		);
		expect(result.ok).toBe(true);
		expect(calls.permission).toHaveLength(1);
		expect(calls.nextRunId).toBe(1);
		expect(calls.safeMode).toBe(1);
	});

	test("skips approval for user scope even when project agents exist", async () => {
		const { deps, calls } = createHarness({
			agents: [agent("worker", "project")],
			projectAgentsDir: "/repo/.pi/agents",
		});
		const result = await prepareSubagentDispatch(
			{ agent: "worker", task: "t", agentScope: "user" },
			deps,
		);
		expect(result.ok).toBe(true);
		expect(calls.permission).toHaveLength(0);
	});

	test("skips approval when only user agents are requested", async () => {
		const { deps, calls } = createHarness({
			agents: [agent("scout"), agent("worker", "project")],
			projectAgentsDir: "/repo/.pi/agents",
			permission: "deny",
		});
		const result = await prepareSubagentDispatch(
			{ agent: "scout", task: "t", agentScope: "both" },
			deps,
		);
		expect(result.ok).toBe(true);
		expect(calls.permission).toHaveLength(0);
	});

	test("skips approval when confirmProjectAgents is false", async () => {
		const { deps, calls } = createHarness({
			agents: [agent("worker", "project")],
			projectAgentsDir: "/repo/.pi/agents",
			permission: "deny",
		});
		const result = await prepareSubagentDispatch(
			{ agent: "worker", task: "t", agentScope: "both", confirmProjectAgents: false },
			deps,
		);
		expect(result.ok).toBe(true);
		expect(calls.permission).toHaveLength(0);
	});

	test("collects unique project agents for a parallel request in input order", async () => {
		const { deps, calls } = createHarness({
			agents: [agent("alpha", "project"), agent("beta", "project")],
			projectAgentsDir: "/repo/.pi/agents",
			permission: "allow",
		});
		const result = await prepareSubagentDispatch(
			{
				agentScope: "both",
				tasks: [
					{ agent: "alpha", task: "1" },
					{ agent: "beta", task: "2" },
					{ agent: "alpha", task: "3" },
				],
			},
			deps,
		);
		expect(result.ok).toBe(true);
		expect(calls.permission[0]?.data.agents).toBe("alpha, beta");
	});
});

describe("effect ordering", () => {
	test("allocates run IDs, then the dispatch ID, then the safe-mode snapshot", async () => {
		const { deps, calls } = createHarness({ runIds: ["sa-1", "sa-2"], dispatchIds: ["d-1"] });
		const result = await prepareSubagentDispatch(
			{
				tasks: [
					{ agent: "scout", task: "1" },
					{ agent: "worker", task: "2" },
				],
			},
			deps,
		);

		expect(result.ok).toBe(true);
		expect(calls.order).toEqual(["run-id", "run-id", "dispatch-id", "safe-mode"]);
	});

	test("runs permission before allocating any IDs", async () => {
		const { deps, calls } = createHarness({
			agents: [agent("worker", "project")],
			projectAgentsDir: "/repo/.pi/agents",
			permission: "allow",
			runIds: ["sa-1"],
			dispatchIds: ["d-1"],
		});
		await prepareSubagentDispatch({ agent: "worker", task: "t", agentScope: "project" }, deps);
		expect(calls.order).toEqual(["permission", "run-id", "dispatch-id", "safe-mode"]);
	});
});
