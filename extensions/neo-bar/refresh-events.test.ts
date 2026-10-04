import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import statusBarExtension from "./index.ts";

test("refreshes on lifecycle events, not streaming message updates", () => {
	const handlers = new Map<string, unknown[]>();
	const pi = {
		on(event: string, handler: unknown) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		events: { on() {}, emit() {} },
		registerCommand() {},
	} as unknown as ExtensionAPI;

	statusBarExtension(pi);

	expect(handlers.has("message_update")).toBe(false);
	const refresh = handlers.get("message_start")?.[0];
	expect(refresh).toBeFunction();
	for (const event of [
		"session_compact", "model_select", "turn_start", "turn_end",
		"agent_start", "agent_end", "message_end", "input", "user_bash",
	]) {
		expect(handlers.get(event)).toContain(refresh);
	}
	for (const event of ["session_start", "session_tree", "session_shutdown"]) {
		expect(handlers.has(event)).toBe(true);
	}
});
