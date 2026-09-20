/**
 * Stage 1 feasibility tests for the typed Herdr adapter.
 *
 * These run without a live Herdr server:
 *  - environment/binary detection is pure;
 *  - client behavior is exercised through a fake transport;
 *  - the real Unix-socket transport is verified against a mock server that
 *    reproduces the one-request-per-connection framing observed in Herdr 0.9.x.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HerdrApiError,
	HerdrProtocolError,
	SUPPORTED_HERDR_PROTOCOL,
	createHerdrClient,
	createUnixSocketTransport,
	readHerdrEnvironment,
	resolveHerdrExecutable,
	type HerdrEnvironment,
	type HerdrTransport,
} from "./herdr-client.ts";

const baseEnv: HerdrEnvironment = {
	socketPath: "/tmp/herdr.sock",
	paneId: "w1A:p1C",
	workspaceId: "w1A",
	tabId: "w1A:t18",
};

interface Call {
	method: string;
	params: Record<string, unknown>;
}

function fakeTransport(responses: Record<string, unknown>): { transport: HerdrTransport; calls: Call[] } {
	const calls: Call[] = [];
	const transport: HerdrTransport = {
		async request(method, params) {
			calls.push({ method, params: params ?? {} });
			if (!(method in responses)) throw new Error(`No fake response for ${method}`);
			const value = responses[method];
			return typeof value === "function" ? (value as (p: Record<string, unknown>) => unknown)(params ?? {}) : value;
		},
	};
	return { transport, calls };
}

const pane = {
	pane_id: "w1A:p1C",
	terminal_id: "term_1",
	workspace_id: "w1A",
	tab_id: "w1A:t18",
	focused: true,
	agent_status: "idle",
	revision: 3,
	cwd: "/work",
	label: "Subagents",
	tokens: { px_owner: "abc" },
};

const tab = {
	tab_id: "w1A:t18",
	workspace_id: "w1A",
	number: 18,
	label: "Subagents",
	focused: false,
	pane_count: 2,
	agent_status: "idle",
};

describe("readHerdrEnvironment", () => {
	test("detects a complete Herdr environment", () => {
		const env = readHerdrEnvironment({
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: "/run/herdr.sock",
			HERDR_PANE_ID: "w1A:p1C",
			HERDR_WORKSPACE_ID: "w1A",
			HERDR_TAB_ID: "w1A:t18",
			HERDR_BIN_PATH: "/opt/herdr",
		});
		expect(env).toEqual({
			socketPath: "/run/herdr.sock",
			paneId: "w1A:p1C",
			workspaceId: "w1A",
			tabId: "w1A:t18",
			binPath: "/opt/herdr",
		});
	});

	test("omits optional tab and bin path", () => {
		const env = readHerdrEnvironment({
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: "/run/herdr.sock",
			HERDR_PANE_ID: "w1A:p1C",
			HERDR_WORKSPACE_ID: "w1A",
		});
		expect(env).toEqual({ socketPath: "/run/herdr.sock", paneId: "w1A:p1C", workspaceId: "w1A" });
	});

	test("returns undefined outside Herdr or with incomplete context", () => {
		expect(readHerdrEnvironment({})).toBeUndefined();
		expect(readHerdrEnvironment({ HERDR_ENV: "1" })).toBeUndefined();
		expect(
			readHerdrEnvironment({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "p" }),
		).toBeUndefined();
	});
});

describe("resolveHerdrExecutable", () => {
	test("prefers an executable HERDR_BIN_PATH", () => {
		const result = resolveHerdrExecutable(
			{ HERDR_BIN_PATH: "/opt/herdr", PATH: "/usr/bin" },
			{ isExecutable: (p) => p === "/opt/herdr" },
		);
		expect(result).toBe("/opt/herdr");
	});

	test("falls back to PATH when HERDR_BIN_PATH is stale", () => {
		const result = resolveHerdrExecutable(
			{ HERDR_BIN_PATH: "/gone/herdr", PATH: "/a:/b" },
			{ isExecutable: (p) => p === join("/b", "herdr") },
		);
		expect(result).toBe(join("/b", "herdr"));
	});

	test("returns the stale configured path when nothing is executable", () => {
		const result = resolveHerdrExecutable(
			{ HERDR_BIN_PATH: "/gone/herdr", PATH: "/a" },
			{ isExecutable: () => false },
		);
		expect(result).toBe("/gone/herdr");
	});
});

describe("HerdrClient structured operations", () => {
	test("pings and validates protocol compatibility", async () => {
		const { transport, calls } = fakeTransport({
			ping: { type: "pong", version: "0.9.1", protocol: SUPPORTED_HERDR_PROTOCOL },
		});
		const client = createHerdrClient({ environment: baseEnv, transport });
		expect(await client.assertCompatible()).toEqual({
			version: "0.9.1",
			protocol: SUPPORTED_HERDR_PROTOCOL,
		});
		expect(calls[0]).toEqual({ method: "ping", params: {} });
	});

	test("rejects an older protocol", async () => {
		const { transport } = fakeTransport({
			ping: { type: "pong", version: "0.1.0", protocol: SUPPORTED_HERDR_PROTOCOL - 1 },
		});
		const client = createHerdrClient({ environment: baseEnv, transport });
		await expect(client.assertCompatible()).rejects.toThrow(HerdrApiError);
	});

	test("assertCompatible works when destructured", async () => {
		const { transport } = fakeTransport({
			ping: { type: "pong", version: "0.9.1", protocol: SUPPORTED_HERDR_PROTOCOL },
		});
		const { assertCompatible } = createHerdrClient({ environment: baseEnv, transport });
		expect((await assertCompatible()).version).toBe("0.9.1");
	});

	test("lists tabs scoped to the parent workspace", async () => {
		const { transport, calls } = fakeTransport({ "tab.list": { type: "tab_list", tabs: [tab] } });
		const client = createHerdrClient({ environment: baseEnv, transport });
		expect(await client.listTabs()).toEqual([
			{
				tabId: "w1A:t18",
				workspaceId: "w1A",
				number: 18,
				label: "Subagents",
				focused: false,
				paneCount: 2,
				agentStatus: "idle",
			},
		]);
		expect(calls[0].params).toEqual({ workspace_id: "w1A" });
	});

	test("creates a tab with focus disabled by default", async () => {
		const { transport, calls } = fakeTransport({
			"tab.create": { type: "tab_created", tab, root_pane: pane },
		});
		const client = createHerdrClient({ environment: baseEnv, transport });
		const created = await client.createTab({ label: "Subagents · p1C · abc" });
		expect(created.tab.tabId).toBe("w1A:t18");
		expect(created.rootPane.paneId).toBe("w1A:p1C");
		expect(calls[0].params).toEqual({
			workspace_id: "w1A",
			focus: false,
			label: "Subagents · p1C · abc",
		});
	});

	test("splits a pane without stealing focus and uses explicit target", async () => {
		const { transport, calls } = fakeTransport({ "pane.split": { type: "pane_info", pane } });
		const client = createHerdrClient({ environment: baseEnv, transport });
		await client.splitPane({ targetPaneId: "w1A:p1C", direction: "right", cwd: "/work" });
		expect(calls[0].params).toEqual({
			target_pane_id: "w1A:p1C",
			direction: "right",
			focus: false,
			cwd: "/work",
		});
	});

	test("focuses an exact pane id", async () => {
		const { transport, calls } = fakeTransport({ "pane.focus": { type: "pane_info", pane } });
		const client = createHerdrClient({ environment: baseEnv, transport });
		const focused = await client.focusPane("w1A:p1Q");
		expect(focused.paneId).toBe("w1A:p1C");
		expect(calls[0]).toEqual({ method: "pane.focus", params: { pane_id: "w1A:p1Q" } });
	});

	test("reads pane output using the API source spelling", async () => {
		const { transport, calls } = fakeTransport({
			"pane.read": {
				type: "pane_read",
				read: {
					pane_id: "w1A:p1C",
					workspace_id: "w1A",
					tab_id: "w1A:t18",
					source: "recent_unwrapped",
					format: "text",
					text: "hello",
					revision: 4,
					truncated: false,
				},
			},
		});
		const client = createHerdrClient({ environment: baseEnv, transport });
		const read = await client.readPane({ paneId: "w1A:p1C", lines: 20 });
		expect(read.text).toBe("hello");
		expect(calls[0].params).toEqual({ pane_id: "w1A:p1C", source: "recent_unwrapped", lines: 20 });
	});

	test("parses a pane.layout snapshot with rectangles", async () => {
		const { transport, calls } = fakeTransport({
			"pane.layout": {
				type: "pane_layout",
				layout: {
					workspace_id: "w1A",
					tab_id: "w1A:t18",
					zoomed: false,
					focused_pane_id: "w1A:p1C",
					area: { x: 0, y: 0, width: 80, height: 24 },
					panes: [
						{ pane_id: "w1A:p1C", focused: true, rect: { x: 0, y: 0, width: 40, height: 24 } },
						{ pane_id: "w1A:p1Q", focused: false, rect: { x: 40, y: 0, width: 40, height: 24 } },
					],
					splits: [
						{
							id: "split-1",
							direction: "right",
							ratio: 0.5,
							rect: { x: 0, y: 0, width: 80, height: 24 },
						},
					],
				},
			},
		});
		const client = createHerdrClient({ environment: baseEnv, transport });
		const layout = await client.getPaneLayout("w1A:p1C");
		expect(calls[0]).toEqual({ method: "pane.layout", params: { pane_id: "w1A:p1C" } });
		expect(layout.tabId).toBe("w1A:t18");
		expect(layout.panes.map((p) => p.paneId)).toEqual(["w1A:p1C", "w1A:p1Q"]);
		expect(layout.panes[1].rect.width).toBe(40);
		expect(layout.splits[0].direction).toBe("right");
	});

	test("reports ownership tokens through structured metadata", async () => {
		const { transport, calls } = fakeTransport({ "pane.report_metadata": { type: "ok" } });
		const client = createHerdrClient({ environment: baseEnv, transport });
		await client.reportPaneMetadata("w1A:p1Q", "px-subagent", {
			title: "Subagents",
			tokens: { px_owner: "abc", px_run: "sa-1" },
			ttlMs: 60_000,
		});
		expect(calls[0]).toEqual({
			method: "pane.report_metadata",
			params: {
				pane_id: "w1A:p1Q",
				source: "px-subagent",
				title: "Subagents",
				tokens: { px_owner: "abc", px_run: "sa-1" },
				ttl_ms: 60_000,
			},
		});
	});

	test("exposes pane ownership tokens from pane.get", async () => {
		const { transport } = fakeTransport({ "pane.get": { type: "pane_info", pane } });
		const client = createHerdrClient({ environment: baseEnv, transport });
		const info = await client.getPane("w1A:p1C");
		expect(info.tokens).toEqual({ px_owner: "abc" });
		expect(info.label).toBe("Subagents");
	});

	test("rejects a malformed structured response", async () => {
		const { transport } = fakeTransport({ "pane.get": { type: "pane_info", pane: { pane_id: 1 } } });
		const client = createHerdrClient({ environment: baseEnv, transport });
		await expect(client.getPane("w1A:p1C")).rejects.toThrow(HerdrProtocolError);
	});

	test("rejects an unexpected result type", async () => {
		const { transport } = fakeTransport({ "pane.get": { type: "ok" } });
		const client = createHerdrClient({ environment: baseEnv, transport });
		await expect(client.getPane("w1A:p1C")).rejects.toThrow(HerdrProtocolError);
	});
});

describe("createUnixSocketTransport", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	function startServer(handler: (request: unknown, socket: import("node:net").Socket) => void): {
		socketPath: string;
	} {
		const dir = mkdtempSync(join(tmpdir(), "herdr-client-test-"));
		const socketPath = join(dir, "herdr.sock");
		const server: Server = createServer((socket) => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				handler(JSON.parse(line), socket);
			});
		});
		server.listen(socketPath);
		cleanups.push(() => {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		});
		return { socketPath };
	}

	test("sends a framed request and parses the result envelope", async () => {
		let received: unknown;
		const { socketPath } = startServer((request, socket) => {
			received = request;
			socket.end(`${JSON.stringify({ id: "x", result: { type: "pong", version: "0.9.1", protocol: 22 } })}\n`);
		});
		const transport = createUnixSocketTransport({ socketPath, timeoutMs: 2000 });
		const result = await transport.request("ping", {});
		expect(received).toEqual({ id: expect.any(String), method: "ping", params: {} });
		expect(result).toEqual({ type: "pong", version: "0.9.1", protocol: 22 });
	});

	test("throws HerdrApiError for an error envelope", async () => {
		const { socketPath } = startServer((_request, socket) => {
			socket.end(`${JSON.stringify({ id: "x", error: { code: "invalid_request", message: "nope" } })}\n`);
		});
		const transport = createUnixSocketTransport({ socketPath, timeoutMs: 2000 });
		const error = await transport.request("pane.get", { pane_id: "x" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HerdrApiError);
		expect((error as HerdrApiError).code).toBe("invalid_request");
		expect((error as HerdrApiError).method).toBe("pane.get");
	});

	test("times out when the server never responds", async () => {
		const { socketPath } = startServer(() => {
			/* deliberately silent */
		});
		const transport = createUnixSocketTransport({ socketPath, timeoutMs: 50 });
		await expect(transport.request("ping", {})).rejects.toThrow(/timed out/);
	});

	test("rejects responses over the byte bound", async () => {
		const { socketPath } = startServer((_request, socket) => {
			socket.end(`${"x".repeat(5000)}\n`);
		});
		const transport = createUnixSocketTransport({ socketPath, timeoutMs: 2000, maxResponseBytes: 1024 });
		await expect(transport.request("ping", {})).rejects.toThrow(HerdrProtocolError);
	});

	test("rejects malformed JSON", async () => {
		const { socketPath } = startServer((_request, socket) => {
			socket.end("not json\n");
		});
		const transport = createUnixSocketTransport({ socketPath, timeoutMs: 2000 });
		await expect(transport.request("ping", {})).rejects.toThrow(HerdrProtocolError);
	});

	test("opens a fresh connection per request", async () => {
		let connections = 0;
		const { socketPath } = startServer((_request, socket) => {
			connections += 1;
			socket.end(`${JSON.stringify({ id: "x", result: { type: "ok" } })}\n`);
		});
		const transport = createUnixSocketTransport({ socketPath, timeoutMs: 2000 });
		await transport.request("tab.close", { tab_id: "w1A:t1" });
		await transport.request("tab.close", { tab_id: "w1A:t2" });
		expect(connections).toBe(2);
	});
});

describe("resolveHerdrExecutable with real files", () => {
	test("prefers an executable file and falls back to the configured path", () => {
		const dir = mkdtempSync(join(tmpdir(), "herdr-bin-test-"));
		try {
			const file = join(dir, "herdr");
			writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
			expect(resolveHerdrExecutable({ HERDR_BIN_PATH: file, PATH: "" })).toBe(file);
			const noExec = join(dir, "not-exec");
			writeFileSync(noExec, "x");
			// No executable found anywhere, so the configured path is returned so
			// the caller can surface a useful spawn error instead of "not found".
			expect(resolveHerdrExecutable({ HERDR_BIN_PATH: noExec, PATH: "" })).toBe(noExec);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
