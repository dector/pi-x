import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import reviewLevelExtension from "./index";

type Handler = (event: any, ctx: any) => unknown;

function setup(branch: unknown[] = []) {
	const lifecycle = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const pi = {
		events: { emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }) },
		on(event: string, handler: Handler) {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, options);
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
	};
	reviewLevelExtension(pi as unknown as ExtensionAPI);
	const ctx = {
		hasUI: false,
		sessionManager: { getBranch: () => branch },
		ui: { notify() {}, select: async () => undefined },
	};
	return { lifecycle, commands, emitted, entries, ctx };
}

async function fire(handlers: Map<string, Handler[]>, event: string, payload: unknown, ctx: unknown) {
	for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
}

describe("review-level extension", () => {
	test("defaults to auto and keeps auto out of the prompt", async () => {
		const state = setup();
		await fire(state.lifecycle, "session_start", {}, state.ctx);
		expect(state.emitted.at(-1)).toEqual({
			channel: "px:status-bar:review-level:set",
			payload: { level: "auto" },
		});

		const sections = { existing: "keep" };
		await fire(state.lifecycle, "before_agent_start", { systemPromptOptions: { sections } }, state.ctx);
		expect(sections).toEqual({ existing: "keep" });
	});

	test("restores the latest branch setting and injects its recommendation", async () => {
		const state = setup([
			{ type: "custom", customType: "review-level", data: { level: "minimal" } },
			{ type: "custom", customType: "review-level", data: { level: "high" } },
		]);
		await fire(state.lifecycle, "session_start", {}, state.ctx);
		const sections: Record<string, string> = {};
		await fire(state.lifecycle, "before_agent_start", { systemPromptOptions: { sections } }, state.ctx);
		expect(sections.review_recommendation).toContain("level HIGH");
	});

	test("command persists and publishes a direct level argument", async () => {
		const state = setup();
		await fire(state.lifecycle, "session_start", {}, state.ctx);
		await state.commands.get("px:review")!.handler("normal", state.ctx);
		expect(state.entries).toEqual([{ type: "review-level", data: { level: "normal" } }]);
		expect(state.emitted.at(-1)).toEqual({
			channel: "px:status-bar:review-level:set",
			payload: { level: "normal" },
		});
	});

	test("tree navigation restores branch-local state and defaults an empty branch to auto", async () => {
		const branch: unknown[] = [{ type: "custom", customType: "review-level", data: { level: "high" } }];
		const state = setup(branch);
		await fire(state.lifecycle, "session_start", {}, state.ctx);
		expect(state.emitted.at(-1)?.payload).toEqual({ level: "high" });

		branch.splice(0, branch.length, { type: "custom", customType: "review-level", data: { level: "minimal" } });
		await fire(state.lifecycle, "session_tree", {}, state.ctx);
		expect(state.emitted.at(-1)?.payload).toEqual({ level: "minimal" });

		branch.splice(0, branch.length);
		await fire(state.lifecycle, "session_tree", {}, state.ctx);
		expect(state.emitted.at(-1)?.payload).toEqual({ level: "auto" });
	});

	test("switching back to auto removes prompt guidance and shutdown clears status", async () => {
		const state = setup();
		await fire(state.lifecycle, "session_start", {}, state.ctx);
		await state.commands.get("px:review")!.handler("high", state.ctx);

		const sections: Record<string, string> = {};
		await fire(state.lifecycle, "before_agent_start", { systemPromptOptions: { sections } }, state.ctx);
		expect(sections.review_recommendation).toContain("level HIGH");

		await state.commands.get("px:review")!.handler("auto", state.ctx);
		await fire(state.lifecycle, "before_agent_start", { systemPromptOptions: { sections } }, state.ctx);
		expect(sections.review_recommendation).toBeUndefined();

		await fire(state.lifecycle, "session_shutdown", {}, state.ctx);
		expect(state.emitted.at(-1)).toEqual({
			channel: "px:status-bar:review-level:clear",
			payload: undefined,
		});
	});
});
