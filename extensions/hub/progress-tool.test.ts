/**
 * Unit tests for the model-facing `progress` tool.
 *
 * The tool is a synchronous direct client over `hub:progress:*`. These tests
 * drive its public helpers with an in-memory bus, so they never need a real Pi
 * runtime. They cover argument validation, ID generation, the exact mutation
 * payloads, ack correlation, error conversion, and listener cleanup.
 */

import { describe, expect, test } from "bun:test";
import { HUB_PROGRESS_CHANNELS, type HubProgressAckPayload, type ProgressOperation } from "./contract.ts";
import {
	PROGRESS_TOOL_OWNER,
	ProgressToolParams,
	runProgressAction,
	type ProgressToolEventBus,
} from "./progress-tool.ts";

const CH = HUB_PROGRESS_CHANNELS;

type EventHandler = (payload: unknown) => void;

interface FakeBus extends ProgressToolEventBus {
	emitted: Array<{ event: string; payload: unknown }>;
	listenerCount(event: string): number;
}

function createFakeBus(): FakeBus {
	const handlers = new Map<string, Set<EventHandler>>();
	const emitted: Array<{ event: string; payload: unknown }> = [];
	return {
		emitted,
		on(event, handler) {
			const set = handlers.get(event) ?? new Set<EventHandler>();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
		emit(event, payload) {
			emitted.push({ event, payload });
			for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
		},
		listenerCount(event) {
			return handlers.get(event)?.size ?? 0;
		},
	};
}

interface HubBehavior {
	respond?: boolean;
	ok?: boolean;
	error?: HubProgressAckPayload["error"];
	wrongRequestId?: boolean;
}

/** Install a minimal, always-synchronous hub on every mutation channel. */
function installHub(bus: FakeBus, behavior: HubBehavior = {}): void {
	const { respond = true, ok = true, error, wrongRequestId = false } = behavior;
	const operations: Array<[string, ProgressOperation]> = [
		[CH.create, "create"],
		[CH.update, "update"],
		[CH.finish, "finish"],
		[CH.remove, "remove"],
	];

	for (const [channel, operation] of operations) {
		bus.on(channel, (payload) => {
			if (!respond) return;
			const record = payload as Record<string, unknown>;
			const ack: HubProgressAckPayload = {
				requestId: wrongRequestId ? "someone-elses-request" : String(record.requestId),
				trackerId: String(record.trackerId),
				trackerToken: String(record.trackerToken),
				owner: String(record.owner),
				operation,
				ok,
				changed: ok,
			};
			if (error !== undefined) ack.error = error;
			bus.emit(CH.ack, ack);
		});
	}
}

function mutationFor(bus: FakeBus, channel: string): Record<string, unknown> {
	const matches = bus.emitted.filter((entry) => entry.event === channel);
	expect(matches).toHaveLength(1);
	return matches[0]!.payload as Record<string, unknown>;
}

const startParams = () => ({
	action: "start",
	title: "Authentication",
	chunks: [
		{ id: "a", label: "Database schema" },
		{ id: "b", label: "API" },
	],
});

const updateParams = () => ({
	action: "update",
	trackerId: "t1",
	trackerToken: "tok-1",
	chunkId: "a",
	state: "active" as const,
});

const finishParams = () => ({
	action: "finish",
	trackerId: "t1",
	trackerToken: "tok-1",
	outcome: "failed" as const,
});

const clearParams = () => ({ action: "clear", trackerId: "t1", trackerToken: "tok-1" });

describe("progress tool params", () => {
	test("never exposes hidden owner or requestId parameters", () => {
		const properties = ProgressToolParams.properties as Record<string, unknown>;
		expect(Object.keys(properties).sort()).toEqual(
			[
				"action",
				"chunkId",
				"chunks",
				"detail",
				"outcome",
				"phase",
				"state",
				"summary",
				"title",
				"trackerId",
				"trackerToken",
				"unit",
			].sort(),
		);
		expect(properties.owner).toBeUndefined();
		expect(properties.requestId).toBeUndefined();
	});
});

describe("progress tool start", () => {
	test("generates and returns a tracker id and tracker token", async () => {
		const bus = createFakeBus();
		installHub(bus);

		const result = await runProgressAction(bus, startParams());

		expect(result.details.trackerId).toMatch(/^progress-/);
		expect(result.details.trackerToken.length).toBeGreaterThan(0);

		const payload = mutationFor(bus, CH.create);
		expect(payload.trackerId).toBe(result.details.trackerId);
		expect(payload.trackerToken).toBe(result.details.trackerToken);

		const text = result.content[0]?.text ?? "";
		expect(text).toContain(result.details.trackerId);
		expect(text).toContain(result.details.trackerToken);
	});

	test("preserves a supplied tracker id while still generating a fresh token", async () => {
		const firstBus = createFakeBus();
		installHub(firstBus);
		const first = await runProgressAction(firstBus, { ...startParams(), trackerId: "progress-fixed" });

		const secondBus = createFakeBus();
		installHub(secondBus);
		const second = await runProgressAction(secondBus, { ...startParams(), trackerId: "progress-fixed" });

		expect(first.details.trackerId).toBe("progress-fixed");
		expect(second.details.trackerId).toBe("progress-fixed");
		expect(first.details.trackerToken).not.toBe(second.details.trackerToken);

		expect(mutationFor(firstBus, CH.create).trackerToken).toBe(first.details.trackerToken);
	});
});

describe("progress tool payloads", () => {
	const cases: Array<{
		name: string;
		params: Record<string, unknown>;
		channel: string;
		operation: ProgressOperation;
	}> = [
		{ name: "start", params: startParams(), channel: CH.create, operation: "create" },
		{ name: "update", params: updateParams(), channel: CH.update, operation: "update" },
		{ name: "finish", params: finishParams(), channel: CH.finish, operation: "finish" },
		{ name: "clear", params: clearParams(), channel: CH.remove, operation: "remove" },
	];

	for (const testCase of cases) {
		test(`${testCase.name} emits exactly one mutation with a hidden owner and request id`, async () => {
			const bus = createFakeBus();
			installHub(bus);

			const result = await runProgressAction(bus, testCase.params);

			const payload = mutationFor(bus, testCase.channel);
			expect(payload.owner).toBe(PROGRESS_TOOL_OWNER);
			expect(typeof payload.requestId).toBe("string");
			expect((payload.requestId as string).length).toBeGreaterThan(0);
			expect(result.details.operation).toBe(testCase.operation);

			const detailsJson = JSON.stringify(result.details);
			expect(detailsJson).not.toContain("owner");
			expect(detailsJson).not.toContain("requestId");
		});
	}

	test("generates a fresh request id for every call", async () => {
		const bus = createFakeBus();
		installHub(bus);

		await runProgressAction(bus, updateParams());
		await runProgressAction(bus, updateParams());

		const requestIds = bus.emitted
			.filter((entry) => entry.event === CH.update)
			.map((entry) => (entry.payload as Record<string, unknown>).requestId);
		expect(requestIds).toHaveLength(2);
		expect(requestIds[0]).not.toBe(requestIds[1]);
	});

	test("update omits phase and detail so the hub clears them", async () => {
		const bus = createFakeBus();
		installHub(bus);
		await runProgressAction(bus, updateParams());

		const payload = mutationFor(bus, CH.update);
		expect("phase" in payload).toBe(false);
		expect("detail" in payload).toBe(false);
	});

	test("update forwards phase and detail when provided", async () => {
		const bus = createFakeBus();
		installHub(bus);
		await runProgressAction(bus, {
			...updateParams(),
			phase: "reviewing",
			detail: "Checking request validation",
		});

		const payload = mutationFor(bus, CH.update);
		expect(payload.phase).toBe("reviewing");
		expect(payload.detail).toBe("Checking request validation");
	});
});

describe("progress tool acknowledgement handling", () => {
	test("a matching positive ack succeeds", async () => {
		const bus = createFakeBus();
		installHub(bus);

		const result = await runProgressAction(bus, updateParams());

		expect(result.details.trackerId).toBe("t1");
		expect(result.content[0]?.text).toContain("progress update");
	});

	test("a negative ack becomes a tool error", async () => {
		const bus = createFakeBus();
		installHub(bus, { ok: false, error: "stale-tracker" });

		await expect(runProgressAction(bus, updateParams())).rejects.toThrow("stale-tracker");
	});

	test("an unrelated ack is ignored while the matching ack is accepted", async () => {
		const bus = createFakeBus();
		// The first handler replies with a foreign request id; the tool must skip it
		// and still accept the correct ack emitted by the second handler.
		bus.on(CH.update, (payload) => {
			const record = payload as Record<string, unknown>;
			bus.emit(CH.ack, {
				requestId: "someone-elses-request",
				trackerId: String(record.trackerId),
				trackerToken: String(record.trackerToken),
				owner: String(record.owner),
				operation: "update",
				ok: false,
				changed: false,
				error: "not-found",
			} satisfies HubProgressAckPayload);
		});
		installHub(bus);

		const result = await runProgressAction(bus, updateParams());

		expect(result.details.action).toBe("update");
	});

	test("an absent ack becomes the progress hub unavailable error", async () => {
		const bus = createFakeBus();
		installHub(bus, { respond: false });

		await expect(runProgressAction(bus, updateParams())).rejects.toThrow("progress hub unavailable");
	});

	test("only a wrong-request-id ack is treated as unavailable", async () => {
		const bus = createFakeBus();
		installHub(bus, { wrongRequestId: true });

		await expect(runProgressAction(bus, updateParams())).rejects.toThrow("progress hub unavailable");
	});
});

describe("progress tool listener cleanup", () => {
	test("removes the ack listener after success, rejection, and absence", async () => {
		const successBus = createFakeBus();
		installHub(successBus);
		await runProgressAction(successBus, updateParams());
		expect(successBus.listenerCount(CH.ack)).toBe(0);

		const rejectedBus = createFakeBus();
		installHub(rejectedBus, { ok: false, error: "tracker-finished" });
		await expect(runProgressAction(rejectedBus, updateParams())).rejects.toThrow();
		expect(rejectedBus.listenerCount(CH.ack)).toBe(0);

		const silentBus = createFakeBus();
		installHub(silentBus, { respond: false });
		await expect(runProgressAction(silentBus, updateParams())).rejects.toThrow();
		expect(silentBus.listenerCount(CH.ack)).toBe(0);
	});
});

describe("progress tool validation", () => {
	const invalidCases: unknown[] = [
		{},
		{ action: "unknown" },
		{ action: "start" },
		{ action: "start", title: "Auth" },
		{ action: "start", title: "Auth", chunks: [] },
		{ action: "start", title: "Auth", chunks: [{ id: "a" }, { id: "a" }] },
		{ action: "start", title: "", chunks: [{ id: "a" }] },
		{ action: "start", title: "Auth", chunks: [{ label: "no id" }] },
		{ action: "start", title: "Auth", chunks: [{ id: "a" }], trackerId: "" },
		{ action: "update", trackerId: "t1", trackerToken: "tok", chunkId: "a" },
		{ action: "update", trackerId: "t1", trackerToken: "tok", chunkId: "a", state: "reviewing" },
		{ action: "update", trackerId: "t1", trackerToken: "tok", chunkId: "a", state: 42 },
		{ action: "finish", trackerId: "t1", trackerToken: "tok" },
		{ action: "finish", trackerId: "t1", trackerToken: "tok", outcome: "done" },
		{ action: "clear", trackerId: "t1" },
		{ action: "clear", trackerToken: "tok" },
	];

	for (const [index, params] of invalidCases.entries()) {
		test(`invalid arguments #${index} throw without emitting an event`, async () => {
			const bus = createFakeBus();
			installHub(bus);

			await expect(runProgressAction(bus, params)).rejects.toThrow();

			expect(bus.emitted).toHaveLength(0);
			expect(bus.listenerCount(CH.ack)).toBe(0);
		});
	}
});
