/**
 * Stage 5 cross-extension integration tests.
 *
 * The real hub and safe-mode extensions run against one shared in-process
 * event bus. A test-only `hub:ask` stands in for subagent, which emits exactly
 * that payload for project-local agents. These tests assert the end-to-end
 * sequence the isolated suites cannot:
 *
 *   subagent -> hub:ask(perm:agent) -> safe-mode approval
 *            -> hub:user-wait:set -> hub aggregate -> herdr:blocked(true)
 *            -> user resolves  -> hub:user-wait:clear -> herdr:blocked(false)
 *            -> safe-mode hub:reply -> hub:answer
 *
 * Also covered: auto-allowed and headless requests declare no wait; denial and
 * cancellation clear; a thrown UI action clears; concurrent/nested waits
 * collapse to one Herdr enter and one final exit; and safe-mode with no hub
 * falls back to exactly one legacy Herdr enter/exit pair.
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HERDR_BLOCKED_EVENT, HUB_CHANNELS, HUB_USER_WAIT_CHANNELS } from "../hub/contract.ts";
import hubExtension from "../hub/index.ts";
import safeModeExtension from "./index.ts";
import { withUserWait } from "./user-wait.ts";

type Emitted = { event: string; payload: unknown };
type Handler = (payload: unknown) => unknown;

interface Bus {
	/** Every event emitted on the bus, in dispatch order. */
	emitted: Emitted[];
	/** Errors thrown/rejected by async event handlers, captured so no test leaks an unhandled rejection. */
	errors: unknown[];
	emit(event: string, payload: unknown): void;
	on(event: string, handler: Handler): () => void;
}

function createBus(): Bus {
	const handlers = new Map<string, Set<Handler>>();
	const emitted: Emitted[] = [];
	const errors: unknown[] = [];
	return {
		emitted,
		errors,
		emit(event, payload) {
			emitted.push({ event, payload });
			// Snapshot so a handler may unsubscribe during dispatch.
			for (const handler of [...(handlers.get(event) ?? [])]) {
				try {
					const result = handler(payload);
					if (result && typeof (result as Promise<unknown>).then === "function") {
						(result as Promise<unknown>).catch((error) => errors.push(error));
					}
				} catch (error) {
					errors.push(error);
				}
			}
		},
		on(event, handler) {
			const set = handlers.get(event) ?? new Set<Handler>();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
	};
}

type PiHandler = (event: unknown, ctx: unknown) => unknown;

function createFakePi(bus: Bus, flags: Record<string, unknown> = {}) {
	const lifecycle = new Map<string, PiHandler[]>();
	const pi = {
		events: bus,
		on(event: string, handler: PiHandler) {
			const list = lifecycle.get(event) ?? [];
			list.push(handler);
			lifecycle.set(event, list);
		},
		registerFlag() {},
		registerCommand() {},
		registerShortcut() {},
		appendEntry() {},
		getFlag(name: string) {
			return flags[name];
		},
		getCommands() {
			return [];
		},
		sendUserMessage() {},
	};
	return { pi, lifecycle };
}

interface SetupOptions {
	hub?: boolean;
	flags?: Record<string, unknown>;
}

function setup(options: SetupOptions = {}) {
	const bus = createBus();
	const { pi, lifecycle } = createFakePi(bus, options.flags);
	if (options.hub !== false) hubExtension(pi as unknown as ExtensionAPI);
	safeModeExtension(pi as unknown as ExtensionAPI);
	return { bus, lifecycle };
}

/** Run safe-mode's real session bootstrap, used only to select a non-default mode. */
async function startSession(lifecycle: Map<string, PiHandler[]>, ctx: unknown): Promise<void> {
	for (const handler of lifecycle.get("session_start") ?? []) await handler({}, ctx);
}

/**
 * Register safe-mode as the `perm:agent` provider directly, instead of running
 * the session lifecycle, which would read the real global defaults file.
 */
function registerSafeModeProvider(bus: Bus): void {
	bus.emit(HUB_CHANNELS.register, {
		id: "safe-mode",
		caps: { provide: ["perm:shell", "perm:io", "perm:agent"] },
	});
}

/** Emit the exact `hub:ask` payload subagent uses for project-local agents. */
function sendAgentAsk(bus: Bus, ctx: unknown, id: string): void {
	bus.emit(HUB_CHANNELS.ask, {
		id,
		from: "subagent",
		cap: [{ what: "perm:agent", data: { agents: "proj", source: "test" } }],
		ctx,
	});
}

interface HubAnswer {
	id: string;
	results: Array<{ what: string; action: string; reason?: string }>;
}

function waitForAnswer(bus: Bus, id: string): Promise<HubAnswer> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no hub:answer for ${id}`)), 3000);
		const off = bus.on(HUB_CHANNELS.answer, (payload) => {
			const parsed = payload as { id?: unknown; results?: unknown };
			if (parsed.id !== id || !Array.isArray(parsed.results)) return;
			clearTimeout(timer);
			off();
			resolve(parsed as HubAnswer);
		});
	});
}

function payloadsFor(bus: Bus, event: string): unknown[] {
	return bus.emitted.filter((entry) => entry.event === event).map((entry) => entry.payload);
}

function herdrStates(bus: Bus): Array<{ active: boolean; label?: string }> {
	return payloadsFor(bus, HERDR_BLOCKED_EVENT) as Array<{ active: boolean; label?: string }>;
}

interface WaitSnapshot {
	active: boolean;
	count: number;
	waits: Array<{ id: string; owner: string; label?: string; kind?: string }>;
}

function waitSnapshots(bus: Bus): WaitSnapshot[] {
	return payloadsFor(bus, HUB_USER_WAIT_CHANNELS.changed) as WaitSnapshot[];
}

const FLOW_CHANNELS = new Set<string>([
	HUB_CHANNELS.request,
	HUB_CHANNELS.reply,
	HUB_CHANNELS.answer,
	HUB_USER_WAIT_CHANNELS.set,
	HUB_USER_WAIT_CHANNELS.clear,
	HUB_USER_WAIT_CHANNELS.ack,
	HUB_USER_WAIT_CHANNELS.changed,
	HERDR_BLOCKED_EVENT,
]);

/** Channel names of the cross-extension flow, in dispatch order. */
function flow(bus: Bus): string[] {
	return bus.emitted.filter((entry) => FLOW_CHANNELS.has(entry.event)).map((entry) => entry.event);
}

interface Deferred<T> {
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

interface FakeUi {
	ctx: unknown;
	selectCalls: Array<{ title: string; options: string[] }>;
	inputCalls: Array<{ title: string; placeholder?: string }>;
	waitForSelect: () => Promise<void>;
	resolveSelect: (value: string | undefined) => void;
	resolveSelectAt: (index: number, value: string | undefined) => void;
	rejectSelect: (error: unknown) => void;
	waitForInput: () => Promise<void>;
	resolveInput: (value: string | undefined) => void;
}

/**
 * The only Pi runtime faked is the approval UI. Each `select`/`input` returns
 * a deferred so the test decides when and how the user answers.
 */
function createFakeUi(options: { hasUI?: boolean } = {}): FakeUi {
	const hasUI = options.hasUI ?? true;
	const selectCalls: FakeUi["selectCalls"] = [];
	const inputCalls: FakeUi["inputCalls"] = [];
	const selectDeferreds: Array<Deferred<string | undefined>> = [];
	const inputDeferreds: Array<Deferred<string | undefined>> = [];
	const selectWaiters: Array<() => void> = [];
	const inputWaiters: Array<() => void> = [];

	const select = (title: string, choices: string[]) => {
		selectCalls.push({ title, options: choices });
		for (const waiter of selectWaiters.splice(0)) waiter();
		return new Promise<string | undefined>((resolve, reject) => {
			selectDeferreds.push({ resolve, reject });
		});
	};

	const input = (title: string, placeholder?: string) => {
		inputCalls.push({ title, placeholder });
		for (const waiter of inputWaiters.splice(0)) waiter();
		return new Promise<string | undefined>((resolve, reject) => {
			inputDeferreds.push({ resolve, reject });
		});
	};

	const ctx = {
		hasUI,
		cwd: "/tmp",
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: {
				fg: (_token: string, text: string) => text,
				bg: (_token: string, text: string) => text,
				bold: (text: string) => text,
			},
			onTerminalInput: () => () => {},
			select,
			input,
			notify: () => {},
		},
	};

	return {
		ctx,
		selectCalls,
		inputCalls,
		async waitForSelect() {
			if (selectDeferreds.length > 0) return;
			await new Promise<void>((resolve) => selectWaiters.push(resolve));
		},
		resolveSelect(value) {
			selectDeferreds[0]?.resolve(value);
		},
		resolveSelectAt(index, value) {
			selectDeferreds[index]?.resolve(value);
		},
		rejectSelect(error) {
			selectDeferreds[0]?.reject(error);
		},
		async waitForInput() {
			if (inputDeferreds.length > 0) return;
			await new Promise<void>((resolve) => inputWaiters.push(resolve));
		},
		resolveInput(value) {
			inputDeferreds[0]?.resolve(value);
		},
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

const AGENT_LABEL = "safe-mode approval: perm:agent";

describe("subagent -> hub -> safe-mode approval flow", () => {
	test("perm:agent approval drives one ordered user-wait / Herdr / reply / answer flow", async () => {
		const { bus } = setup();
		registerSafeModeProvider(bus);
		const ui = createFakeUi();

		const answer = waitForAnswer(bus, "agent-1");
		sendAgentAsk(bus, ui.ctx, "agent-1");
		await ui.waitForSelect();

		// The wait is declared before the UI opens and hub aggregates it.
		expect(flow(bus)).toEqual([
			HUB_CHANNELS.request,
			HUB_USER_WAIT_CHANNELS.set,
			HUB_USER_WAIT_CHANNELS.ack,
			HUB_USER_WAIT_CHANNELS.changed,
			HERDR_BLOCKED_EVENT,
		]);
		expect(herdrStates(bus)).toEqual([{ active: true, label: AGENT_LABEL }]);
		expect(waitSnapshots(bus).at(-1)).toMatchObject({ active: true, count: 1 });
		expect(ui.selectCalls).toHaveLength(1);

		ui.resolveSelect("[Y]es");
		const result = await answer;

		expect(result.results).toMatchObject([{ what: "perm:agent", action: "allow" }]);
		expect(flow(bus)).toEqual([
			HUB_CHANNELS.request,
			HUB_USER_WAIT_CHANNELS.set,
			HUB_USER_WAIT_CHANNELS.ack,
			HUB_USER_WAIT_CHANNELS.changed,
			HERDR_BLOCKED_EVENT,
			HUB_USER_WAIT_CHANNELS.clear,
			HUB_USER_WAIT_CHANNELS.ack,
			HUB_USER_WAIT_CHANNELS.changed,
			HERDR_BLOCKED_EVENT,
			HUB_CHANNELS.reply,
			HUB_CHANNELS.answer,
		]);
		expect(herdrStates(bus)).toEqual([
			{ active: true, label: AGENT_LABEL },
			{ active: false },
		]);
		expect(waitSnapshots(bus).at(-1)).toEqual({ active: false, count: 0, waits: [] });
	});

	test("automatically allowed perm:agent in yolo emits no user wait or Herdr state", async () => {
		const { bus, lifecycle } = setup({ flags: { "safe-mode": "yolo" } });
		const ui = createFakeUi();
		await startSession(lifecycle, ui.ctx);

		const answer = waitForAnswer(bus, "agent-yolo");
		sendAgentAsk(bus, ui.ctx, "agent-yolo");
		const result = await answer;

		expect(result.results).toMatchObject([{ what: "perm:agent", action: "allow" }]);
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.set)).toEqual([]);
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.changed)).toEqual([]);
		expect(herdrStates(bus)).toEqual([]);
		expect(ui.selectCalls).toHaveLength(0);
	});

	test("headless perm:agent confirmation blocks without user-wait state", async () => {
		const { bus } = setup();
		registerSafeModeProvider(bus);
		const ui = createFakeUi({ hasUI: false });

		const answer = waitForAnswer(bus, "agent-headless");
		sendAgentAsk(bus, ui.ctx, "agent-headless");
		const result = await answer;

		expect(result.results).toMatchObject([{ what: "perm:agent", action: "block" }]);
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.set)).toEqual([]);
		expect(herdrStates(bus)).toEqual([]);
		expect(ui.selectCalls).toHaveLength(0);
	});
});

describe("approval outcomes always clear the wait", () => {
	test("denied dialog clears the user wait and Herdr block", async () => {
		const { bus } = setup();
		registerSafeModeProvider(bus);
		const ui = createFakeUi();

		const answer = waitForAnswer(bus, "agent-deny");
		sendAgentAsk(bus, ui.ctx, "agent-deny");
		await ui.waitForSelect();
		expect(herdrStates(bus)).toEqual([{ active: true, label: AGENT_LABEL }]);

		ui.resolveSelect("[N]o");
		const result = await answer;

		expect(result.results).toMatchObject([{ what: "perm:agent", action: "block" }]);
		expect(herdrStates(bus)).toEqual([
			{ active: true, label: AGENT_LABEL },
			{ active: false },
		]);
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.clear)).toHaveLength(1);
		expect(waitSnapshots(bus).at(-1)).toEqual({ active: false, count: 0, waits: [] });
	});

	test("cancelled dialog (undefined selection) clears the user wait", async () => {
		const { bus } = setup();
		registerSafeModeProvider(bus);
		const ui = createFakeUi();

		const answer = waitForAnswer(bus, "agent-cancel");
		sendAgentAsk(bus, ui.ctx, "agent-cancel");
		await ui.waitForSelect();

		ui.resolveSelect(undefined);
		const result = await answer;

		expect(result.results).toMatchObject([{ what: "perm:agent", action: "block" }]);
		expect(herdrStates(bus)).toEqual([
			{ active: true, label: AGENT_LABEL },
			{ active: false },
		]);
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.clear)).toHaveLength(1);
	});

	test("thrown UI action clears the user wait even though safe-mode cannot reply", async () => {
		const { bus } = setup();
		registerSafeModeProvider(bus);
		const ui = createFakeUi();

		const error = new Error("dialog failed");
		sendAgentAsk(bus, ui.ctx, "agent-throw");
		await ui.waitForSelect();
		expect(herdrStates(bus)).toEqual([{ active: true, label: AGENT_LABEL }]);

		ui.rejectSelect(error);
		await waitFor(() => bus.errors.length > 0);

		expect(bus.errors).toContain(error);
		expect(herdrStates(bus)).toEqual([
			{ active: true, label: AGENT_LABEL },
			{ active: false },
		]);
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.clear)).toHaveLength(1);
		expect(waitSnapshots(bus).at(-1)).toEqual({ active: false, count: 0, waits: [] });

		// The provider never replied; settle the hub pending request so no TTL
		// timer outlives the test.
		bus.emit(HUB_CHANNELS.reply, {
			id: "agent-throw",
			from: "safe-mode",
			results: [{ what: "perm:agent", action: "block" }],
		});
	});
});

describe("concurrent and nested waits aggregate to one Herdr interval", () => {
	test("two concurrent perm:agent requests enter once and exit only after both clear", async () => {
		const { bus } = setup();
		registerSafeModeProvider(bus);
		const ui = createFakeUi();

		const answerA = waitForAnswer(bus, "agent-a");
		const answerB = waitForAnswer(bus, "agent-b");
		sendAgentAsk(bus, ui.ctx, "agent-a");
		sendAgentAsk(bus, ui.ctx, "agent-b");
		await waitFor(() => ui.selectCalls.length === 2);

		// Both waits are active but Herdr crossed zero only once.
		expect(herdrStates(bus)).toEqual([{ active: true, label: AGENT_LABEL }]);
		expect(waitSnapshots(bus).at(-1)).toMatchObject({ active: true, count: 2 });

		ui.resolveSelectAt(0, "[Y]es");
		const resultA = await answerA;
		expect(resultA.results).toMatchObject([{ what: "perm:agent", action: "allow" }]);
		// One wait remains: still blocked, no second enter.
		expect(herdrStates(bus)).toEqual([{ active: true, label: AGENT_LABEL }]);
		expect(waitSnapshots(bus).at(-1)).toMatchObject({ active: true, count: 1 });

		ui.resolveSelectAt(1, "[N]o");
		const resultB = await answerB;
		expect(resultB.results).toMatchObject([{ what: "perm:agent", action: "block" }]);
		expect(herdrStates(bus)).toEqual([
			{ active: true, label: AGENT_LABEL },
			{ active: false },
		]);
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.clear)).toHaveLength(2);
	});

	test("nested waits keep the aggregate active until the final clear", async () => {
		const { bus } = setup();

		let releaseInner!: () => void;
		const outer = withUserWait(bus, { owner: "safe-mode", label: "outer", kind: "approval" }, () =>
			withUserWait(
				bus,
				{ owner: "safe-mode", label: "inner", kind: "input" },
				() => new Promise<void>((resolve) => (releaseInner = resolve)),
			),
		);

		// Both waits are declared synchronously; only the first crossed zero.
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.set)).toHaveLength(2);
		expect(herdrStates(bus)).toEqual([{ active: true, label: "outer" }]);
		expect(waitSnapshots(bus).at(-1)).toMatchObject({ active: true, count: 2 });

		releaseInner();
		await outer;

		expect(herdrStates(bus)).toEqual([
			{ active: true, label: "outer" },
			{ active: false },
		]);
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.clear)).toHaveLength(2);
		expect(waitSnapshots(bus).at(-1)).toEqual({ active: false, count: 0, waits: [] });
	});
});

describe("safe-mode without hub", () => {
	test("a tool approval uses exactly one legacy Herdr enter/exit pair", async () => {
		const { bus, lifecycle } = setup({ hub: false });
		const ui = createFakeUi();

		const toolCallHandlers = lifecycle.get("tool_call") ?? [];
		expect(toolCallHandlers).toHaveLength(1);
		const resultPromise = toolCallHandlers[0]!(
			{ toolName: "bash", toolCallId: "tc-no-hub", input: { command: "rm -rf ./build" } },
			ui.ctx,
		);

		// Without a hub the 300ms classification ask times out, then the built-in
		// policy confirms and safe-mode opens the dialog.
		await ui.waitForSelect();
		expect(herdrStates(bus)).toEqual([{ active: true, label: "safe-mode approval: bash" }]);
		// The declaration is still emitted, but no hub is attached to ack it, so
		// the helper never sees an acknowledgement and never clears through hub.
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.set)).toHaveLength(1);
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.ack)).toEqual([]);
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.changed)).toEqual([]);

		ui.resolveSelect("[Y]es");
		await resultPromise;

		expect(herdrStates(bus)).toEqual([
			{ active: true, label: "safe-mode approval: bash" },
			{ active: false },
		]);
		expect(payloadsFor(bus, HUB_USER_WAIT_CHANNELS.clear)).toEqual([]);
		expect(bus.errors).toEqual([]);
	});
});
