import { describe, expect, test } from "bun:test";
import { withUserWait } from "./user-wait.ts";

type Handler = (payload: unknown) => void;
type Emitted = { event: string; payload: unknown };

interface Bus {
	emitted: Emitted[];
	emit(event: string, payload: unknown): void;
	on(event: string, handler: Handler): () => void;
}

/** Event bus with an optional hub that synchronously acks `set`. */
function createBus(hub: boolean): Bus {
	const handlers = new Map<string, Set<Handler>>();
	const emitted: Emitted[] = [];
	return {
		emitted,
		emit(event, payload) {
			emitted.push({ event, payload });
			if (hub && event === "hub:user-wait:set") {
				const parsed = payload as { id: string; owner: string };
				for (const handler of [...(handlers.get("hub:user-wait:ack") ?? [])]) {
					handler({ id: parsed.id, owner: parsed.owner, operation: "set" });
				}
			}
			for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
		},
		on(event, handler) {
			const set = handlers.get(event) ?? new Set<Handler>();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
	};
}

function named(emitted: Emitted[], event: string): Emitted[] {
	return emitted.filter((entry) => entry.event === event);
}

describe("subagent withUserWait", () => {
	test("hub mode declares and clears without touching herdr:blocked", async () => {
		const bus = createBus(true);

		const result = await withUserWait(
			bus,
			{ owner: "subagent", label: "worker approval", kind: "approval" },
			() => "answer",
		);

		expect(result).toBe("answer");
		expect(named(bus.emitted, "hub:user-wait:set")).toHaveLength(1);
		expect(named(bus.emitted, "hub:user-wait:clear")).toHaveLength(1);
		expect(named(bus.emitted, "herdr:blocked")).toHaveLength(0);

		// The clear must address the exact id/owner the set declared.
		const set = named(bus.emitted, "hub:user-wait:set")[0]!.payload as { id: string; owner: string };
		const clear = named(bus.emitted, "hub:user-wait:clear")[0]!.payload as { id: string; owner: string };
		expect(clear).toEqual({ id: set.id, owner: "subagent" });
	});

	test("legacy mode falls back to herdr:blocked true then false", async () => {
		const bus = createBus(false);

		await withUserWait(bus, { owner: "subagent", label: "worker approval" }, () => undefined);

		expect(named(bus.emitted, "hub:user-wait:set")).toHaveLength(1);
		expect(named(bus.emitted, "hub:user-wait:clear")).toHaveLength(0);
		expect(named(bus.emitted, "herdr:blocked").map((entry) => entry.payload)).toEqual([
			{ active: true, label: "worker approval" },
			{ active: false },
		]);
	});

	test("clears the wait when the dialog throws", async () => {
		const bus = createBus(true);

		await expect(
			withUserWait(bus, { owner: "subagent" }, () => {
				throw new Error("dialog failed");
			}),
		).rejects.toThrow("dialog failed");

		expect(named(bus.emitted, "hub:user-wait:clear")).toHaveLength(1);
	});

	test("each wait gets a unique id", async () => {
		const bus = createBus(true);

		await withUserWait(bus, { owner: "subagent" }, () => undefined);
		await withUserWait(bus, { owner: "subagent" }, () => undefined);

		const ids = named(bus.emitted, "hub:user-wait:set").map((entry) => (entry.payload as { id: string }).id);
		expect(ids).toHaveLength(2);
		expect(ids[0]).not.toBe(ids[1]);
	});
});
