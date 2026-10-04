import { expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gustExtension from "./index.ts";
import { Orchestrator, type OrchestratorStatus } from "./orchestrator.ts";

test("model command lists available provider/id models and inherit default", async () => {
	const commands = new Map<string, any>();
	const pi = { registerCommand: (name: string, command: unknown) => commands.set(name, command), on() {}, events: { emit() {}, on() {} } } as unknown as ExtensionAPI;
	gustExtension(pi);
	const optionsSeen: string[][] = [];
	const notices: string[] = [];
	let choice = "provider/chosen";
	const ctx = {
		hasUI: true,
		modelRegistry: { getAvailable: () => [{ provider: "provider", id: "chosen" }, { provider: "other", id: "model" }] },
		ui: {
			select: async (_title: string, options: string[]) => { optionsSeen.push(options); return choice; },
			notify: (text: string) => notices.push(text),
		},
	};
	const command = commands.get("px:gust");
	await command.handler("model", ctx);
	expect(optionsSeen[0]).toEqual(["Inherit chat model", "provider/chosen", "other/model"]);
	expect(notices.at(-1)).toContain("provider/chosen");
	choice = "Inherit chat model";
	await command.handler("model", ctx);
	expect(notices.at(-1)).toContain("Inherit chat model");
	expect(command.getArgumentCompletions("m")).toEqual([{ value: "model", label: "model" }]);
	expect(command.getArgumentCompletions("l")).toEqual([{ value: "list", label: "list" }]);
});

for (const mode of ["TUI", "RPC"]) {
	test(`${mode}: initial/change/replacement/reload/shutdown presentation contract`, async () => {
		const commands = new Map<string, any>();
		const events = new Map<string, any>();
		const emitted: unknown[] = [];
		const statuses: unknown[][] = [];
		const widgets: unknown[][] = [];
		const pi = {
			registerCommand: (name: string, command: unknown) => commands.set(name, command),
			on: (name: string, handler: unknown) => events.set(name, handler),
			events: { emit: (_name: string, payload: unknown) => emitted.push(payload), on() {} },
		} as unknown as ExtensionAPI;
		// RPC custom() is a no-op; statuses and string widgets remain supported.
		const ctx = {
			cwd: "/tmp", hasUI: true, isIdle: () => true,
			ui: {
				notify() {}, custom: async () => undefined,
				setStatus: (...args: unknown[]) => statuses.push(args),
				setWidget: (...args: unknown[]) => widgets.push(args),
			},
		};
		const previousCommand = process.env.GUST_CMD;
		const previousArgv = process.argv;
		process.argv = [previousArgv[0], previousArgv[1], ...(mode === "RPC" ? ["--mode", "rpc"] : [])];
		process.env.GUST_CMD = "/usr/bin/true"; // Deterministic unavailable detector; no server needed.
		let statusSpy: ReturnType<typeof spyOn> | undefined;
		try {
			gustExtension(pi);
			await events.get("session_start")({ reason: "startup" }, ctx);
			expect(statuses).toEqual([["gust", undefined], ["gust-hold", undefined]]);
			expect(widgets).toEqual([["gust", undefined, undefined]]);
			await events.get("before_agent_start")({}, { ...ctx });
			await events.get("agent_start")({}, { ...ctx });
			await events.get("agent_settled")({}, { ...ctx });
			expect(statuses).toHaveLength(2);
			expect(emitted).toHaveLength(4); // Detector/hold event publication stays operational.
			if (mode === "RPC") {
				await Bun.sleep(3_100);
				expect(emitted).toHaveLength(5); // Idle polling continues, without duplicate status traffic.
				expect(statuses).toHaveLength(2);
			}
			const command = commands.get("px:gust");
			await command.handler("", ctx); // Creates a stopped orchestrator.
			const status: OrchestratorStatus = {
				running: true, started: true, phase: "worker", active: "thread-id", processed: 0,
				failed: 0, resolved: 0, threads: [{ id: "thread-id", state: "seen", path: "/p" }],
			};
			statusSpy = spyOn(Orchestrator.prototype, "status").mockImplementation(() => status);
			await command.handler("", ctx);
			expect(statuses.at(-1)).toEqual(["gust", "gust: worker · ▶ thread-i · 0 done"]);
			expect(widgets.at(-1)?.[1]).toEqual(["Gust orchestrator — worker", "  ◐ thread-i seen      /p"]);
			const count = widgets.length;
			await command.handler("", { ...ctx });
			expect(widgets).toHaveLength(count);
			status.threads[0].path = "/changed";
			await command.handler("", ctx);
			expect(widgets).toHaveLength(count + 1);
			expect(statuses).toHaveLength(3); // Widget-only change does not republish status.
			status.processed++;
			await command.handler("", ctx);
			expect(statuses).toHaveLength(4);
			expect(widgets).toHaveLength(count + 1);
			const replacement = { ...ctx, ui: { ...ctx.ui } };
			await command.handler("", replacement);
			expect(statuses).toHaveLength(5);
			expect(widgets).toHaveLength(count + 2);
			await events.get("session_start")({ reason: "reload" }, replacement);
			expect(statuses).toHaveLength(7);
			expect(widgets).toHaveLength(count + 3);
			await events.get("session_shutdown")({ reason: "quit" }, replacement);
			expect(statuses.slice(-2)).toEqual([["gust", undefined], ["gust-hold", undefined]]);
			expect(widgets.at(-1)).toEqual(["gust", undefined, undefined]);
			expect(emitted.at(-1)).toEqual({ enabled: false, running: false, paused: false });
		} finally {
			statusSpy?.mockRestore();
			process.argv = previousArgv;
			await events.get("session_shutdown")?.({ reason: "quit" }, ctx);
			if (previousCommand === undefined) delete process.env.GUST_CMD;
			else process.env.GUST_CMD = previousCommand;
			delete (globalThis as { __piXGustHold?: unknown }).__piXGustHold;
		}
	});
}
