import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gustExtension from "./index.ts";

test("model command lists available provider/id models and inherit default", async () => {
	const commands = new Map<string, any>();
	const pi = { registerCommand: (name: string, command: unknown) => commands.set(name, command), on() {}, events: { emit() {} } } as unknown as ExtensionAPI;
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
