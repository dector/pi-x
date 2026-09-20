/**
 * Tests for safe-mode's user-wait client helper.
 *
 * Two modes are covered: an installed hub that synchronously acknowledges the
 * declaration, and no hub (absent or older than the protocol) where the helper
 * falls back to emitting `herdr:blocked` directly. A wait must never use both
 * clear paths, must clear on success and on thrown actions, and must preserve
 * results/errors.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HERDR_BLOCKED_EVENT as HUB_HERDR_BLOCKED_EVENT, HUB_USER_WAIT_CHANNELS } from "../hub/contract.ts";
import hubExtension from "../hub/index.ts";
import { HERDR_BLOCKED_EVENT } from "./herdr-blocked.ts";
import { USER_WAIT_CHANNELS, generateUserWaitId, withUserWait } from "./user-wait.ts";

type Emitted = { event: string; payload: unknown };
type Handler = (payload: unknown) => void;

interface Bus {
	emitted: Emitted[];
	emit(event: string, payload: unknown): void;
	on(event: string, handler: Handler): () => void;
}

function createBus(): Bus {
	const handlers = new Map<string, Set<Handler>>();
	const emitted: Emitted[] = [];
	return {
		emitted,
		emit(event, payload) {
			emitted.push({ event, payload });
			// Snapshot so a handler may unsubscribe during dispatch.
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

function eventsNamed(emitted: Emitted[], event: string): Emitted[] {
	return emitted.filter((entry) => entry.event === event);
}

interface FakeHub {
	sets: Array<{ id: string; owner: string; label?: string; kind?: string }>;
	clears: Array<{ id: string; owner: string }>;
}

/**
 * Install a minimal well-behaved hub: it acknowledges every `set` and `clear`
 * synchronously. Used to drive the helper's hub mode without loading the real
 * hub extension.
 */
function installFakeHub(bus: Bus, options: { ackOwner?: (owner: string) => string } = {}): FakeHub {
	const hub: FakeHub = { sets: [], clears: [] };
	bus.on(USER_WAIT_CHANNELS.set, (payload) => {
		const parsed = payload as { id: string; owner: string; label?: string; kind?: string };
		hub.sets.push(parsed);
		bus.emit(USER_WAIT_CHANNELS.ack, {
			id: parsed.id,
			owner: options.ackOwner?.(parsed.owner) ?? parsed.owner,
			operation: "set",
		});
	});
	bus.on(USER_WAIT_CHANNELS.clear, (payload) => {
		const parsed = payload as { id: string; owner: string };
		hub.clears.push(parsed);
		bus.emit(USER_WAIT_CHANNELS.ack, {
			id: parsed.id,
			owner: options.ackOwner?.(parsed.owner) ?? parsed.owner,
			operation: "clear",
		});
	});
	return hub;
}

type PiHandler = (event: unknown, ctx: unknown) => unknown;

function createFakePi(bus: Bus) {
	const pi = {
		events: bus,
		on(_event: string, _handler: PiHandler) {},
		registerCommand() {},
		registerFlag() {},
		registerShortcut() {},
		appendEntry() {},
		getFlag() {
			return undefined;
		},
		sendUserMessage() {},
	};
	return pi;
}

function setupRealHub(): Bus {
	const bus = createBus();
	hubExtension(createFakePi(bus) as unknown as ExtensionAPI);
	return bus;
}

// Keep the Herdr tab mirror inert in integration tests; only user-wait events
// are under test here.
let savedHerdrTab: string | undefined;

beforeEach(() => {
	savedHerdrTab = process.env.PI_HUB_HERDR_TAB;
	process.env.PI_HUB_HERDR_TAB = "0";
});

afterEach(() => {
	if (savedHerdrTab === undefined) delete process.env.PI_HUB_HERDR_TAB;
	else process.env.PI_HUB_HERDR_TAB = savedHerdrTab;
});

describe("protocol constants", () => {
	test("mirror the hub contract exactly", () => {
		expect(USER_WAIT_CHANNELS.set).toBe(HUB_USER_WAIT_CHANNELS.set);
		expect(USER_WAIT_CHANNELS.clear).toBe(HUB_USER_WAIT_CHANNELS.clear);
		expect(USER_WAIT_CHANNELS.ack).toBe(HUB_USER_WAIT_CHANNELS.ack);
		expect(HERDR_BLOCKED_EVENT).toBe(HUB_HERDR_BLOCKED_EVENT);
	});
});

describe("generateUserWaitId", () => {
	test("is unique across many calls", () => {
		const ids = new Set<string>();
		for (let index = 0; index < 500; index += 1) ids.add(generateUserWaitId());
		expect(ids.size).toBe(500);
	});
});

describe("withUserWait (hub mode)", () => {
	test("declares before the action, clears after, returns the result", async () => {
		const bus = createBus();
		const hub = installFakeHub(bus);

		let setsAtActionStart = 0;
		let clearsAtActionStart = 0;
		const result = await withUserWait(
			bus,
			{ owner: "safe-mode", label: "safe-mode approval: bash", kind: "approval" },
			async () => {
				setsAtActionStart = eventsNamed(bus.emitted, USER_WAIT_CHANNELS.set).length;
				clearsAtActionStart = eventsNamed(bus.emitted, USER_WAIT_CHANNELS.clear).length;
				return "approved";
			},
		);

		expect(result).toBe("approved");
		expect(setsAtActionStart).toBe(1);
		expect(clearsAtActionStart).toBe(0);
		expect(hub.sets).toHaveLength(1);
		expect(hub.clears).toHaveLength(1);
		expect(hub.sets[0]).toMatchObject({ owner: "safe-mode", label: "safe-mode approval: bash", kind: "approval" });
		// Same id on set and clear so the hub cannot clear the wrong wait.
		expect(hub.clears[0]).toEqual({ id: hub.sets[0]!.id, owner: "safe-mode" });
		// Hub mode only: the helper never touches the legacy path (hub's own
		// adapter owns herdr:blocked).
		expect(eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT)).toEqual([]);
	});

	test("clears and rethrows the original error", async () => {
		const bus = createBus();
		const hub = installFakeHub(bus);
		const error = new Error("approval UI failed");

		await expect(
			withUserWait(bus, { owner: "safe-mode", label: "safe-mode approval: perm:agent", kind: "approval" }, async () => {
				throw error;
			}),
		).rejects.toBe(error);

		expect(hub.sets).toHaveLength(1);
		expect(hub.clears).toHaveLength(1);
		expect(hub.clears[0]!.id).toBe(hub.sets[0]!.id);
		expect(eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT)).toEqual([]);
	});

	test("concurrent waits get distinct ids and each clears its own", async () => {
		const bus = createBus();
		const hub = installFakeHub(bus);

		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		const first = withUserWait(bus, { owner: "safe-mode", label: "outer" }, () => new Promise<void>((resolve) => (releaseFirst = resolve)));
		const second = withUserWait(bus, { owner: "safe-mode", label: "inner" }, () => new Promise<void>((resolve) => (releaseSecond = resolve)));

		expect(hub.sets).toHaveLength(2);
		expect(hub.sets[0]!.id).not.toBe(hub.sets[1]!.id);

		releaseFirst();
		await first;
		expect(hub.clears.map(({ id }) => id)).toEqual([hub.sets[0]!.id]);

		releaseSecond();
		await second;
		expect(hub.clears.map(({ id }) => id).sort()).toEqual([hub.sets[0]!.id, hub.sets[1]!.id].sort());
	});

	test("ignores an acknowledgement for a different owner and falls back to legacy", async () => {
		const bus = createBus();
		installFakeHub(bus, { ackOwner: () => "not-safe-mode" });

		const result = await withUserWait(bus, { owner: "safe-mode", label: "safe-mode approval: bash" }, async () => "ok");

		expect(result).toBe("ok");
		expect(eventsNamed(bus.emitted, USER_WAIT_CHANNELS.clear)).toEqual([]);
		expect(eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT)).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "safe-mode approval: bash" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
		]);
	});

	test("ignores a non-set acknowledgement and falls back to legacy", async () => {
		const bus = createBus();
		bus.on(USER_WAIT_CHANNELS.set, (payload) => {
			const parsed = payload as { id: string; owner: string };
			bus.emit(USER_WAIT_CHANNELS.ack, { id: parsed.id, owner: parsed.owner, operation: "clear" });
		});

		await withUserWait(bus, { owner: "safe-mode", label: "safe-mode steering", kind: "input" }, async () => undefined);

		expect(eventsNamed(bus.emitted, USER_WAIT_CHANNELS.clear)).toEqual([]);
		expect(eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT)).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "safe-mode steering" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
		]);
	});
});

describe("withUserWait (no-hub fallback)", () => {
	test("emits one legacy enter/exit pair and no hub clear", async () => {
		const bus = createBus();

		let activeAtActionStart = 0;
		const result = await withUserWait(
			bus,
			{ owner: "safe-mode", label: "safe-mode approval: bash", kind: "approval" },
			async () => {
				activeAtActionStart = eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT).length;
				return "approved";
			},
		);

		expect(result).toBe("approved");
		expect(activeAtActionStart).toBe(1);
		expect(eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT)).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "safe-mode approval: bash" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
		]);
		expect(eventsNamed(bus.emitted, USER_WAIT_CHANNELS.clear)).toEqual([]);
	});

	test("omits the label when none is given", async () => {
		const bus = createBus();
		await withUserWait(bus, { owner: "safe-mode", kind: "input" }, async () => undefined);

		expect(eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT)).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
		]);
	});

	test("clears and rethrows the original error", async () => {
		const bus = createBus();
		const error = new Error("steering input failed");

		await expect(
			withUserWait(bus, { owner: "safe-mode", label: "safe-mode steering", kind: "input" }, async () => {
				throw error;
			}),
		).rejects.toBe(error);

		expect(eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT)).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "safe-mode steering" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
		]);
		expect(eventsNamed(bus.emitted, USER_WAIT_CHANNELS.clear)).toEqual([]);
	});

	test("nested waits emit one enter per wait and clear both", async () => {
		const bus = createBus();

		await withUserWait(bus, { owner: "safe-mode", label: "outer", kind: "approval" }, async () => {
			await withUserWait(bus, { owner: "safe-mode", label: "inner", kind: "input" }, async () => undefined);
		});

		expect(eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT)).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "outer" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "inner" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
		]);
	});
});

describe("withUserWait against the real hub", () => {
	test("hub mode drives exactly one Herdr enter and one exit", async () => {
		const bus = setupRealHub();

		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		const first = withUserWait(bus, { owner: "safe-mode", label: "safe-mode approval: bash", kind: "approval" }, () =>
			new Promise<void>((resolve) => (releaseFirst = resolve)),
		);
		const second = withUserWait(bus, { owner: "safe-mode", label: "safe-mode steering", kind: "input" }, () =>
			new Promise<void>((resolve) => (releaseSecond = resolve)),
		);

		// Hub accepted both waits but the aggregate only crossed zero once.
		expect(eventsNamed(bus.emitted, HUB_USER_WAIT_CHANNELS.set)).toHaveLength(2);
		expect(eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT)).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "safe-mode approval: bash" } },
		]);

		releaseFirst();
		await first;
		expect(eventsNamed(bus.emitted, HUB_USER_WAIT_CHANNELS.clear)).toHaveLength(1);
		// Still one wait active: no exit yet.
		expect(eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT)).toHaveLength(1);

		releaseSecond();
		await second;
		expect(eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT)).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "safe-mode approval: bash" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
		]);
		// Every accepted operation acknowledged exactly once.
		expect(eventsNamed(bus.emitted, HUB_USER_WAIT_CHANNELS.ack)).toHaveLength(4);
	});

	test("clears hub state when the action throws", async () => {
		const bus = setupRealHub();
		const error = new Error("dialog cancelled");

		await expect(
			withUserWait(bus, { owner: "safe-mode", label: "safe-mode approval: bash", kind: "approval" }, async () => {
				throw error;
			}),
		).rejects.toBe(error);

		expect(eventsNamed(bus.emitted, HERDR_BLOCKED_EVENT)).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "safe-mode approval: bash" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
		]);
	});
});
