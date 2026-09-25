import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Set before anything touches the state module, and resolved per call, so the
// real ~/.pi file is never written by a test run.
const statePath = join(mkdtempSync(join(tmpdir(), "focus-mode-ext-")), "state.json");
process.env.PI_FOCUS_MODE_STATE_PATH = statePath;

const focusModeExtension = (await import("./index")).default;
const { loadGlobalState, globalStatePath } = await import("./state");

type Command = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
	handler: (args: string, ctx: unknown) => Promise<void>;
};

function setup() {
	const commands = new Map<string, Command>();
	const events = new Map<string, Array<() => void | Promise<void>>>();
	const pi = {
		on(event: string, handler: () => void | Promise<void>) {
			const list = events.get(event) ?? [];
			list.push(handler);
			events.set(event, list);
		},
		registerCommand(name: string, options: Command) {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;

	focusModeExtension(pi);

	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
	};

	return {
		commands,
		events,
		notifications,
		run: async (args: string) => {
			const command = commands.get("px:focus");
			if (!command) throw new Error("px:focus is not registered");
			notifications.length = 0;
			await command.handler(args, ctx);
			return notifications.at(-1);
		},
		state: () => loadGlobalState(statePath).state,
	};
}

describe("px:focus command", () => {
	test("never touches the real state file", () => {
		expect(globalStatePath()).toBe(statePath);
	});

	test("registers the command with completions", () => {
		const { commands } = setup();
		const command = commands.get("px:focus");
		expect(command?.description).toContain("reading column");
		expect(command?.getArgumentCompletions?.("").map((item) => item.value)).toContain("set");
	});

	test("defaults to an enabled 100 column column", () => {
		const { state } = setup();
		expect(state()).toEqual({ version: 1, enabled: true, width: 100, bias: 0 });
	});

	test("no arguments toggles", async () => {
		const { run, state } = setup();
		await run("");
		expect(state().enabled).toBe(false);
		await run("");
		expect(state().enabled).toBe(true);
	});

	test("on and off", async () => {
		const { run, state } = setup();
		await run("off");
		expect(state().enabled).toBe(false);
		await run("on");
		expect(state().enabled).toBe(true);
	});

	test("set and on with a width persist the width", async () => {
		const { run, state } = setup();
		await run("set 96");
		expect(state()).toEqual({ version: 1, enabled: true, width: 96, bias: 0 });

		await run("off");
		await run("on 140");
		expect(state()).toEqual({ version: 1, enabled: true, width: 140, bias: 0 });
	});

	test("off keeps the remembered width", async () => {
		const { run, state } = setup();
		await run("set 96");
		await run("off");
		expect(state()).toEqual({ version: 1, enabled: false, width: 96, bias: 0 });
	});

	test("reports bad input without changing state", async () => {
		const { run, state } = setup();
		const before = state();
		const result = await run("sideways");
		expect(result?.type).toBe("warning");
		expect(result?.message).toContain("unknown option");
		expect(result?.message).toContain("/px:focus set 100");
		expect(state()).toEqual(before);
	});

	test("bias sets and reports the sideways offset", async () => {
		const { run, state } = setup();
		await run("bias -50");
		expect(state().bias).toBe(-50);
		expect((await run("bias"))?.message).toContain("50% to the left");

		await run("set 96");
		await run("bias 25");
		expect(state()).toEqual({ version: 1, enabled: true, width: 96, bias: 25 });
		expect((await run("bias"))?.message).toContain("25% to the right");

		await run("bias 0");
		expect(state().bias).toBe(0);
		expect((await run("bias"))?.message).toContain("centered");
	});

	test("survives on, off and toggle", async () => {
		const { run, state } = setup();
		await run("bias -40");
		await run("off");
		expect(state().bias).toBe(-40);
		await run("on 110");
		expect(state()).toEqual({ version: 1, enabled: true, width: 110, bias: -40 });
		await run("");
		expect(state().enabled).toBe(false);
		expect(state().bias).toBe(-40);
	});

	test("set accepts columns/bias and leaves the bias alone without it", async () => {
		const { run, state } = setup();
		await run("set 100/-50");
		expect(state()).toEqual({ version: 1, enabled: true, width: 100, bias: -50 });

		// No bias half: the width changes, the bias stays.
		await run("set 120");
		expect(state()).toEqual({ version: 1, enabled: true, width: 120, bias: -50 });

		await run("set 90/50");
		expect(state()).toEqual({ version: 1, enabled: true, width: 90, bias: 50 });
	});

	test("rejects a bias outside the supported range", async () => {
		const { run, state } = setup();
		const before = state().bias;
		const result = await run("bias -500");
		expect(result?.message).toContain("between -100 and 100");
		expect(state().bias).toBe(before);
	});

	test("warns instead of pretending when there is no terminal", async () => {
		const { run } = setup();
		const result = await run("on 120");
		expect(result?.type).toBe("warning");
		expect(result?.message).toContain("interactive terminal");
	});
});
