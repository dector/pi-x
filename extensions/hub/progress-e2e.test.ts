/**
 * Stage 7 end-to-end smoke substitute for the manual TUI smoke test.
 *
 * One in-process fake bus and one hub instance drive all three layers:
 *
 * 1. the hub extension's progress event wiring owns the registry;
 * 2. the subagent child relay (`applyProgressRelay`) delivers a mutation;
 * 3. the neo-bar `ProgressObserver`/`formatProgressRow` renders the row.
 *
 * This is NOT a replacement for the manual TUI smoke test in
 * `idea-progress.md` section 12, which still needs a real Pi TUI (`./pitest`).
 * It is the closest headless check that a child update changes the parent
 * snapshot and the parent footer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HUB_PROGRESS_CHANNELS,
	type ProgressCreatePayload,
	type ProgressSnapshot,
} from "./contract.ts";
import hubExtension from "./index.ts";
import {
	applyProgressRelay,
	type ProgressRelayChannel,
} from "../subagent/progress-relay.ts";
import { formatProgressRow, ProgressObserver } from "../neo-bar/progress.ts";

// ---------------------------------------------------------------------------
// In-process event bus (same pattern as `progress-wiring.test.ts`)
// ---------------------------------------------------------------------------

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
	// Consumed by the outermost emit only, so nested hub emits are recorded
	// while the single test input event is not.
	let suppressRecord = false;
	return {
		emitted,
		emit(event, payload) {
			if (suppressRecord) suppressRecord = false;
			else emitted.push({ event, payload });
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
		registerTool() {},
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

/** Drive one mutation through the real subagent relay parser. */
function relay(bus: Bus, channel: ProgressRelayChannel, payload: Record<string, unknown>): boolean {
	const envelope = JSON.stringify({ version: 1, channel, payload });
	return applyProgressRelay(
		envelope,
		(relayedChannel, relayedPayload) => bus.send(relayedChannel, relayedPayload),
		() => {},
	);
}

const CH = HUB_PROGRESS_CHANNELS;

function createPayload(): ProgressCreatePayload {
	return {
		requestId: "req-create",
		trackerId: "t1",
		trackerToken: "tok-1",
		owner: "progress-tool",
		title: "Authentication",
		unit: "Stage",
		chunks: [
			{ id: "a", label: "Database schema" },
			{ id: "b", label: "API" },
			{ id: "c", label: "UI" },
		],
	};
}

async function runCommand(commands: Map<string, HubCommand>, name: string, args = ""): Promise<string[]> {
	const messages: string[] = [];
	await commands.get(name)?.handler(args, {
		hasUI: true,
		ui: { notify: (message: string) => messages.push(message) },
	});
	return messages;
}

// Keep the Herdr tab mirror inert so this test never opens a socket.
let savedHerdrTab: string | undefined;

beforeEach(() => {
	savedHerdrTab = process.env.PI_HUB_HERDR_TAB;
	process.env.PI_HUB_HERDR_TAB = "0";
});

afterEach(() => {
	if (savedHerdrTab === undefined) delete process.env.PI_HUB_HERDR_TAB;
	else process.env.PI_HUB_HERDR_TAB = savedHerdrTab;
});

describe("hub progress end-to-end smoke", () => {
	test("child relay updates the parent hub snapshot and neo-bar row", async () => {
		const { bus, lifecycle, commands } = setup();
		await lifecycle.get("session_start")?.({}, {});

		// 1. Root creates a three-chunk tracker over the hub protocol.
		bus.send(CH.create, createPayload());

		// 2. Neo-bar observer attaches to live `changed` events before the
		//    child reports. It also records every snapshot for the pure formatter.
		const changedSnapshots: ProgressSnapshot[] = [];
		const offChanged = bus.on(CH.changed, (payload) => {
			changedSnapshots.push(payload as ProgressSnapshot);
		});
		const rows: Array<string | undefined> = [];
		const observer = new ProgressObserver({
			events: bus,
			onChange: (row) => rows.push(row),
		});
		observer.activate();

		// 3. First child relay: chunk a active/phase reviewing. This is
		//    `applyProgressRelay` -> parent bus -> hub registry -> `changed`.
		expect(
			relay(bus, "hub:progress:update", {
				requestId: "relay-1",
				trackerId: "t1",
				trackerToken: "tok-1",
				chunkId: "a",
				state: "active",
				phase: "reviewing",
			}),
		).toBe(true);

		// The hub snapshot changed and the focused row renders.
		expect(changedSnapshots.at(-1)?.trackers[0]?.chunks[0]).toEqual({
			index: 1,
			state: "active",
			label: "Database schema",
			phase: "reviewing",
		});
		expect(observer.content).toBe("Authentication · Stage 1/3: Database schema · reviewing");
		expect(formatProgressRow(changedSnapshots.at(-1))).toBe(
			"Authentication · Stage 1/3: Database schema · reviewing",
		);

		// 4. Parallel work: a done, b and c active -> aggregate row.
		relay(bus, "hub:progress:update", {
			requestId: "relay-2",
			trackerId: "t1",
			trackerToken: "tok-1",
			chunkId: "a",
			state: "done",
		});
		relay(bus, "hub:progress:update", {
			requestId: "relay-3",
			trackerId: "t1",
			trackerToken: "tok-1",
			chunkId: "b",
			state: "active",
		});
		relay(bus, "hub:progress:update", {
			requestId: "relay-4",
			trackerId: "t1",
			trackerToken: "tok-1",
			chunkId: "c",
			state: "active",
		});

		expect(observer.content).toBe("Authentication · 1/3 done · 2 active");
		expect(formatProgressRow(changedSnapshots.at(-1))).toBe("Authentication · 1/3 done · 2 active");

		// 5. Settle every chunk and finish the tracker: the active row disappears.
		relay(bus, "hub:progress:update", {
			requestId: "relay-5",
			trackerId: "t1",
			trackerToken: "tok-1",
			chunkId: "b",
			state: "done",
		});
		relay(bus, "hub:progress:update", {
			requestId: "relay-6",
			trackerId: "t1",
			trackerToken: "tok-1",
			chunkId: "c",
			state: "done",
		});
		relay(bus, "hub:progress:finish", {
			requestId: "relay-7",
			trackerId: "t1",
			trackerToken: "tok-1",
			outcome: "completed",
		});

		expect(observer.current).toBeUndefined();
		expect(observer.content).toBeUndefined();
		expect(rows.at(-1)).toBeUndefined();

		observer.dispose();
		offChanged();

		// 6. The finished tracker stays available to `/px:progress` until clear.
		const listed = await runCommand(commands, "px:progress", "t1");
		expect(listed[0]).toContain("Authentication [completed] — 3/3 done");

		bus.send(CH.remove, {
			requestId: "req-remove",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: "progress-tool",
		});

		const gone = await runCommand(commands, "px:progress", "t1");
		expect(gone[0]).toBe("progress: no trackers");
	});

	test("an empty unit still renders the neo-bar row with the default noun", async () => {
		const { bus, lifecycle } = setup();
		await lifecycle.get("session_start")?.({}, {});

		const observer = new ProgressObserver({
			events: bus,
			onChange: () => {},
		});
		observer.activate();

		// The hub treats an empty display noun as absent and stores the default.
		// Before the fix it published `unit: ""`, which the strict neo-bar
		// snapshot parser rejected wholesale, freezing the row.
		bus.send(CH.create, { ...createPayload(), unit: "" });
		relay(bus, "hub:progress:update", {
			requestId: "relay-empty-unit",
			trackerId: "t1",
			trackerToken: "tok-1",
			chunkId: "a",
			state: "active",
			phase: "reviewing",
		});

		expect(observer.content).toBe("Authentication · Item 1/3: Database schema · reviewing");
		observer.dispose();
	});
});
