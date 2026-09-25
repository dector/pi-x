import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import reviewLevelExtension from "./index";

type Handler = (event: any, ctx: any) => unknown;

function setup(branch: unknown[] = []) {
	const lifecycle = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const notifications: Array<{ message: string; type: string }> = [];
	const pickerTitles: string[] = [];
	const bus = {
		emit: (channel: string, payload: unknown) => {
			emitted.push({ channel, payload });
			for (const handler of eventHandlers.get(channel) ?? []) handler(payload);
		},
		on: (channel: string, handler: (payload: unknown) => void) => {
			const handlers = eventHandlers.get(channel) ?? [];
			handlers.push(handler);
			eventHandlers.set(channel, handlers);
			return () => eventHandlers.set(channel, handlers.filter((candidate) => candidate !== handler));
		},
	};
	const pi = {
		events: bus,
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
		model: undefined as { compat?: { supportsMidConvoSystemMessages?: boolean } } | undefined,
		cwd: "/tmp/project",
		sessionManager: { getBranch: () => branch, getSessionId: () => "test-session" },
		ui: {
			notify(message: string, type: string) {
				notifications.push({ message, type });
			},
			select: async (title: string) => {
				pickerTitles.push(title);
				return undefined;
			},
			theme: {
				fg(color: string, text: string) {
					return `<${color}>${text}</${color}>`;
				},
			},
		},
	};
	return { lifecycle, commands, emitted, entries, notifications, pickerTitles, ctx, bus };
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

	test("applies a reset handoff and acknowledges it", async () => {
		const state = setup();
		await fire(state.lifecycle, "session_start", {}, state.ctx);
		state.emitted.length = 0;
		state.bus.emit("px:reset:settings:apply", {
			transferId: "r1",
			owner: "review-level",
			targetSessionId: "test-session",
			cwd: "/tmp/project",
			state: { level: "high" },
		});
		expect(state.entries).toEqual([{ type: "review-level", data: { level: "high" } }]);
		expect(state.emitted).toContainEqual({
			channel: "px:status-bar:review-level:set",
			payload: { level: "high" },
		});
		expect(state.emitted).toContainEqual({
			channel: "px:reset:settings:ack",
			payload: { transferId: "r1", owner: "review-level", targetSessionId: "test-session", cwd: "/tmp/project" },
		});
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

	test("shows the cache warning in red on the picker before selection", async () => {
		const state = setup();
		state.ctx.hasUI = true;
		await state.commands.get("px:review")!.handler("", state.ctx);
		expect(state.pickerTitles).toEqual([
			"Recommended review level\n<error>Changing this setting might invalidate the LLM prompt cache.</error>",
		]);
		expect(state.notifications).toEqual([]);
	});

	test("shows a green Nerd Font check on the picker when prompt patching preserves the cache", async () => {
		const state = setup();
		state.ctx.hasUI = true;
		state.ctx.model = { compat: { supportsMidConvoSystemMessages: true } };
		await state.commands.get("px:review")!.handler("", state.ctx);
		expect(state.pickerTitles).toEqual([
			"Recommended review level\n<success>󰄬 System prompt patching is supported; changing this setting will not invalidate the LLM prompt cache.</success>",
		]);
		expect(state.notifications).toEqual([]);
	});

	test("does not warn when the requested level is already active", async () => {
		const state = setup();
		state.ctx.hasUI = true;
		await state.commands.get("px:review")!.handler("auto", state.ctx);
		expect(state.notifications).toEqual([
			{ message: "Recommended review level already Auto.", type: "info" },
		]);
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
