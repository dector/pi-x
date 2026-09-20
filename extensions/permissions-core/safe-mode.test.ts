import { describe, expect, test } from "bun:test";
import {
	parseSafeModeChangedSource,
	parseSafeModeSnapshot,
	querySafeModeSnapshot,
	type EventBusLike,
} from "./safe-mode.ts";

function createBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const bus: EventBusLike = {
		emit(channel, data) {
			const set = handlers.get(channel);
			if (!set) return;
			for (const handler of [...set]) handler(data);
		},
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
	};
	return bus;
}

describe("permissions-core safe-mode observer", () => {
	test("parses valid snapshots and changed sources", () => {
		expect(parseSafeModeSnapshot({ mode: "smart", outerAccess: false })).toEqual({
			mode: "smart",
			outerAccess: false,
		});
		expect(parseSafeModeSnapshot({ mode: "SMART", outerAccess: false })).toBeUndefined();
		expect(parseSafeModeSnapshot({ mode: "smart" })).toBeUndefined();
		expect(parseSafeModeChangedSource({ source: "safe-mode" })).toBe("safe-mode");
		expect(parseSafeModeChangedSource({ source: "" })).toBeUndefined();
		expect(parseSafeModeChangedSource({ source: "x".repeat(129) })).toBeUndefined();
	});

	test("resolves the snapshot from a matching response and ignores others", async () => {
		const bus = createBus();
		bus.on("px:safe-mode:state:request", (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			const id = (payload as { id?: unknown }).id;
			if (typeof id !== "string") return;
			// A wrong-id response must not satisfy the query.
			bus.emit("px:safe-mode:state:response", { id: `${id}-other`, state: { mode: "yolo", outerAccess: false } });
			bus.emit("px:safe-mode:state:response", { id, state: { mode: "smart", outerAccess: true } });
		});

		expect(await querySafeModeSnapshot(bus, { timeoutMs: 50 })).toEqual({
			mode: "smart",
			outerAccess: true,
		});
	});

	test("absent provider times out without a brittle wait and never throws", async () => {
		const bus = createBus();
		// No request listener registered; use a tiny timeout so the test is fast.
		expect(await querySafeModeSnapshot(bus, { timeoutMs: 10 })).toBeUndefined();
	});

	test("malformed matching response resolves undefined instead of hanging", async () => {
		const bus = createBus();
		bus.on("px:safe-mode:state:request", (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			const id = (payload as { id?: unknown }).id;
			if (typeof id !== "string") return;
			bus.emit("px:safe-mode:state:response", { id, state: { mode: "bogus", outerAccess: false } });
		});
		expect(await querySafeModeSnapshot(bus, { timeoutMs: 50 })).toBeUndefined();
	});
});
