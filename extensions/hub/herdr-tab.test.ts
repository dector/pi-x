/**
 * Tests for the Herdr tab status mirror (hub).
 *
 * Three layers:
 *  - pure helpers: symbol/compose/strip mapping and env detection;
 *  - the state machine driven by a fake newline-delimited JSON Herdr server on
 *    a temp unix socket (seed, rename, coalescing, restore, reconnect);
 *  - index wiring: no socket activity when the environment is absent or the
 *    session is not a TUI.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HerdrSocket,
	HerdrTabStatus,
	composeLabel,
	detectHerdrTabEnv,
	isHerdrAgentStatus,
	parseHerdrAgentStatus,
	resolveHerdrSocketEndpoint,
	stripKnownPrefix,
	symbolFor,
	type HerdrAgentStatus,
	type HerdrTabEnv,
	type HerdrTabStyle,
} from "./herdr-tab.ts";
import hubExtension from "./index.ts";

const PANE_ID = "w1A:p1K";
const TAB_ID = "w1A:t1F";

const ALL_STATUSES: readonly HerdrAgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("symbolFor / composeLabel / stripKnownPrefix", () => {
	test("maps every status to the symbols style", () => {
		expect(symbolFor("working", "symbols")).toBe("◐");
		expect(symbolFor("blocked", "symbols")).toBe("×");
		expect(symbolFor("done", "symbols")).toBe("✓");
		expect(symbolFor("idle", "symbols")).toBeUndefined();
		expect(symbolFor("unknown", "symbols")).toBeUndefined();
	});

	test("maps every status to the dots style", () => {
		expect(symbolFor("blocked", "dots")).toBe("◉");
		expect(symbolFor("working", "dots")).toBe("●");
		expect(symbolFor("done", "dots")).toBe("●");
		expect(symbolFor("idle", "dots")).toBeUndefined();
		expect(symbolFor("unknown", "dots")).toBeUndefined();
	});

	test("defaults to the symbols style", () => {
		expect(symbolFor("working")).toBe("◐");
		expect(composeLabel("4", "blocked")).toBe("× 4");
	});

	test("composes a prefix for every status and style", () => {
		const expected: Record<HerdrTabStyle, Record<HerdrAgentStatus, string>> = {
			symbols: { idle: "4", working: "◐ 4", blocked: "× 4", done: "✓ 4", unknown: "4" },
			dots: { idle: "4", working: "● 4", blocked: "◉ 4", done: "● 4", unknown: "4" },
		};
		for (const style of ["symbols", "dots"] as const) {
			for (const status of ALL_STATUSES) {
				expect(composeLabel("4", status, style)).toBe(expected[style][status]);
			}
		}
	});

	test("handles an empty base without a dangling space", () => {
		expect(composeLabel("", "working")).toBe("◐");
		expect(composeLabel("", "blocked")).toBe("×");
		expect(composeLabel("", "done")).toBe("✓");
		expect(composeLabel("", "idle")).toBe("");
		expect(composeLabel("", "unknown")).toBe("");
	});

	test("preserves spaces and unicode in the base", () => {
		expect(composeLabel("my tab", "working")).toBe("◐ my tab");
		expect(composeLabel("café ☕ 4", "done")).toBe("✓ café ☕ 4");
		expect(composeLabel("  leading", "blocked")).toBe("×   leading");
	});

	test("strips every prefix this module can write", () => {
		for (const symbol of ["◐", "×", "✓", "◉", "●"]) {
			expect(stripKnownPrefix(`${symbol} 4`)).toBe("4");
			expect(stripKnownPrefix(symbol)).toBe("");
			expect(stripKnownPrefix(`${symbol} café ☕`)).toBe("café ☕");
		}
	});

	test("does not strip partial or user labels", () => {
		expect(stripKnownPrefix("4")).toBe("4");
		expect(stripKnownPrefix("")).toBe("");
		expect(stripKnownPrefix("◐4")).toBe("◐4");
		expect(stripKnownPrefix("◐x y")).toBe("◐x y");
		expect(stripKnownPrefix("plain tab")).toBe("plain tab");
	});

	test("compose then strip round-trips to the base", () => {
		for (const style of ["symbols", "dots"] as const) {
			for (const status of ALL_STATUSES) {
				for (const base of ["", "4", "my tab", "café ☕"]) {
					expect(stripKnownPrefix(composeLabel(base, status, style))).toBe(base);
				}
			}
		}
	});

	test("recovering an already-prefixed label works for both styles", () => {
		expect(composeLabel(stripKnownPrefix("◐ 4"), "done")).toBe("✓ 4");
		expect(composeLabel(stripKnownPrefix("● 4"), "blocked", "dots")).toBe("◉ 4");
		expect(composeLabel(stripKnownPrefix("◉ 4"), "working", "symbols")).toBe("◐ 4");
	});

	test("validates agent statuses", () => {
		expect(isHerdrAgentStatus("working")).toBe(true);
		expect(isHerdrAgentStatus("nope")).toBe(false);
		expect(isHerdrAgentStatus(undefined)).toBe(false);
		expect(parseHerdrAgentStatus("done")).toBe("done");
		expect(parseHerdrAgentStatus("")).toBeUndefined();
		expect(parseHerdrAgentStatus(3)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

describe("detectHerdrTabEnv", () => {
	const fullEnv: NodeJS.ProcessEnv = {
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		HERDR_PANE_ID: PANE_ID,
		HERDR_TAB_ID: TAB_ID,
	};

	test("returns the resolved env when every piece is present", () => {
		expect(detectHerdrTabEnv(fullEnv, "linux")).toEqual({
			socketPath: "/tmp/herdr.sock",
			paneId: PANE_ID,
			tabId: TAB_ID,
		});
	});

	test("requires HERDR_ENV=1 exactly", () => {
		expect(detectHerdrTabEnv({ ...fullEnv, HERDR_ENV: undefined }, "linux")).toBeUndefined();
		expect(detectHerdrTabEnv({ ...fullEnv, HERDR_ENV: "0" }, "linux")).toBeUndefined();
		expect(detectHerdrTabEnv({ ...fullEnv, HERDR_ENV: "true" }, "linux")).toBeUndefined();
		expect(detectHerdrTabEnv({ ...fullEnv, HERDR_ENV: "" }, "linux")).toBeUndefined();
	});

	test("requires socket, pane, and tab ids", () => {
		expect(detectHerdrTabEnv({ ...fullEnv, HERDR_SOCKET_PATH: undefined }, "linux")).toBeUndefined();
		expect(detectHerdrTabEnv({ ...fullEnv, HERDR_SOCKET_PATH: "" }, "linux")).toBeUndefined();
		expect(detectHerdrTabEnv({ ...fullEnv, HERDR_PANE_ID: undefined }, "linux")).toBeUndefined();
		expect(detectHerdrTabEnv({ ...fullEnv, HERDR_PANE_ID: "" }, "linux")).toBeUndefined();
		expect(detectHerdrTabEnv({ ...fullEnv, HERDR_TAB_ID: undefined }, "linux")).toBeUndefined();
		expect(detectHerdrTabEnv({ ...fullEnv, HERDR_TAB_ID: "" }, "linux")).toBeUndefined();
	});

	test("returns undefined for an empty environment", () => {
		expect(detectHerdrTabEnv({}, "linux")).toBeUndefined();
	});

	test("leaves unix socket paths untouched", () => {
		expect(resolveHerdrSocketEndpoint("/tmp/herdr.sock", "linux")).toBe("/tmp/herdr.sock");
		expect(resolveHerdrSocketEndpoint("\\\\.\\pipe\\herdr", "linux")).toBe("\\\\.\\pipe\\herdr");
	});

	test("resolves Windows named pipes", () => {
		expect(resolveHerdrSocketEndpoint("herdr", "win32")).toBe("\\\\.\\pipe\\herdr");
		expect(resolveHerdrSocketEndpoint("\\\\.\\pipe\\herdr", "win32")).toBe("\\\\.\\pipe\\herdr");
		expect(resolveHerdrSocketEndpoint("//./pipe/herdr", "win32")).toBe("//./pipe/herdr");
	});

	test("detectHerdrTabEnv applies the Windows pipe form", () => {
		expect(detectHerdrTabEnv({ ...fullEnv, HERDR_SOCKET_PATH: "herdr" }, "win32")).toEqual({
			socketPath: "\\\\.\\pipe\\herdr",
			paneId: PANE_ID,
			tabId: TAB_ID,
		});
	});
});

// ---------------------------------------------------------------------------
// Fake Herdr server
// ---------------------------------------------------------------------------

interface FakeCall {
	method: string;
	params: Record<string, unknown>;
}

interface FakeHerdrServer {
	socketPath: string;
	label: string;
	agentStatus: HerdrAgentStatus;
	connectionCount: number;
	subscriptionCount: number;
	tabGetDelayMs: number;
	renameDelayMs: number;
	calls: FakeCall[];
	listen(): Promise<void>;
	pushStatus(status: HerdrAgentStatus, paneId?: string): void;
	dropSubscriptions(): void;
	close(): Promise<void>;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

function methodCalls(server: FakeHerdrServer, method: string): FakeCall[] {
	return server.calls.filter((call) => call.method === method);
}

function startFakeServer(dir: string, options: { label?: string; agentStatus?: HerdrAgentStatus }): FakeHerdrServer {
	const socketPath = join(dir, "herdr.sock");
	const sockets = new Set<Socket>();
	const subscriptions = new Set<Socket>();

	const state = {
		label: options.label ?? "4",
		agentStatus: options.agentStatus ?? "idle",
		connectionCount: 0,
		subscriptionCount: 0,
		tabGetDelayMs: 0,
		renameDelayMs: 0,
		calls: [] as FakeCall[],
	};

	const server: Server = createServer((socket) => {
		sockets.add(socket);
		state.connectionCount += 1;
		let buffer = "";

		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line.length === 0) continue;

				let request: { id?: unknown; method?: unknown; params?: unknown };
				try {
					request = JSON.parse(line);
				} catch {
					continue;
				}
				const id = typeof request.id === "string" ? request.id : "unknown";
				const params = isRecord(request.params) ? request.params : {};

				switch (request.method) {
					case "events.subscribe": {
						subscriptions.add(socket);
						state.subscriptionCount += 1;
						socket.write(`${JSON.stringify({ id, result: { type: "subscription_started" } })}\n`);
						break;
					}
					case "tab.get": {
						state.calls.push({ method: "tab.get", params });
						// Capture the reply at request time so a delayed response models a
						// slow read that may be overtaken by a newer event.
						const response = `${JSON.stringify({
							id,
							result: {
								type: "tab_info",
								tab: {
									tab_id: params.tab_id,
									label: state.label,
									agent_status: state.agentStatus,
								},
							},
						})}\n`;
						const send = (): void => {
							if (socket.destroyed) return;
							socket.write(response);
							socket.end();
						};
						if (state.tabGetDelayMs > 0) setTimeout(send, state.tabGetDelayMs);
						else send();
						break;
					}
					case "tab.rename": {
						state.calls.push({ method: "tab.rename", params });
						const label = typeof params.label === "string" ? params.label : state.label;
						// Apply the rename when the reply is sent, not when the request
						// arrives, so overlapping renames race like the real server.
						const send = (): void => {
							if (socket.destroyed) return;
							state.label = label;
							socket.write(`${JSON.stringify({ id, result: { type: "ok" } })}\n`);
							socket.end();
						};
						if (state.renameDelayMs > 0) setTimeout(send, state.renameDelayMs);
						else send();
						break;
					}
					default: {
						socket.write(`${JSON.stringify({ id, error: { code: "unknown_method", message: "no" } })}\n`);
						socket.end();
					}
				}
			}
		});
		socket.on("error", () => undefined);
		socket.on("close", () => {
			sockets.delete(socket);
			subscriptions.delete(socket);
		});
	});

	return {
		socketPath,
		get label() {
			return state.label;
		},
		set label(value: string) {
			state.label = value;
		},
		get agentStatus() {
			return state.agentStatus;
		},
		set agentStatus(value: HerdrAgentStatus) {
			state.agentStatus = value;
		},
		get connectionCount() {
			return state.connectionCount;
		},
		get subscriptionCount() {
			return state.subscriptionCount;
		},
		get tabGetDelayMs() {
			return state.tabGetDelayMs;
		},
		set tabGetDelayMs(value: number) {
			state.tabGetDelayMs = value;
		},
		get renameDelayMs() {
			return state.renameDelayMs;
		},
		set renameDelayMs(value: number) {
			state.renameDelayMs = value;
		},
		get calls() {
			return state.calls;
		},
		async listen() {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, () => resolve());
			});
		},
		pushStatus(status, paneId = PANE_ID) {
			state.agentStatus = status;
			const line = `${JSON.stringify({
				event: "pane.agent_status_changed",
				data: { pane_id: paneId, agent_status: status },
			})}\n`;
			for (const socket of subscriptions) socket.write(line);
		},
		dropSubscriptions() {
			for (const socket of subscriptions) socket.destroy();
			subscriptions.clear();
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			subscriptions.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// State machine (fake unix socket)
// ---------------------------------------------------------------------------

describe("HerdrTabStatus against a fake Herdr server", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	let dir: string;
	let server: FakeHerdrServer;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "herdr-tab-"));
		server = startFakeServer(dir, { label: "4", agentStatus: "idle" });
		await server.listen();
	});

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function makeStatus(options: { style?: HerdrTabStyle; debounceMs?: number } = {}): HerdrTabStatus {
		const socket = new HerdrSocket({
			socketPath: server.socketPath,
			backoffBaseMs: 20,
			backoffMaxMs: 40,
		});
		const env: HerdrTabEnv = { socketPath: server.socketPath, paneId: PANE_ID, tabId: TAB_ID };
		return new HerdrTabStatus({
			env,
			socket,
			debounceMs: options.debounceMs ?? 30,
			...(options.style ? { style: options.style } : {}),
		});
	}

	function track(status: HerdrTabStatus): HerdrTabStatus {
		cleanups.push(() => status.stop());
		return status;
	}

	test("seeds the base label and prefixes the current status", async () => {
		server.agentStatus = "working";
		const status = track(makeStatus());

		await status.start();
		await waitFor(() => methodCalls(server, "tab.rename").length === 1);

		expect(methodCalls(server, "tab.rename")[0]?.params).toEqual({ tab_id: TAB_ID, label: "◐ 4" });
		expect(server.label).toBe("◐ 4");
		expect(status.status).toBe("working");
		expect(status.isActive).toBe(true);
		expect(status.describe()).toBe(`working (${TAB_ID})`);
	});

	test("rewrites the prefix on each status change and restores on idle", async () => {
		const status = track(makeStatus());
		await status.start();
		await waitFor(() => server.subscriptionCount >= 1);

		server.pushStatus("blocked");
		await waitFor(() => methodCalls(server, "tab.rename").some((call) => call.params.label === "× 4"));

		server.pushStatus("done");
		await waitFor(() => methodCalls(server, "tab.rename").some((call) => call.params.label === "✓ 4"));

		server.pushStatus("idle");
		await waitFor(() => methodCalls(server, "tab.rename").some((call) => call.params.label === "4"));

		expect(server.label).toBe("4");
		expect(status.status).toBe("idle");
	});

	test("skips a rename when the status is unchanged", async () => {
		server.agentStatus = "working";
		const status = track(makeStatus());
		await status.start();
		await waitFor(() => methodCalls(server, "tab.rename").length === 1);

		server.pushStatus("working");
		// Give the queue time to (not) react.
		await new Promise((resolve) => setTimeout(resolve, 80));

		expect(methodCalls(server, "tab.rename").length).toBe(1);
	});

	test("coalesces rapid status flips into one rename", async () => {
		const status = track(makeStatus({ debounceMs: 60 }));
		await status.start();
		await waitFor(() => server.subscriptionCount >= 1);

		server.pushStatus("working");
		server.pushStatus("blocked");
		server.pushStatus("working");
		server.pushStatus("done");

		await waitFor(() => methodCalls(server, "tab.rename").length >= 1);
		await new Promise((resolve) => setTimeout(resolve, 120));

		const renames = methodCalls(server, "tab.rename");
		expect(renames.length).toBe(1);
		expect(renames[0]?.params.label).toBe("✓ 4");
		expect(server.label).toBe("✓ 4");
	});

	test("restores the base label on stop", async () => {
		server.agentStatus = "working";
		const status = makeStatus();
		await status.start();
		await waitFor(() => server.label === "◐ 4");

		await status.stop();

		expect(server.label).toBe("4");
		expect(status.isActive).toBe(false);
		expect(status.describe()).toBe("off");
	});

	test("does not touch the label on stop when nothing was written", async () => {
		const status = makeStatus();
		await status.start();
		await waitFor(() => server.subscriptionCount >= 1);

		await status.stop();

		expect(methodCalls(server, "tab.rename").length).toBe(0);
		expect(server.label).toBe("4");
	});

	test("reconnects after the stream drops and re-seeds from tab.get", async () => {
		const status = track(makeStatus());
		await status.start();
		await waitFor(() => server.subscriptionCount >= 1);

		const getsBeforeDrop = methodCalls(server, "tab.get").length;
		server.agentStatus = "blocked";
		server.dropSubscriptions();

		await waitFor(() => server.subscriptionCount >= 2);
		await waitFor(() => methodCalls(server, "tab.get").length > getsBeforeDrop);
		await waitFor(() => methodCalls(server, "tab.rename").some((call) => call.params.label === "× 4"));

		expect(server.label).toBe("× 4");
		expect(status.status).toBe("blocked");
	});

	test("reports off before start and while disabled", async () => {
		const status = makeStatus();
		expect(status.isActive).toBe(false);
		expect(status.describe()).toBe("off");
		status.stop();
	});

	test("rebases onto a user rename before applying the next status", async () => {
		const status = track(makeStatus());
		await status.start();
		await waitFor(() => server.subscriptionCount >= 1);

		// A user renames the tab while status stays idle (no write yet).
		server.label = "my task";
		server.pushStatus("blocked");

		await waitFor(() => server.label === "× my task");
		expect(methodCalls(server, "tab.rename")[0]?.params.label).toBe("× my task");
	});

	test("ignores status events scoped to another pane", async () => {
		const status = track(makeStatus());
		await status.start();
		await waitFor(() => server.subscriptionCount >= 1);

		server.pushStatus("blocked", "w1A:pOTHER");
		await new Promise((resolve) => setTimeout(resolve, 80));

		expect(status.status).toBe("idle");
		expect(methodCalls(server, "tab.rename").length).toBe(0);
	});

	test("stop waits for an in-flight rename so the restore lands last", async () => {
		server.agentStatus = "working";
		server.renameDelayMs = 300;
		const status = makeStatus({ debounceMs: 0 });
		await status.start();
		await waitFor(() => methodCalls(server, "tab.rename").length >= 1);

		// The prefix rename is still pending. Make the restore fast; if stop did
		// not serialize, the late prefix would overwrite the restore.
		server.renameDelayMs = 0;
		await status.stop();

		expect(server.label).toBe("4");
		const renames = methodCalls(server, "tab.rename");
		expect(renames[renames.length - 1]?.params.label).toBe("4");
	});

	test("stop during the seed read cancels start without opening a stream", async () => {
		server.tabGetDelayMs = 200;
		const status = makeStatus();
		const started = status.start();
		await new Promise((resolve) => setTimeout(resolve, 20));

		await status.stop();
		await started;
		// Give a resurrected subscription time to connect before asserting.
		await new Promise((resolve) => setTimeout(resolve, 80));

		expect(server.subscriptionCount).toBe(0);
		expect(methodCalls(server, "tab.rename").length).toBe(0);
		expect(status.isActive).toBe(false);
	});

	test("a reconnect reseed does not overwrite a newer status event", async () => {
		const status = track(makeStatus());
		await status.start();
		await waitFor(() => server.subscriptionCount >= 1);

		// Slow the reconnect seed read. Once its request is captured, speed tab.get
		// back up so the newer event resolves first and the stale seed would win if
		// it were not discarded.
		server.tabGetDelayMs = 250;
		server.agentStatus = "blocked";
		const getsBefore = methodCalls(server, "tab.get").length;
		server.dropSubscriptions();

		await waitFor(() => server.subscriptionCount >= 2);
		await waitFor(() => methodCalls(server, "tab.get").length > getsBefore);
		server.tabGetDelayMs = 0;
		server.pushStatus("done");

		await waitFor(() => server.label === "✓ 4");
		// Past the stale seed's delayed reply.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(server.label).toBe("✓ 4");
		expect(status.status).toBe("done");
	});

	test("contains a throwing onStatusChange callback", async () => {
		const socket = new HerdrSocket({
			socketPath: server.socketPath,
			backoffBaseMs: 20,
			backoffMaxMs: 40,
		});
		const env: HerdrTabEnv = { socketPath: server.socketPath, paneId: PANE_ID, tabId: TAB_ID };
		const status = new HerdrTabStatus({
			env,
			socket,
			debounceMs: 0,
			onStatusChange: () => {
				throw new Error("callback boom");
			},
		});
		cleanups.push(() => status.stop());

		server.agentStatus = "working";
		await status.start();
		await waitFor(() => server.label === "◐ 4");
		expect(status.status).toBe("working");
	});
});

// ---------------------------------------------------------------------------
// HerdrSocket stream lifecycle
// ---------------------------------------------------------------------------

describe("HerdrSocket stream lifecycle", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	let dir: string;
	let server: FakeHerdrServer;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "herdr-socket-"));
		server = startFakeServer(dir, { label: "4", agentStatus: "idle" });
		await server.listen();
	});

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("a resubscribe does not let a stale close callback open a duplicate stream", async () => {
		const socket = new HerdrSocket({
			socketPath: server.socketPath,
			backoffBaseMs: 20,
			backoffMaxMs: 40,
		});
		cleanups.push(() => socket.destroy());

		socket.subscribe([{ type: "pane.agent_status_changed", pane_id: PANE_ID }], () => undefined);
		await waitFor(() => server.subscriptionCount >= 1);

		// Replacing the stream destroys the old socket; its close callback fires
		// after the new stream exists and must not schedule a reconnect.
		socket.subscribe([{ type: "pane.agent_status_changed", pane_id: PANE_ID }], () => undefined);
		await waitFor(() => server.subscriptionCount >= 2);

		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(server.subscriptionCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Index wiring: no socket activity when inert
// ---------------------------------------------------------------------------

interface FakePi {
	pi: unknown;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	commands: Map<string, unknown>;
}

function createFakePi(): FakePi {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, unknown>();
	const pi = {
		events: { on: () => undefined, emit: () => undefined },
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(name, handler);
		},
		registerCommand: (name: string, options: unknown) => {
			commands.set(name, options);
		},
		registerTool() {},
	};
	return { pi, handlers, commands };
}

describe("hub index Herdr wiring", () => {
	const ENV_KEYS = [
		"HERDR_ENV",
		"HERDR_SOCKET_PATH",
		"HERDR_PANE_ID",
		"HERDR_TAB_ID",
		"PI_HUB_HERDR_TAB",
		"PI_HUB_HERDR_TAB_STYLE",
	] as const;
	const savedEnv = new Map<string, string | undefined>();
	const cleanups: Array<() => Promise<void> | void> = [];
	let dir: string;
	let server: FakeHerdrServer;

	beforeEach(async () => {
		for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
		for (const key of ENV_KEYS) delete process.env[key];

		dir = mkdtempSync(join(tmpdir(), "herdr-tab-idx-"));
		server = startFakeServer(dir, { label: "4", agentStatus: "working" });
		await server.listen();
	});

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		await server.close();
		rmSync(dir, { recursive: true, force: true });
		for (const key of ENV_KEYS) {
			const value = savedEnv.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		savedEnv.clear();
	});

	test("does not connect when the Herdr environment is absent", async () => {
		const { pi, handlers } = createFakePi();
		hubExtension(pi as never);

		await handlers.get("session_start")?.({}, { mode: "tui", hasUI: true });
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(server.connectionCount).toBe(0);
	});

	test("does not connect in a non-TUI session even with the environment set", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = server.socketPath;
		process.env.HERDR_PANE_ID = PANE_ID;
		process.env.HERDR_TAB_ID = TAB_ID;

		const { pi, handlers } = createFakePi();
		hubExtension(pi as never);
		cleanups.push(() => handlers.get("session_shutdown")?.({}, {}));

		await handlers.get("session_start")?.({}, { mode: "rpc", hasUI: true });
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(server.connectionCount).toBe(0);
	});

	test("starts when the environment and TUI context are present", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = server.socketPath;
		process.env.HERDR_PANE_ID = PANE_ID;
		process.env.HERDR_TAB_ID = TAB_ID;

		const { pi, handlers } = createFakePi();
		hubExtension(pi as never);
		cleanups.push(() => handlers.get("session_shutdown")?.({}, {}));

		await handlers.get("session_start")?.({}, { mode: "tui", hasUI: true });
		await waitFor(() => server.subscriptionCount >= 1);
		await waitFor(() => server.label === "◐ 4");

		expect(server.connectionCount).toBeGreaterThan(0);

		await handlers.get("session_shutdown")?.({}, {});
		await waitFor(() => server.label === "4");
	});

	test("PI_HUB_HERDR_TAB=0 disables the feature", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = server.socketPath;
		process.env.HERDR_PANE_ID = PANE_ID;
		process.env.HERDR_TAB_ID = TAB_ID;
		process.env.PI_HUB_HERDR_TAB = "0";

		const { pi, handlers } = createFakePi();
		hubExtension(pi as never);

		await handlers.get("session_start")?.({}, { mode: "tui", hasUI: true });
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(server.connectionCount).toBe(0);
	});

	test("session_shutdown awaits the bounded restore", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = server.socketPath;
		process.env.HERDR_PANE_ID = PANE_ID;
		process.env.HERDR_TAB_ID = TAB_ID;
		// Delay the restore write so an unawaited stop would resolve before it.
		server.renameDelayMs = 150;

		const { pi, handlers } = createFakePi();
		hubExtension(pi as never);

		await handlers.get("session_start")?.({}, { mode: "tui", hasUI: true });
		await waitFor(() => server.label === "◐ 4");

		await handlers.get("session_shutdown")?.({}, {});
		expect(server.label).toBe("4");
	});

	test("/px:hub reports the current Herdr tab status", async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = server.socketPath;
		process.env.HERDR_PANE_ID = PANE_ID;
		process.env.HERDR_TAB_ID = TAB_ID;

		const { pi, handlers, commands } = createFakePi();
		hubExtension(pi as never);
		cleanups.push(() => handlers.get("session_shutdown")?.({}, {}));

		await handlers.get("session_start")?.({}, { mode: "tui", hasUI: true });
		await waitFor(() => server.label === "◐ 4");

		const messages: string[] = [];
		const command = commands.get("px:hub") as {
			handler: (args: unknown, ctx: unknown) => Promise<void> | void;
		};
		await command.handler(
			{},
			{ hasUI: true, ui: { notify: (message: string) => messages.push(message) } },
		);

		expect(messages).toHaveLength(1);
		expect(messages[0] ?? "").toContain(`herdr tab: working (${TAB_ID})`);
	});

	test("/px:hub reports off when the Herdr environment is absent", async () => {
		const { pi, commands } = createFakePi();
		hubExtension(pi as never);

		const messages: string[] = [];
		const command = commands.get("px:hub") as {
			handler: (args: unknown, ctx: unknown) => Promise<void> | void;
		};
		await command.handler(
			{},
			{ hasUI: true, ui: { notify: (message: string) => messages.push(message) } },
		);

		expect(messages).toHaveLength(1);
		expect(messages[0] ?? "").toContain("herdr tab: off");
	});
});
