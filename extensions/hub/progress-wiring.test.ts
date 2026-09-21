/**
 * Integration tests for hub's semantic-progress event wiring.
 *
 * The pure registry suite covers transitions. These tests cover what only the
 * real hub extension can: acknowledgement ordering, the `changed` observer
 * contract, query correlation, the session active gate, shutdown reset, and the
 * `/px:hub` + `/px:progress` rendering.
 *
 * Every test input goes through `bus.send` so `bus.emitted` holds hub output
 * only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HUB_PROGRESS_CHANNELS,
	type ProgressCreatePayload,
	type ProgressSnapshot,
} from "./contract.ts";
import hubExtension from "./index.ts";

type Emitted = { event: string; payload: unknown };
type EventHandler = (data: unknown) => void;

interface Bus {
	/** Events hub emitted; test input sent through `send` is not recorded. */
	emitted: Emitted[];
	emit(event: string, payload: unknown): void;
	/** Emit test input without recording it as hub output. */
	send(event: string, payload: unknown): void;
	on(event: string, handler: EventHandler): () => void;
}

function createBus(): Bus {
	const handlers = new Map<string, Set<EventHandler>>();
	const emitted: Emitted[] = [];
	// Consumed by the outermost emit only, so nested hub emits are still
	// recorded while the single test input event is not.
	let suppressRecord = false;
	return {
		emitted,
		emit(event, payload) {
			if (suppressRecord) suppressRecord = false;
			else emitted.push({ event, payload });
			// Snapshot the set so a handler may unsubscribe during dispatch.
			for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
		},
		send(event, payload) {
			suppressRecord = true;
			this.emit(event, payload);
		},
		on(event, handler) {
			const set = handlers.get(event) ?? new Set<EventHandler>();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
	};
}

type PiLifecycle = (event: unknown, ctx: unknown) => unknown;
type HubCommand = { handler: (args: string, ctx: unknown) => unknown };

function createFakePi(bus: Bus) {
	const lifecycle = new Map<string, PiLifecycle>();
	const commands = new Map<string, HubCommand>();
	const pi = {
		events: bus,
		on: (name: string, handler: PiLifecycle) => {
			lifecycle.set(name, handler);
		},
		registerCommand: (name: string, options: HubCommand) => {
			commands.set(name, options);
		},
		registerFlag() {},
		registerShortcut() {},
		appendEntry() {},
		getFlag() {
			return undefined;
		},
		sendUserMessage() {},
	};
	return { pi, lifecycle, commands };
}

function setup() {
	const bus = createBus();
	const { pi, lifecycle, commands } = createFakePi(bus);
	hubExtension(pi as unknown as ExtensionAPI);
	return { bus, lifecycle, commands };
}

const CH = HUB_PROGRESS_CHANNELS;
const OWNER = "progress-tool";

function createPayload(overrides: Partial<ProgressCreatePayload> = {}): ProgressCreatePayload {
	return {
		requestId: "req-1",
		trackerId: "t1",
		trackerToken: "tok-1",
		owner: OWNER,
		title: "Authentication",
		unit: "Stage",
		chunks: [
			{ id: "a", label: "Database schema" },
			{ id: "b", label: "API" },
			{ id: "c", label: "UI" },
		],
		...overrides,
	};
}

function eventsNamed(emitted: Emitted[], event: string): Emitted[] {
	return emitted.filter((entry) => entry.event === event);
}

async function startSession(lifecycle: Map<string, PiLifecycle>): Promise<void> {
	await lifecycle.get("session_start")?.({}, {});
}

async function shutdown(lifecycle: Map<string, PiLifecycle>): Promise<void> {
	await lifecycle.get("session_shutdown")?.({}, {});
}

async function runCommand(commands: Map<string, HubCommand>, name: string, args = ""): Promise<string[]> {
	const messages: string[] = [];
	const command = commands.get(name);
	await command?.handler(args, { hasUI: true, ui: { notify: (message: string) => messages.push(message) } });
	return messages;
}

// Keep the Herdr tab mirror inert so wiring tests never open a socket.
let savedHerdrTab: string | undefined;

beforeEach(() => {
	savedHerdrTab = process.env.PI_HUB_HERDR_TAB;
	process.env.PI_HUB_HERDR_TAB = "0";
});

afterEach(() => {
	if (savedHerdrTab === undefined) delete process.env.PI_HUB_HERDR_TAB;
	else process.env.PI_HUB_HERDR_TAB = savedHerdrTab;
});

describe("hub progress event wiring", () => {
	test("create emits ack then changed", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);

		bus.send(CH.create, createPayload());

		expect(bus.emitted).toEqual([
			{
				event: CH.ack,
				payload: {
					requestId: "req-1",
					trackerId: "t1",
					trackerToken: "tok-1",
					owner: OWNER,
					operation: "create",
					ok: true,
					changed: true,
				},
			},
			{
				event: CH.changed,
				payload: {
					active: true,
					count: 1,
					trackers: [
						{
							trackerId: "t1",
							owner: OWNER,
							title: "Authentication",
							unit: "Stage",
							updatedAt: expect.any(Number),
							chunks: [
								{ index: 1, state: "pending" },
								{ index: 2, state: "pending" },
								{ index: 3, state: "pending" },
							],
						},
					],
				},
			},
		]);
	});

	test("duplicate create emits only an idempotent ack", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);

		bus.send(CH.create, createPayload());
		const before = bus.emitted.length;
		bus.send(CH.create, createPayload());

		expect(bus.emitted.slice(before)).toEqual([
			{
				event: CH.ack,
				payload: {
					requestId: "req-1",
					trackerId: "t1",
					trackerToken: "tok-1",
					owner: OWNER,
					operation: "create",
					ok: true,
					changed: false,
				},
			},
		]);
		expect(eventsNamed(bus.emitted, CH.changed)).toHaveLength(1);
	});

	test("semantic rejection emits a negative ack and no changed", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);

		bus.send(CH.create, createPayload());
		const before = bus.emitted.length;
		bus.send(CH.create, createPayload({ title: "Other" }));

		expect(bus.emitted.slice(before)).toEqual([
			{
				event: CH.ack,
				payload: {
					requestId: "req-1",
					trackerId: "t1",
					trackerToken: "tok-1",
					owner: OWNER,
					operation: "create",
					ok: false,
					changed: false,
					error: "already-exists",
				},
			},
		]);
		expect(eventsNamed(bus.emitted, CH.changed)).toHaveLength(1);
	});

	test("malformed payloads emit nothing at all", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);

		bus.send(CH.create, { requestId: "r" });
		bus.send(CH.create, createPayload({ chunks: [] }));
		bus.send(CH.update, {
			requestId: "r",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: OWNER,
			chunkId: "a",
			state: "reviewing",
		});
		bus.send(CH.finish, null);
		bus.send(CH.remove, undefined);

		expect(bus.emitted).toEqual([]);
	});

	test("update changed snapshot contains the new chunk state", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);

		bus.send(CH.create, createPayload());
		bus.send(CH.update, {
			requestId: "req-2",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: OWNER,
			chunkId: "a",
			state: "active",
			phase: "reviewing",
		});

		const changed = eventsNamed(bus.emitted, CH.changed).at(-1)?.payload as ProgressSnapshot;
		expect(changed.trackers[0]?.chunks[0]).toEqual({ index: 1, state: "active", phase: "reviewing" });
		expect(eventsNamed(bus.emitted, CH.ack).at(-1)?.payload).toEqual({
			requestId: "req-2",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: OWNER,
			operation: "update",
			ok: true,
			changed: true,
		});
	});

	test("finish freezes the tracker and later updates are rejected", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);

		bus.send(CH.create, createPayload());
		bus.send(CH.finish, {
			requestId: "req-2",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: OWNER,
			outcome: "failed",
		});

		const before = bus.emitted.length;
		const changedBefore = eventsNamed(bus.emitted, CH.changed).length;
		bus.send(CH.update, {
			requestId: "req-3",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: OWNER,
			chunkId: "a",
			state: "active",
		});

		expect(bus.emitted.slice(before)).toEqual([
			{
				event: CH.ack,
				payload: {
					requestId: "req-3",
					trackerId: "t1",
					trackerToken: "tok-1",
					owner: OWNER,
					operation: "update",
					ok: false,
					changed: false,
					error: "tracker-finished",
				},
			},
		]);
		expect(eventsNamed(bus.emitted, CH.changed)).toHaveLength(changedBefore);
	});

	test("wrong-owner remove is an accepted no-op that does not remove", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);

		bus.send(CH.create, createPayload());
		bus.send(CH.remove, {
			requestId: "req-2",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: "other",
		});

		expect(eventsNamed(bus.emitted, CH.ack).at(-1)?.payload).toEqual({
			requestId: "req-2",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: "other",
			operation: "remove",
			ok: true,
			changed: false,
		});

		let received: { requestId: string; snapshot: ProgressSnapshot } | undefined;
		const off = bus.on(CH.snapshot, (payload) => {
			received = payload as { requestId: string; snapshot: ProgressSnapshot };
		});
		bus.send(CH.query, { requestId: "q1" });
		off();

		expect(received?.snapshot.count).toBe(1);
	});

	test("query returns the current detached snapshot synchronously", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);
		bus.send(CH.create, createPayload());

		let received: { requestId: string; snapshot: ProgressSnapshot } | undefined;
		const off = bus.on(CH.snapshot, (payload) => {
			received = payload as { requestId: string; snapshot: ProgressSnapshot };
		});
		bus.send(CH.query, { requestId: "q1" });
		off();

		expect(received?.requestId).toBe("q1");
		expect(received?.snapshot).toEqual({
			active: true,
			count: 1,
			trackers: [
				{
					trackerId: "t1",
					owner: OWNER,
					title: "Authentication",
					unit: "Stage",
					updatedAt: expect.any(Number),
					chunks: [
						{ index: 1, state: "pending" },
						{ index: 2, state: "pending" },
						{ index: 3, state: "pending" },
					],
				},
			],
		});

		// The response object is a copy: mutating it cannot affect a later query.
		received!.snapshot.trackers[0]!.title = "HACK";
		let fresh: { snapshot: ProgressSnapshot } | undefined;
		const off2 = bus.on(CH.snapshot, (payload) => {
			fresh = payload as { snapshot: ProgressSnapshot };
		});
		bus.send(CH.query, { requestId: "q2" });
		off2();
		expect(fresh?.snapshot.trackers[0]?.title).toBe("Authentication");
	});

	test("a mutating observer cannot corrupt registry state", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);

		const off = bus.on(CH.changed, (payload) => {
			const snapshot = payload as ProgressSnapshot;
			snapshot.active = false;
			snapshot.count = 0;
			snapshot.trackers[0]!.title = "HACK";
			snapshot.trackers[0]!.chunks[0]!.state = "done";
		});
		bus.send(CH.create, createPayload());
		off();

		let received: { snapshot: ProgressSnapshot } | undefined;
		const off2 = bus.on(CH.snapshot, (payload) => {
			received = payload as { snapshot: ProgressSnapshot };
		});
		bus.send(CH.query, { requestId: "q1" });
		off2();

		expect(received?.snapshot.active).toBe(true);
		expect(received?.snapshot.count).toBe(1);
		expect(received?.snapshot.trackers[0]?.title).toBe("Authentication");
		expect(received?.snapshot.trackers[0]?.chunks[0]?.state).toBe("pending");
	});

	test("shutdown emits one empty snapshot when active trackers exist", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);
		bus.send(CH.create, createPayload());

		const before = bus.emitted.length;
		await shutdown(lifecycle);

		expect(bus.emitted.slice(before)).toEqual([
			{ event: CH.changed, payload: { active: false, count: 0, trackers: [] } },
		]);
	});

	test("shutdown emits no progress event when observer state is already empty", async () => {
		const empty = setup();
		await startSession(empty.lifecycle);
		const beforeEmpty = empty.bus.emitted.length;
		await shutdown(empty.lifecycle);
		expect(empty.bus.emitted.slice(beforeEmpty)).toEqual([]);

		// A finished-only history is empty to observers even though the registry
		// retains the record.
		const finished = setup();
		await startSession(finished.lifecycle);
		finished.bus.send(CH.create, createPayload());
		finished.bus.send(CH.finish, {
			requestId: "req-2",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: OWNER,
			outcome: "failed",
		});
		const beforeFinished = finished.bus.emitted.length;
		await shutdown(finished.lifecycle);
		expect(finished.bus.emitted.slice(beforeFinished)).toEqual([]);
	});

	test("a late mutation after shutdown is ignored and cannot restore state", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);
		bus.send(CH.create, createPayload());
		await shutdown(lifecycle);

		const before = bus.emitted.length;
		bus.send(CH.create, createPayload({ trackerId: "t2", trackerToken: "tok-2", requestId: "req-2" }));
		expect(bus.emitted.slice(before)).toEqual([]);

		let received: { snapshot: ProgressSnapshot } | undefined;
		const off = bus.on(CH.snapshot, (payload) => {
			received = payload as { snapshot: ProgressSnapshot };
		});
		bus.send(CH.query, { requestId: "q1" });
		off();
		expect(received?.snapshot).toEqual({ active: false, count: 0, trackers: [] });
	});

	test("a new session_start re-enables valid mutations", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);
		await shutdown(lifecycle);

		await startSession(lifecycle);
		const before = bus.emitted.length;
		bus.send(CH.create, createPayload());

		expect(bus.emitted.slice(before)).toEqual([
			{
				event: CH.ack,
				payload: {
					requestId: "req-1",
					trackerId: "t1",
					trackerToken: "tok-1",
					owner: OWNER,
					operation: "create",
					ok: true,
					changed: true,
				},
			},
			{
				event: CH.changed,
				payload: expect.objectContaining({ active: true, count: 1 }),
			},
		]);
	});

	test("session_tree keeps progress active", async () => {
		const { bus, lifecycle } = setup();
		await startSession(lifecycle);
		await shutdown(lifecycle);
		await lifecycle.get("session_tree")?.({}, {});

		const before = bus.emitted.length;
		bus.send(CH.create, createPayload());
		expect(eventsNamed(bus.emitted.slice(before), CH.ack)).toHaveLength(1);
	});

	test("/px:hub shows a correct, sanitized progress count", async () => {
		const { bus, lifecycle, commands } = setup();
		await startSession(lifecycle);
		bus.send(CH.create, createPayload({ trackerId: "t1" }));
		bus.send(CH.create, createPayload({ trackerId: "t2", requestId: "req-2", title: "Auth\u001b[31m" }));
		bus.send(CH.finish, {
			requestId: "req-3",
			trackerId: "t2",
			trackerToken: "tok-1",
			owner: OWNER,
			outcome: "failed",
		});

		const messages = await runCommand(commands, "px:hub");
		const message = messages[0] ?? "";

		expect(message).toContain("progress trackers: 2 (1 active)");
		expect(message).not.toContain("\u001b");
	});

	test("/px:progress detail is correct and sanitized", async () => {
		const { bus, lifecycle, commands } = setup();
		await startSession(lifecycle);
		bus.send(
			CH.create,
			createPayload({
				title: "Authentication\u001b[31m",
				chunks: [
					{ id: "a", label: "Database schema" },
					{ id: "b", label: "API\u001b[0m" },
					{ id: "c", label: "UI" },
				],
			}),
		);
		bus.send(CH.update, {
			requestId: "req-2",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: OWNER,
			chunkId: "a",
			state: "active",
			phase: "reviewing",
		});

		const messages = await runCommand(commands, "px:progress", "t1");
		const message = messages[0] ?? "";

		expect(message).toBe(
			"Authentication [active] — 0/3 done\n" +
				"1. [active/reviewing] Database schema\n" +
				"2. [pending] API\n" +
				"3. [pending] UI",
		);
		expect(message).not.toContain("\u001b");
	});

	test("/px:progress without an argument summarizes active and finished trackers", async () => {
		const { bus, lifecycle, commands } = setup();
		await startSession(lifecycle);

		bus.send(CH.create, createPayload({ trackerId: "active1", title: "Auth" }));
		bus.send(CH.update, {
			requestId: "req-2",
			trackerId: "active1",
			trackerToken: "tok-1",
			owner: OWNER,
			chunkId: "a",
			state: "done",
		});

		bus.send(CH.create, createPayload({ trackerId: "done1", requestId: "req-3", title: "Schema", chunks: [{ id: "x" }, { id: "y" }] }));
		bus.send(CH.update, {
			requestId: "req-4",
			trackerId: "done1",
			trackerToken: "tok-1",
			owner: OWNER,
			chunkId: "x",
			state: "done",
		});
		bus.send(CH.update, {
			requestId: "req-5",
			trackerId: "done1",
			trackerToken: "tok-1",
			owner: OWNER,
			chunkId: "y",
			state: "done",
		});
		bus.send(CH.finish, {
			requestId: "req-6",
			trackerId: "done1",
			trackerToken: "tok-1",
			owner: OWNER,
			outcome: "completed",
		});

		bus.send(CH.create, createPayload({ trackerId: "fail1", requestId: "req-7", title: "Deploy" }));
		bus.send(CH.update, {
			requestId: "req-8",
			trackerId: "fail1",
			trackerToken: "tok-1",
			owner: OWNER,
			chunkId: "a",
			state: "done",
		});
		bus.send(CH.update, {
			requestId: "req-9",
			trackerId: "fail1",
			trackerToken: "tok-1",
			owner: OWNER,
			chunkId: "b",
			state: "failed",
		});
		bus.send(CH.finish, {
			requestId: "req-10",
			trackerId: "fail1",
			trackerToken: "tok-1",
			owner: OWNER,
			outcome: "failed",
		});

		const messages = await runCommand(commands, "px:progress");
		const message = messages[0] ?? "";

		expect(message).toContain("active trackers: 1");
		expect(message).toContain("- Auth [active] — 1/3 done");
		expect(message).toContain("recently finished: 2");
		expect(message).toContain("- Schema [completed] — 2/2 done");
		expect(message).toContain("- Deploy [failed] — 1/3 done, 1 failed");
	});

	test("/px:progress requires owner/trackerId when the id is ambiguous", async () => {
		const { bus, lifecycle, commands } = setup();
		await startSession(lifecycle);
		bus.send(CH.create, createPayload({ owner: "alpha", trackerToken: "ta" }));
		bus.send(CH.create, createPayload({ owner: "beta", trackerToken: "tb", requestId: "req-2" }));

		const ambiguous = await runCommand(commands, "px:progress", "t1");
		expect(ambiguous[0]).toContain("multiple owners");

		const detailed = await runCommand(commands, "px:progress", "alpha/t1");
		expect(detailed[0]).toContain("Authentication [active] — 0/3 done");
	});

	test("/px:progress reports a missing tracker without dumping state", async () => {
		const { bus, lifecycle, commands } = setup();
		await startSession(lifecycle);
		bus.send(CH.create, createPayload());

		const messages = await runCommand(commands, "px:progress", "missing");
		expect(messages[0]).toBe("progress tracker not found: missing");
	});
});
