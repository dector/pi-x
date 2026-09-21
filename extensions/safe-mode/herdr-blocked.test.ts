import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hubExtension from "../hub/index.ts";
import safeModeExtension from "./index.ts";
import { HERDR_BLOCKED_EVENT } from "./herdr-blocked.ts";

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
	test("keeps a single hub aggregate block across the picker -> steering transition", async () => {
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
		// The outer approval and nested steering wait aggregate into one Herdr
		// block: one enter for the pair, one exit after both clear.
		expect(blocked).toEqual([
			{ active: true, label: "safe-mode approval: bash" },
			{ active: false },
		]);
		expectNoTransientUnblocked(blocked);
	});
});
