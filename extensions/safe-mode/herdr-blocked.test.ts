import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hubExtension from "../hub/index.ts";
import safeModeExtension from "./index.ts";
import { HERDR_BLOCKED_EVENT, withHerdrBlocked } from "./herdr-blocked.ts";

type Emitted = { event: string; payload: unknown };

function createEmitter() {
	const events: Emitted[] = [];
	const emit = (event: string, payload: unknown): void => {
		events.push({ event, payload });
	};
	return { events, emit };
}

function activeStates(events: Emitted[]): boolean[] {
	return events.map(({ payload }) => (payload as { active: boolean }).active);
}

// Every enter must be matched by exactly one clear that never underflows. A
// future regression that drops a clear, emits a duplicate clear, or reorders
// the pair will fail here.
function expectBalanced(events: Emitted[]): void {
	const states = activeStates(events);
	let depth = 0;
	for (const active of states) {
		depth += active ? 1 : -1;
		expect(depth).toBeGreaterThanOrEqual(0);
	}
	expect(depth).toBe(0);
	expect(states.filter((active) => active)).toHaveLength(states.filter((active) => !active).length);
}

// A balanced sequence can still briefly drop to zero between two adjacent
// waits (the steer-transition regression). This asserts depth stays > 0 from
// the first enter until the final clear.
function expectNoTransientUnblocked(payloads: Array<{ active: boolean }>): void {
	const states = payloads.map(({ active }) => active);
	expect(states[0]).toBe(true);
	let depth = 0;
	for (let index = 0; index < states.length; index += 1) {
		depth += states[index] ? 1 : -1;
		if (index < states.length - 1) expect(depth).toBeGreaterThan(0);
	}
	expect(depth).toBe(0);
}

describe("withHerdrBlocked", () => {
	test("successful action: emits active then clear and returns the result", async () => {
		const { events, emit } = createEmitter();

		const result = await withHerdrBlocked(emit, "safe-mode approval: bash", async () => "approved");

		expect(result).toBe("approved");
		expect(events).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "safe-mode approval: bash" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
		]);
		expectBalanced(events);
	});

	test("thrown action: clears blocked and rethrows the original error", async () => {
		const { events, emit } = createEmitter();
		const error = new Error("approval UI failed");

		await expect(
			withHerdrBlocked(emit, "safe-mode approval: perm:agent", async () => {
				throw error;
			}),
		).rejects.toBe(error);

		expect(events).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "safe-mode approval: perm:agent" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
		]);
		expectBalanced(events);
	});

	test("pending action: enter is emitted immediately and clear only after it settles", async () => {
		const { events, emit } = createEmitter();
		let settle!: (value: string) => void;
		const pending = new Promise<string>((resolve) => {
			settle = resolve;
		});

		const wrapped = withHerdrBlocked(emit, "safe-mode steering", () => pending);

		// The enter event is synchronous, before the user has answered.
		expect(events).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "safe-mode steering" } },
		]);

		settle("proceed safely");
		await expect(wrapped).resolves.toBe("proceed safely");

		expect(events).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "safe-mode steering" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
		]);
		expectBalanced(events);
	});

	test("exact contract: locks herdr:blocked and never emits a px: event", async () => {
		const { events, emit } = createEmitter();

		await withHerdrBlocked(emit, "safe-mode approval: http", async () => undefined);

		expect(HERDR_BLOCKED_EVENT).toBe("herdr:blocked");
		expect(events.length).toBeGreaterThan(0);
		for (const { event } of events) {
			expect(event).toBe("herdr:blocked");
			expect(event).not.toBe("px:herdr:blocked");
		}
		expect(events.some(({ event }) => event.startsWith("px:"))).toBe(false);
	});

	test("nested wrappers: one clear per enter, innermost first", async () => {
		const { events, emit } = createEmitter();

		const result = await withHerdrBlocked(emit, "outer", async () => {
			const inner = await withHerdrBlocked(emit, "inner", async () => "inner-result");
			return `outer-${inner}`;
		});

		expect(result).toBe("outer-inner-result");
		expect(events).toEqual([
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "outer" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: true, label: "inner" } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
			{ event: HERDR_BLOCKED_EVENT, payload: { active: false } },
		]);
		expectBalanced(events);
	});

	test("nested wrappers: a failing inner action still clears both intervals", async () => {
		const { events, emit } = createEmitter();
		const error = new Error("inner failed");

		await expect(
			withHerdrBlocked(emit, "outer", async () => {
				await withHerdrBlocked(emit, "inner", async () => {
					throw error;
				});
			}),
		).rejects.toBe(error);

		expect(activeStates(events)).toEqual([true, true, false, false]);
		expectBalanced(events);
	});

	test("concurrent wrappers: balanced enter/clear pairs even when one fails", async () => {
		const { events, emit } = createEmitter();
		const error = new Error("concurrent failure");

		const results = await Promise.all([
			withHerdrBlocked(emit, "slow", async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return "slow-ok";
			}),
			withHerdrBlocked(emit, "failing", async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				throw error;
			}).catch((caught: unknown) => {
				expect(caught).toBe(error);
				return "caught";
			}),
			withHerdrBlocked(emit, "fast", async () => "fast-ok"),
		]);

		expect(results).toEqual(["slow-ok", "caught", "fast-ok"]);
		expectBalanced(events);

		const enters = events.filter(({ payload }) => (payload as { active: boolean }).active);
		const clears = events.filter(({ payload }) => !(payload as { active: boolean }).active);
		expect(enters).toHaveLength(3);
		expect(clears).toHaveLength(3);
	});
});

// Minimal event-bus harness. The real hub and safe-mode extensions run
// against a shared in-memory bus. The only Pi runtime we fake is the approval
// UI (`ctx.ui.select`/`onTerminalInput`); no session lifecycle or filesystem
// setup is reproduced.
type BusHandler = (data: unknown) => void;

interface Bus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: BusHandler): () => void;
}

function createBus(): Bus {
	const handlers = new Map<string, Set<BusHandler>>();
	return {
		emit(channel, data) {
			const set = handlers.get(channel);
			if (!set) return;
			for (const handler of [...set]) handler(data);
		},
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set<BusHandler>();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
	};
}

type PiHandler = (event: unknown, ctx: unknown) => unknown;

function createFakePi(bus: Bus) {
	const handlers = new Map<string, PiHandler[]>();
	const pi = {
		events: bus,
		on(event: string, handler: PiHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerFlag() {},
		registerCommand() {},
		registerShortcut() {},
		appendEntry() {},
		getFlag() {
			return undefined;
		},
		sendUserMessage() {},
	};
	return { pi, handlers };
}

function createUiContext(onSelect: () => Promise<string>) {
	return {
		hasUI: true,
		cwd: "/tmp",
		sessionManager: { getBranch: () => [] },
		ui: {
			onTerminalInput: () => () => {},
			select: () => onSelect(),
			notify() {},
			input: async () => undefined,
		},
	};
}

interface HubAnswer {
	id: string;
	results: Array<{ what: string; action: string; reason?: string }>;
}

async function openAgentApproval() {
	const bus = createBus();
	const { pi } = createFakePi(bus);
	hubExtension(pi as unknown as ExtensionAPI);
	safeModeExtension(pi as unknown as ExtensionAPI);

	const blocked: Array<{ active: boolean; label?: string }> = [];
	bus.on(HERDR_BLOCKED_EVENT, (payload) => {
		blocked.push(payload as { active: boolean; label?: string });
	});

	// Register safe-mode as the `perm:agent` provider directly instead of
	// running the session lifecycle, which would touch the real filesystem.
	bus.emit("hub:register", { id: "safe-mode", caps: { provide: ["perm:shell", "perm:io", "perm:agent"] } });

	let resolveSelect!: (value: string) => void;
	let uiOpened!: () => void;
	const opened = new Promise<void>((resolve) => {
		uiOpened = resolve;
	});
	const ctx = createUiContext(() => {
		uiOpened();
		return new Promise<string>((resolve) => {
			resolveSelect = resolve;
		});
	});

	const answer = new Promise<HubAnswer>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("hub answer timeout")), 1000);
		const off = bus.on("hub:answer", (payload) => {
			const parsed = payload as { id?: string; results?: HubAnswer["results"] };
			if (parsed.id !== "agent-1" || !Array.isArray(parsed.results)) return;
			clearTimeout(timer);
			off();
			resolve({ id: parsed.id, results: parsed.results });
		});
	});

	bus.emit("hub:ask", {
		id: "agent-1",
		from: "subagent",
		cap: [{ what: "perm:agent", data: { agents: "proj", source: "test" } }],
		ctx,
	});

	await opened;
	return { blocked, answer, decide: (value: string) => resolveSelect(value) };
}

describe("hub-routed perm:agent blocked state", () => {
	test("stays blocked while the approval UI is open and clears on approve", async () => {
		const { blocked, answer, decide } = await openAgentApproval();

		expect(blocked).toEqual([{ active: true, label: "safe-mode approval: perm:agent" }]);

		decide("[Y]es");
		const result = await answer;

		expect(result.results).toMatchObject([{ what: "perm:agent", action: "allow" }]);
		expect(blocked).toEqual([
			{ active: true, label: "safe-mode approval: perm:agent" },
			{ active: false },
		]);
	});

	test("clears blocked state when the approval is denied", async () => {
		const { blocked, answer, decide } = await openAgentApproval();

		expect(blocked).toEqual([{ active: true, label: "safe-mode approval: perm:agent" }]);

		decide("[N]o");
		const result = await answer;

		expect(result.results).toMatchObject([{ what: "perm:agent", action: "block" }]);
		expect(blocked).toEqual([
			{ active: true, label: "safe-mode approval: perm:agent" },
			{ active: false },
		]);
	});

	test("non-interactive request (ctx.hasUI=false) emits no herdr:blocked event", async () => {
		const bus = createBus();
		const { pi } = createFakePi(bus);
		hubExtension(pi as unknown as ExtensionAPI);
		safeModeExtension(pi as unknown as ExtensionAPI);

		const blocked: unknown[] = [];
		bus.on(HERDR_BLOCKED_EVENT, (payload) => blocked.push(payload));

		bus.emit("hub:register", { id: "safe-mode", caps: { provide: ["perm:agent"] } });

		const answer = new Promise<HubAnswer>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("hub answer timeout")), 1000);
			const off = bus.on("hub:answer", (payload) => {
				const parsed = payload as { id?: string; results?: HubAnswer["results"] };
				if (parsed.id !== "agent-no-ui" || !Array.isArray(parsed.results)) return;
				clearTimeout(timer);
				off();
				resolve({ id: parsed.id, results: parsed.results });
			});
		});

		bus.emit("hub:ask", {
			id: "agent-no-ui",
			from: "subagent",
			cap: [{ what: "perm:agent", data: { agents: "proj", source: "test" } }],
			ctx: { hasUI: false, cwd: "/tmp", sessionManager: { getBranch: () => [] }, ui: {} },
		});

		const result = await answer;
		expect(result.results).toMatchObject([{ what: "perm:agent", action: "block" }]);
		expect(blocked).toEqual([]);
	});
});

describe("safe-mode steering blocked state", () => {
	test("stays blocked across the picker -> steering transition", async () => {
		const bus = createBus();
		const { pi, handlers } = createFakePi(bus);
		hubExtension(pi as unknown as ExtensionAPI);
		safeModeExtension(pi as unknown as ExtensionAPI);

		const blocked: Array<{ active: boolean; label?: string }> = [];
		bus.on(HERDR_BLOCKED_EVENT, (payload) => {
			blocked.push(payload as { active: boolean; label?: string });
		});

		let pickerOpened = false;
		let steeringOpened = false;
		const theme = {
			fg: (_token: string, text: string) => text,
			bg: (_token: string, text: string) => text,
			bold: (text: string) => text,
		};
		const ctx = {
			hasUI: true,
			cwd: "/tmp",
			sessionManager: { getBranch: () => [] },
			ui: {
				theme,
				onTerminalInput: () => () => {},
				select: async () => {
					pickerOpened = true;
					return "[Esc] to steer";
				},
				notify() {},
				input: async () => {
					steeringOpened = true;
					return "use a safer command";
				},
			},
		};

		const toolCallHandlers = handlers.get("tool_call") ?? [];
		expect(toolCallHandlers).toHaveLength(1);
		const result = await toolCallHandlers[0]!(
			{ toolName: "bash", toolCallId: "tc-steer", input: { command: "rm -rf ./build" } },
			ctx,
		);

		expect(pickerOpened).toBe(true);
		expect(steeringOpened).toBe(true);
		expect(result).toMatchObject({ block: true });
		expect(blocked).toEqual([
			{ active: true, label: "safe-mode approval: bash" },
			{ active: true, label: "safe-mode steering" },
			{ active: false },
			{ active: false },
		]);
		expectNoTransientUnblocked(blocked);
	});
});
