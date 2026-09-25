import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import devkit from "./index.ts";

interface RegisteredCommand {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

interface Harness {
	commands: Map<string, RegisteredCommand>;
	shortcuts: Map<string, (ctx: ExtensionContext) => Promise<void> | void>;
	sent: Array<{ content: string; options: unknown }>;
}

function createHarness(): Harness & { pi: ExtensionAPI } {
	const harness: Harness = {
		commands: new Map(),
		shortcuts: new Map(),
		sent: [],
	};

	const pi = {
		registerCommand: (name: string, options: RegisteredCommand) => {
			harness.commands.set(name, options);
		},
		registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => void }) => {
			harness.shortcuts.set(key, options.handler);
		},
		sendUserMessage: (content: string, options?: unknown) => {
			harness.sent.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	devkit(pi);
	return { ...harness, pi };
}

describe("devkit", () => {
	test("registers Alt+Ctrl+R as a reload shortcut", () => {
		const { shortcuts } = createHarness();
		expect([...shortcuts.keys()]).toEqual([Key.altCtrl("r")]);
	});

	test("shortcut dispatches the internal reload command", () => {
		const { shortcuts, sent } = createHarness();
		const handler = shortcuts.get(Key.altCtrl("r"));
		handler?.({} as ExtensionContext);

		expect(sent).toEqual([{ content: "/devkit:reload", options: { expandPromptTemplates: true } }]);
	});

	test("reload command calls ctx.reload()", async () => {
		const { commands } = createHarness();
		const command = commands.get("devkit:reload");
		let reloads = 0;
		await command?.handler("", { reload: async () => void (reloads += 1) } as unknown as ExtensionCommandContext);

		expect(reloads).toBe(1);
	});
});
