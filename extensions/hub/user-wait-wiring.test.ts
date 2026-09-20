/**
 * Integration tests for hub's user-wait event wiring.
 *
 * The real hub extension runs against an in-memory event bus, so these tests
 * cover what the pure registry suite cannot: acknowledgements, the aggregate
 * `changed` observer contract, the Herdr zero/non-zero compatibility adapter,
 * `/px:hub` rendering, and session-shutdown cleanup.
 *
 * User waits are explicit declarations. A pending `hub:ask` must never be
 * reported as a wait (see the "not inferred" test).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HERDR_BLOCKED_EVENT, HUB_USER_WAIT_CHANNELS } from "./contract.ts";
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
type HubCommand = { handler: (args: unknown, ctx: unknown) => unknown };

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

const WAIT = HUB_USER_WAIT_CHANNELS;
const HERDR = HERDR_BLOCKED_EVENT;

function eventsNamed(emitted: Emitted[], event: string): Emitted[] {
	return emitted.filter((entry) => entry.event === event);
}

// Every test input goes through `bus.send` so `bus.emitted` holds hub output only.

async function runHubCommand(commands: Map<string, HubCommand>): Promise<string[]> {
	const messages: string[] = [];
	const command = commands.get("px:hub");
	await command?.handler({}, { hasUI: true, ui: { notify: (message: string) => messages.push(message) } });
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

describe("hub user-wait event wiring", () => {
	test("accepted set emits ack, changed, and one Herdr enter", () => {
		const { bus } = setup();

		bus.send(WAIT.set, { id: "w1", owner: "safe-mode", label: "safe-mode approval: bash", kind: "approval" });

		expect(bus.emitted).toEqual([
			{ event: WAIT.ack, payload: { id: "w1", owner: "safe-mode", operation: "set" } },
			{
				event: WAIT.changed,
				payload: {
					active: true,
					count: 1,
					waits: [{ id: "w1", owner: "safe-mode", label: "safe-mode approval: bash", kind: "approval" }],
				},
			},
			{ event: HERDR, payload: { active: true, label: "safe-mode approval: bash" } },
		]);
	});

	test("duplicate set is acknowledged without another changed or Herdr enter", () => {
		const { bus } = setup();
		const wait = { id: "w1", owner: "safe-mode", label: "approval" };

		bus.send(WAIT.set, wait);
		bus.send(WAIT.set, wait);

		expect(eventsNamed(bus.emitted, WAIT.ack)).toHaveLength(2);
		expect(eventsNamed(bus.emitted, WAIT.changed)).toHaveLength(1);
		expect(eventsNamed(bus.emitted, HERDR)).toHaveLength(1);
	});

	test("metadata update emits changed but keeps the single Herdr enter", () => {
		const { bus } = setup();

		bus.send(WAIT.set, { id: "w1", owner: "safe-mode", label: "first" });
		bus.send(WAIT.set, { id: "w1", owner: "safe-mode", label: "second" });

		const changed = eventsNamed(bus.emitted, WAIT.changed);
		expect(changed).toHaveLength(2);
		expect((changed[1]?.payload as { waits: Array<{ label?: string }> }).waits[0]?.label).toBe("second");
		expect(eventsNamed(bus.emitted, HERDR)).toEqual([
			{ event: HERDR, payload: { active: true, label: "first" } },
		]);
	});

	test("final clear emits ack, an empty changed, and one Herdr exit", () => {
		const { bus } = setup();

		bus.send(WAIT.set, { id: "w1", owner: "safe-mode", label: "approval" });
		bus.send(WAIT.clear, { id: "w1", owner: "safe-mode" });

		expect(eventsNamed(bus.emitted, WAIT.ack).at(-1)).toEqual({
			event: WAIT.ack,
			payload: { id: "w1", owner: "safe-mode", operation: "clear" },
		});
		expect(eventsNamed(bus.emitted, WAIT.changed).at(-1)?.payload).toEqual({
			active: false,
			count: 0,
			waits: [],
		});
		expect(eventsNamed(bus.emitted, HERDR)).toEqual([
			{ event: HERDR, payload: { active: true, label: "approval" } },
			{ event: HERDR, payload: { active: false } },
		]);
	});

	test("wrong-owner clear is acknowledged but changes nothing", () => {
		const { bus } = setup();

		bus.send(WAIT.set, { id: "w1", owner: "a", label: "keep" });
		const before = bus.emitted.length;
		bus.send(WAIT.clear, { id: "w1", owner: "b" });

		expect(bus.emitted.slice(before)).toEqual([
			{ event: WAIT.ack, payload: { id: "w1", owner: "b", operation: "clear" } },
		]);
	});

	test("malformed set and clear are ignored and never acknowledged", () => {
		const { bus } = setup();

		bus.send(WAIT.set, { id: "", owner: "safe-mode" });
		bus.send(WAIT.set, { id: "w1" });
		bus.send(WAIT.set, { id: "w1", owner: "safe-mode", kind: "bogus" });
		bus.send(WAIT.clear, undefined);
		bus.send(WAIT.clear, { owner: "safe-mode" });

		expect(bus.emitted).toEqual([]);
	});

	test("concurrent waits produce one Herdr enter and one final exit", () => {
		const { bus } = setup();

		bus.send(WAIT.set, { id: "w1", owner: "safe-mode", label: "first" });
		bus.send(WAIT.set, { id: "w2", owner: "safe-mode", label: "second" });
		bus.send(WAIT.clear, { id: "w1", owner: "safe-mode" });
		bus.send(WAIT.clear, { id: "w2", owner: "safe-mode" });

		expect(eventsNamed(bus.emitted, HERDR)).toEqual([
			{ event: HERDR, payload: { active: true, label: "first" } },
			{ event: HERDR, payload: { active: false } },
		]);
	});

	test("changed exposes the sorted aggregate snapshot", () => {
		const { bus } = setup();

		bus.send(WAIT.set, { id: "b", owner: "z" });
		bus.send(WAIT.set, { id: "a", owner: "a" });

		expect(eventsNamed(bus.emitted, WAIT.changed).at(-1)?.payload).toEqual({
			active: true,
			count: 2,
			waits: [
				{ id: "a", owner: "a" },
				{ id: "b", owner: "z" },
			],
		});
	});

	test("ack is delivered synchronously so a client can detect support", () => {
		const { bus } = setup();
		let acked: unknown;
		const off = bus.on(WAIT.ack, (payload) => {
			acked = payload;
		});

		bus.send(WAIT.set, { id: "w1", owner: "safe-mode" });
		off();

		expect(acked).toEqual({ id: "w1", owner: "safe-mode", operation: "set" });
	});

	test("a pending hub:ask is not reported as a user wait", () => {
		const { bus } = setup();

		bus.send("hub:ask", { id: "r1", from: "subagent", cap: [{ what: "perm:agent", data: {} }] });

		expect(eventsNamed(bus.emitted, WAIT.changed)).toEqual([]);
		expect(eventsNamed(bus.emitted, HERDR)).toEqual([]);
		expect(eventsNamed(bus.emitted, "hub:answer")).toHaveLength(1);
	});

	test("session shutdown clears waits and releases Herdr", async () => {
		const { bus, lifecycle } = setup();

		bus.send(WAIT.set, { id: "w1", owner: "safe-mode", label: "approval" });
		const before = bus.emitted.length;

		await lifecycle.get("session_shutdown")?.({}, {});

		expect(bus.emitted.slice(before)).toEqual([
			{ event: WAIT.changed, payload: { active: false, count: 0, waits: [] } },
			{ event: HERDR, payload: { active: false } },
		]);
	});

	test("session shutdown with no active waits emits nothing", async () => {
		const { bus, lifecycle } = setup();

		await lifecycle.get("session_shutdown")?.({}, {});

		expect(bus.emitted).toEqual([]);
	});

	test("/px:hub shows a concise user-wait section", async () => {
		const { bus, commands } = setup();
		bus.send(WAIT.set, {
			id: "abcdefghijklmnop",
			owner: "safe-mode",
			label: "safe-mode approval: bash",
			kind: "approval",
		});

		const messages = await runHubCommand(commands);

		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("active user waits: 1");
		expect(messages[0]).toContain("- safe-mode/abcdefgh: safe-mode approval: bash");
		expect(messages[0]).not.toContain("abcdefghijklmnop");
	});

	test("/px:hub reports zero active waits and falls back when no label is set", async () => {
		const { bus, commands } = setup();
		bus.send(WAIT.set, { id: "w1", owner: "other" });

		const withWait = await runHubCommand(commands);
		expect(withWait[0]).toContain("active user waits: 1");
		expect(withWait[0]).toContain("- other/w1: (no label)");

		bus.send(WAIT.clear, { id: "w1", owner: "other" });
		const afterClear = await runHubCommand(commands);
		expect(afterClear[0]).toContain("active user waits: 0");
	});
});
