import { describe, expect, test } from "bun:test";
import {
	SAFE_MODE_STATE_REQUEST_EVENT,
	SAFE_MODE_STATE_RESPONSE_EVENT,
	appendSafeModeArgs,
	querySafeModeSnapshot,
} from "./safe-mode.ts";

class FakeEvents {
	private handlers = new Map<string, Set<(payload: unknown) => void>>();

	on(channel: string, handler: (payload: unknown) => void): () => void {
		const handlers = this.handlers.get(channel) ?? new Set();
		handlers.add(handler);
		this.handlers.set(channel, handlers);
		return () => handlers.delete(handler);
	}

	emit(channel: string, payload: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(payload);
	}

	listenerCount(channel: string): number {
		return this.handlers.get(channel)?.size ?? 0;
	}
}

describe("subagent safe-mode inheritance", () => {
	test("queries a correlated snapshot and cleans up its listener", async () => {
		const events = new FakeEvents();
		events.on(SAFE_MODE_STATE_REQUEST_EVENT, (payload) => {
			const { id } = payload as { id: string };
			events.emit(SAFE_MODE_STATE_RESPONSE_EVENT, {
				id: "other-request",
				state: { mode: "yolo", outerAccess: true },
			});
			events.emit(SAFE_MODE_STATE_RESPONSE_EVENT, {
				id,
				state: { mode: "reader", outerAccess: false },
			});
		});

		await expect(querySafeModeSnapshot(events, { requestId: "request-1", timeoutMs: 10 })).resolves.toEqual({
			mode: "reader",
			outerAccess: false,
		});
		expect(events.listenerCount(SAFE_MODE_STATE_RESPONSE_EVENT)).toBe(0);
	});

	test("times out when safe-mode is absent", async () => {
		const events = new FakeEvents();
		await expect(querySafeModeSnapshot(events, { timeoutMs: 1 })).resolves.toBeUndefined();
		expect(events.listenerCount(SAFE_MODE_STATE_RESPONSE_EVENT)).toBe(0);
	});

	test("adds both flags only when a snapshot is available", () => {
		const inherited = ["--mode", "json"];
		appendSafeModeArgs(inherited, { mode: "smart", outerAccess: false });
		expect(inherited).toEqual([
			"--mode",
			"json",
			"--safe-mode",
			"smart",
			"--safe-mode-outer-access",
			"false",
		]);

		const unavailable = ["--mode", "json"];
		appendSafeModeArgs(unavailable, undefined);
		expect(unavailable).toEqual(["--mode", "json"]);
	});
});
