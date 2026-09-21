// Integration tests for Stage 3: HTTP tools consume `perm:net` through the hub.
//
// The harness loads the real hub, permissions-core, and http extension on a
// shared event bus, then drives them the way safe-mode does: it asks the hub
// for a `perm:tool` decision. This exercises the nested `perm:tool -> perm:net`
// request (the recursive path) end to end, including provider absence,
// timeouts, malformed answers, MemoryFS bypass, and output-file safeguards.
//
// Safe-mode itself cannot be imported here (its runtime deps are provided by
// pi, not installed locally). Its only Stage 3 responsibility is unchanged: it
// asks `perm:tool` and turns a `confirm` into a block when there is no UI. That
// last step is mirrored explicitly in the non-interactive test below.

import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hubExtension from "../hub/index.ts";
import permissionsCoreExtension from "../permissions-core/index.ts";
import httpExtension from "./index.ts";

const PROJECT_ROOT = "/tmp/pi-http-project";

type BusHandler = (data: unknown) => void;

interface Bus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: BusHandler): () => void;
}

function createBus() {
	const handlers = new Map<string, Set<BusHandler>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const bus: Bus = {
		emit(channel, data) {
			emitted.push({ channel, data });
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set<BusHandler>();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
	};
	return { bus, emitted };
}

type LifecycleHandler = (event: unknown, ctx: unknown) => unknown;

type ToolExecute = (
	toolCallId: string,
	params: unknown,
	signal?: AbortSignal,
	onUpdate?: unknown,
	ctx?: unknown,
) => Promise<unknown>;

interface FakeTool {
	name: string;
	execute: ToolExecute;
}

interface FakePi {
	events: Bus;
	on(event: string, handler: LifecycleHandler): void;
	registerTool(tool: FakeTool): void;
	registerCommand(): void;
	registerFlag(): void;
	registerShortcut(): void;
	appendEntry(): void;
	getFlag(): undefined;
	getCommands(): unknown[];
	sendUserMessage(): void;
}

function createFakePi(bus: Bus) {
	const lifecycle = new Map<string, LifecycleHandler[]>();
	const tools = new Map<string, FakeTool>();
	const pi: FakePi = {
		events: bus,
		on(event, handler) {
			const list = lifecycle.get(event) ?? [];
			list.push(handler);
			lifecycle.set(event, list);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerFlag() {},
		registerShortcut() {},
		appendEntry() {},
		getFlag: () => undefined,
		getCommands: () => [],
		sendUserMessage() {},
	};
	return { pi, lifecycle, tools };
}

// Minimal safe-mode surrogate: answers permissions-core's read-only state query
// and lets tests change the observed mode.
function stubSafeMode(bus: Bus, initialMode: string) {
	let mode = initialMode;
	bus.on("px:safe-mode:state:request", (payload) => {
		if (typeof payload !== "object" || payload === null) return;
		const id = (payload as { id?: unknown }).id;
		if (typeof id !== "string") return;
		bus.emit("px:safe-mode:state:response", { id, state: { mode, outerAccess: false } });
	});
	return {
		setMode(next: string) {
			mode = next;
			bus.emit("px:safe-mode:state:changed", { mode: next, outerAccess: false, source: "test" });
		},
	};
}

interface HarnessOptions {
	hub?: boolean;
	core?: boolean;
	http?: boolean;
	safeMode?: string;
	beforeSession?: (bus: Bus) => void;
}

async function createHarness(options: HarnessOptions = {}) {
	const { bus, emitted } = createBus();
	const { pi, lifecycle, tools } = createFakePi(bus);
	if (options.hub !== false) hubExtension(pi as unknown as ExtensionAPI);
	if (options.core !== false) permissionsCoreExtension(pi as unknown as ExtensionAPI);
	if (options.http !== false) httpExtension(pi as unknown as ExtensionAPI);
	const safeMode = stubSafeMode(bus, options.safeMode ?? "smart");
	options.beforeSession?.(bus);

	const ctx = { hasUI: false, cwd: PROJECT_ROOT, sessionManager: { getBranch: () => [] } };
	for (const handler of lifecycle.get("session_start") ?? []) {
		await handler({}, ctx);
	}
	return { bus, emitted, tools, safeMode, ctx, lifecycle };
}

interface CapResult {
	what: string;
	action: string;
	reason?: string;
	summary?: string;
}

let askCounter = 0;

// Ask the hub for a `perm:tool` decision exactly like safe-mode's tool_call hook.
async function askPermTool(
	bus: Bus,
	toolName: string,
	input: Record<string, unknown>,
	mode = "smart",
	toolCallId?: string,
	timeoutMs = 3000,
): Promise<CapResult> {
	const id = `ask-tool-${++askCounter}`;
	return await new Promise<CapResult>((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error("perm:tool answer timeout (possible deadlock)"));
		}, timeoutMs);
		const off = bus.on("hub:answer", (payload) => {
			if (typeof payload !== "object" || payload === null) return;
			const answer = payload as { id?: unknown; results?: unknown };
			if (answer.id !== id || !Array.isArray(answer.results)) return;
			clearTimeout(timer);
			off();
			const match = answer.results.find(
				(result) => typeof result === "object" && result !== null && (result as { what?: unknown }).what === "perm:tool",
			);
			resolve((match ?? { what: "perm:tool", action: "block", reason: "no perm:tool result" }) as CapResult);
		});
		bus.emit("hub:ask", {
			id,
			from: "safe-mode",
			cap: [
				{
					what: "perm:tool",
					data: { toolName, input, mode, projectRoot: PROJECT_ROOT, outerAccess: false, toolCallId },
				},
			],
		});
	});
}

// Simulate safe-mode's final-decision handoff to a capability consumer.
function emitToolAuthorized(bus: Bus, toolCallId: string, toolName: string, source = "safe-mode"): void {
	bus.emit("px:safe-mode:tool-authorized", { toolCallId, toolName, source });
}

async function runTool(
	tools: Map<string, FakeTool>,
	name: string,
	toolCallId: string,
	params: Record<string, unknown>,
	ctx: unknown,
): Promise<unknown> {
	const tool = tools.get(name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	return await tool.execute(toolCallId, params, undefined, undefined, ctx);
}

function stubFetch() {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		calls.push(String(input));
		return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
	}) as typeof fetch;
	return {
		calls,
		restore() {
			globalThis.fetch = original;
		},
	};
}

// Mirror safe-mode's non-interactive tool_call behavior: a provider `confirm`
// becomes a block. Safe-mode owns this; Stage 3 leaves it unchanged.
async function requestNonInteractive(bus: Bus, toolName: string, input: Record<string, unknown>, mode = "smart") {
	const decision = await askPermTool(bus, toolName, input, mode);
	if (decision.action === "confirm") {
		return { block: true, reason: `Approval required, but no UI is available: ${decision.summary ?? ""}` };
	}
	return decision;
}

function countNetAsks(emitted: Array<{ channel: string; data: unknown }>): number {
	return emitted.filter((event) => {
		if (event.channel !== "hub:ask") return false;
		const cap = (event.data as { cap?: unknown }).cap;
		return Array.isArray(cap) && cap.some((item) => (item as { what?: unknown }).what === "perm:net");
	}).length;
}

// Register a bare `perm:net` provider that replies with a fixed action, a
// malformed action, or never replies.
function registerNetProvider(bus: Bus, id: string, action: string | null, delayMs = 0) {
	bus.on("hub:request", (payload) => {
		if (typeof payload !== "object" || payload === null) return;
		const request = payload as { id?: unknown; targets?: unknown; cap?: unknown };
		if (typeof request.id !== "string") return;
		if (Array.isArray(request.targets) && !request.targets.includes(id)) return;
		if (!Array.isArray(request.cap)) return;
		const hasNet = request.cap.some((item) => (item as { what?: unknown }).what === "perm:net");
		if (!hasNet) return;
		if (action === null) return; // never reply
		const reply = (): void => {
			bus.emit("hub:reply", { id: request.id, from: id, results: [{ what: "perm:net", action }] });
		};
		if (delayMs > 0) setTimeout(reply, delayMs);
		else reply();
	});
}

describe("http tools consume perm:net (Stage 3)", () => {
	test("registers the three network tools and a perm:tool provider", async () => {
		const { tools } = await createHarness();
		expect([...tools.keys()]).toEqual(["http", "http_md", "web_search"]);
	});

	test("trusted methods allow under smart (Auto = ask-untrusted)", async () => {
		const { bus } = await createHarness({ safeMode: "smart" });
		for (const method of ["GET", "HEAD", "OPTIONS", "get", " head "]) {
			const result = await askPermTool(bus, "http", { url: "https://example.com", method });
			expect(result).toMatchObject({ what: "perm:tool", action: "allow" });
		}
		// Missing method normalizes to GET.
		expect(await askPermTool(bus, "http", { url: "https://example.com" })).toMatchObject({ action: "allow" });
	});

	test("trusted methods confirm under reader (Auto = ask-all)", async () => {
		const { bus } = await createHarness({ safeMode: "reader" });
		expect(await askPermTool(bus, "http", { url: "https://example.com" }, "reader")).toMatchObject({
			action: "confirm",
		});
		expect(await askPermTool(bus, "http_md", { url: "https://example.com" }, "reader")).toMatchObject({
			action: "confirm",
		});
		expect(await askPermTool(bus, "web_search", { query: "pi" }, "reader")).toMatchObject({ action: "confirm" });
	});

	test("untrusted valid methods confirm under smart", async () => {
		const { bus } = await createHarness({ safeMode: "smart" });
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "PURGE"]) {
			const result = await askPermTool(bus, "http", { url: "https://example.com", method });
			expect(result).toMatchObject({ action: "confirm" });
		}
	});

	test("invalid method and URL block instead of prompting", async () => {
		const { bus } = await createHarness({ safeMode: "smart" });
		expect(await askPermTool(bus, "http", { url: "https://example.com", method: "GE T" })).toMatchObject({
			action: "block",
		});
		expect(await askPermTool(bus, "http", { method: "GET" })).toMatchObject({ action: "block" });
		expect(await askPermTool(bus, "http", { url: "ftp://example.com" })).toMatchObject({ action: "block" });
		const credentialed = await askPermTool(bus, "http", { url: "https://user:pass@example.com" });
		expect(credentialed).toMatchObject({ action: "block" });
		expect(credentialed.summary ?? "").not.toContain("pass");
	});

	test("http_md follows the same method trust", async () => {
		const { bus } = await createHarness({ safeMode: "smart" });
		expect(await askPermTool(bus, "http_md", { url: "https://example.com" })).toMatchObject({ action: "allow" });
		expect(await askPermTool(bus, "http_md", { url: "https://example.com", method: "DELETE" })).toMatchObject({
			action: "confirm",
		});
	});

	test("web_search is trusted", async () => {
		const { bus } = await createHarness({ safeMode: "smart" });
		expect(await askPermTool(bus, "web_search", { query: "pi coding agent" })).toMatchObject({ action: "allow" });
	});

	test("yolo (Auto = allow-trusted) allows trusted and blocks untrusted", async () => {
		const { bus } = await createHarness({ safeMode: "yolo" });
		expect(await askPermTool(bus, "http", { url: "https://example.com" }, "yolo")).toMatchObject({ action: "allow" });
		expect(await askPermTool(bus, "http", { url: "https://example.com", method: "POST" }, "yolo")).toMatchObject({
			action: "block",
		});
	});

	test("deny-all blocks even trusted traffic", async () => {
		const { bus } = await createHarness({ safeMode: "yolo" });
		bus.emit("px:permissions-core:net:state:set", { setting: "deny-all", source: "test" });
		expect(await askPermTool(bus, "http", { url: "https://example.com" }, "yolo")).toMatchObject({ action: "block" });
	});

	test("paranoid (ask-all) confirms trusted traffic", async () => {
		const { bus, safeMode } = await createHarness({ safeMode: "smart" });
		safeMode.setMode("paranoid");
		expect(await askPermTool(bus, "http", { url: "https://example.com" })).toMatchObject({ action: "confirm" });
	});

	test("MemoryFS-only reads allow without asking perm:net", async () => {
		const { bus, emitted } = await createHarness({ safeMode: "yolo" });
		const before = countNetAsks(emitted);
		const result = await askPermTool(bus, "http", { memfs: { id: "mem-1", offset: 1, limit: 10 } }, "yolo");
		expect(result).toMatchObject({ action: "allow" });
		expect(countNetAsks(emitted)).toBe(before);
	});

	test("provider absence fails closed", async () => {
		const { bus } = await createHarness({ core: false, safeMode: "yolo" });
		const result = await askPermTool(bus, "http", { url: "https://example.com" }, "yolo");
		expect(result).toMatchObject({ action: "block", reason: "no hub provider" });
	});

	test("provider timeout fails closed", async () => {
		const { bus } = await createHarness({
			core: false,
			safeMode: "yolo",
			beforeSession: (b) => {
				registerNetProvider(b, "stall", null);
				b.emit("hub:register", { id: "stall", caps: { provide: ["perm:net"] } });
			},
		});
		const result = await askPermTool(bus, "http", { url: "https://example.com" }, "yolo");
		expect(result).toMatchObject({ action: "block" });
		expect(result.reason).toContain("unavailable");
	});

	test("malformed provider answer fails closed", async () => {
		const { bus } = await createHarness({
			core: false,
			safeMode: "yolo",
			beforeSession: (b) => {
				registerNetProvider(b, "bogus", "banana");
				b.emit("hub:register", { id: "bogus", caps: { provide: ["perm:net"] } });
			},
		});
		const result = await askPermTool(bus, "http", { url: "https://example.com" }, "yolo");
		expect(result).toMatchObject({ action: "block" });
	});

	test("non-interactive confirmation blocks", async () => {
		const { bus } = await createHarness({ safeMode: "smart" });
		const result = await requestNonInteractive(bus, "http", { url: "https://example.com", method: "POST" });
		expect(result).toMatchObject({ block: true });
	});

	test("output-file safeguards stay separate from the network decision", async () => {
		const { bus } = await createHarness({ safeMode: "yolo" });

		// Inside project root in yolo: filesystem allow + trusted network allow.
		expect(
			await askPermTool(bus, "http", { url: "https://example.com", outputFile: "download.txt" }, "yolo"),
		).toMatchObject({ action: "allow" });

		// Outside project root in yolo: filesystem confirm wins over network allow.
		expect(
			await askPermTool(bus, "http", { url: "https://example.com", outputFile: "/tmp/download.txt" }, "yolo"),
		).toMatchObject({ action: "confirm" });

		// http_md to-file spill always requires approval.
		expect(
			await askPermTool(bus, "http_md", { url: "https://example.com", spillMode: "to_file" }, "yolo"),
		).toMatchObject({ action: "confirm" });
	});

	test("network block beats filesystem allow and confirm", async () => {
		const { bus } = await createHarness({ safeMode: "yolo" });
		// Untrusted POST is blocked by allow-trusted even with an in-project output file.
		expect(
			await askPermTool(
				bus,
				"http",
				{ url: "https://example.com", method: "POST", outputFile: "download.txt" },
				"yolo",
			),
		).toMatchObject({ action: "block" });
		// ...and even when the filesystem layer wants a confirmation.
		expect(
			await askPermTool(
				bus,
				"http",
				{ url: "https://example.com", method: "POST", outputFile: "/tmp/download.txt" },
				"yolo",
			),
		).toMatchObject({ action: "block" });
	});

	test("curl-compatible args send the effective method and URL", async () => {
		const { bus } = await createHarness({ safeMode: "smart" });
		expect(await askPermTool(bus, "http", { curlArgs: ["https://example.com"] })).toMatchObject({ action: "allow" });
		expect(await askPermTool(bus, "http", { curlArgs: ["-X", "POST", "https://example.com"] })).toMatchObject({
			action: "confirm",
		});
		expect(await askPermTool(bus, "http", { curlArgs: ["-d", "a=b", "https://example.com"] })).toMatchObject({
			action: "confirm",
		});
		expect(await askPermTool(bus, "http", { curlArgs: ["--url", "https://example.com"] })).toMatchObject({
			action: "allow",
		});
	});

	test("structured body defaults the effective method to POST", async () => {
		const { bus } = await createHarness({ safeMode: "smart" });
		expect(await askPermTool(bus, "http", { url: "https://example.com", json: { a: 1 } })).toMatchObject({
			action: "confirm",
		});
		expect(await askPermTool(bus, "http", { url: "https://example.com", form: { a: "b" } })).toMatchObject({
			action: "confirm",
		});
	});

	test("approval summary reports the effective method", async () => {
		const { bus } = await createHarness({ safeMode: "smart" });
		const structured = await askPermTool(bus, "http", { url: "https://example.com", json: { a: 1 } });
		expect(structured.summary).toBe("POST https://example.com");
		const curl = await askPermTool(bus, "http", { curlArgs: ["-X", "POST", "https://example.com"] });
		expect(curl.summary).toBe("POST https://example.com");
		const web = await askPermTool(bus, "web_search", { query: "pi coding agent" });
		expect(web.summary).toContain("pi coding agent");
	});

	test("summaries redact credentials and strip control characters", async () => {
		const { bus } = await createHarness({ safeMode: "smart" });

		const credentialed = await askPermTool(bus, "http", { url: "https://user:secret@example.com/path" });
		expect(credentialed.action).toBe("block");
		expect(credentialed.summary ?? "").not.toContain("secret");
		expect(credentialed.summary ?? "").not.toContain("user:");

		const control = await askPermTool(bus, "web_search", { query: "a\u0000b\u001fc\u007fd" });
		expect(control.summary ?? "").not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);

		// Structured/curl URL summaries are sanitized too (the malformed URL cannot
		// be parsed, so the userinfo is redacted textually).
		const curlCredentialed = await askPermTool(bus, "http", {
			curlArgs: ["https://token:abcdef@example.com/path"],
		});
		expect(curlCredentialed.summary ?? "").not.toContain("abcdef");
	});

	test("curl output-file safeguards work in yolo", async () => {
		const { bus } = await createHarness({ safeMode: "yolo" });
		expect(
			await askPermTool(bus, "http", { curlArgs: ["-o", "download.txt", "https://example.com"] }, "yolo"),
		).toMatchObject({ action: "allow" });
		expect(
			await askPermTool(bus, "http", { curlArgs: ["-o", "/tmp/download.txt", "https://example.com"] }, "yolo"),
		).toMatchObject({ action: "confirm" });
	});

	test("web_search without a query blocks at preflight", async () => {
		const { bus } = await createHarness({ safeMode: "smart" });
		expect(await askPermTool(bus, "web_search", {})).toMatchObject({ action: "block" });
		expect(await askPermTool(bus, "web_search", { query: "   " })).toMatchObject({ action: "block" });
	});

	test("malformed request under paranoid stays blocked", async () => {
		const { bus, safeMode } = await createHarness({ safeMode: "smart" });
		safeMode.setMode("paranoid");
		expect(await askPermTool(bus, "http", { url: "https://example.com", method: "GE T" })).toMatchObject({
			action: "block",
		});
	});

	test("delayed perm:net provider before the nested timeout is honored", async () => {
		const { bus } = await createHarness({
			core: false,
			safeMode: "yolo",
			beforeSession: (b) => {
				registerNetProvider(b, "slow-ok", "allow", 100);
				b.emit("hub:register", { id: "slow-ok", caps: { provide: ["perm:net"] } });
			},
		});
		expect(await askPermTool(bus, "http", { url: "https://example.com" }, "yolo")).toMatchObject({ action: "allow" });
	});

	test("delayed perm:net provider past the nested timeout fails closed", async () => {
		const { bus } = await createHarness({
			core: false,
			safeMode: "yolo",
			beforeSession: (b) => {
				registerNetProvider(b, "slow-timeout", "allow", 400);
				b.emit("hub:register", { id: "slow-timeout", caps: { provide: ["perm:net"] } });
			},
		});
		expect(await askPermTool(bus, "http", { url: "https://example.com" }, "yolo")).toMatchObject({ action: "block" });
	});
});

describe("http execution requires the one-time authorization handoff", () => {
	test("direct execute with no preflight or hub fails closed", async () => {
		const noHub = await createHarness({ hub: false, safeMode: "yolo" });
		const fetchStub = stubFetch();
		try {
			await expect(
				runTool(noHub.tools, "http", "call-no-hub", { url: "https://example.com" }, noHub.ctx),
			).rejects.toThrow(/Blocked http request/);
			expect(fetchStub.calls).toHaveLength(0);
		} finally {
			fetchStub.restore();
		}
	});

	test("safe-mode absent (hub up, no perm:tool preflight) fails closed", async () => {
		const { tools, ctx } = await createHarness({ safeMode: "yolo" });
		const fetchStub = stubFetch();
		try {
			await expect(
				runTool(tools, "http", "call-no-preflight", { url: "https://example.com" }, ctx),
			).rejects.toThrow(/no authorization/);
			expect(fetchStub.calls).toHaveLength(0);
		} finally {
			fetchStub.restore();
		}
	});

	test("provider allow alone never authorizes execution", async () => {
		const { bus, tools, ctx } = await createHarness({ safeMode: "smart" });
		const fetchStub = stubFetch();
		try {
			const toolCallId = "call-allow-no-handoff";
			expect(
				await askPermTool(bus, "http", { url: "https://example.com" }, "smart", toolCallId),
			).toMatchObject({ action: "allow" });
			// No `px:safe-mode:tool-authorized` event yet.
			await expect(runTool(tools, "http", toolCallId, { url: "https://example.com" }, ctx)).rejects.toThrow(
				/not approved/,
			);
			expect(fetchStub.calls).toHaveLength(0);
		} finally {
			fetchStub.restore();
		}
	});

	test("authorized ticket executes exactly once and cannot be replayed", async () => {
		const { bus, tools, ctx } = await createHarness({ safeMode: "yolo" });
		const fetchStub = stubFetch();
		const toolCallId = "call-once";
		try {
			await askPermTool(bus, "http", { url: "https://example.com" }, "yolo", toolCallId);
			emitToolAuthorized(bus, toolCallId, "http");

			await runTool(tools, "http", toolCallId, { url: "https://example.com" }, ctx);
			expect(fetchStub.calls).toHaveLength(1);

			await expect(runTool(tools, "http", toolCallId, { url: "https://example.com" }, ctx)).rejects.toThrow(
				/no authorization/,
			);
			expect(fetchStub.calls).toHaveLength(1);
		} finally {
			fetchStub.restore();
		}
	});

	test("changed params fail closed even after authorization", async () => {
		const { bus, tools, ctx } = await createHarness({ safeMode: "yolo" });
		const fetchStub = stubFetch();
		const toolCallId = "call-changed";
		try {
			await askPermTool(bus, "http", { url: "https://example.com" }, "yolo", toolCallId);
			emitToolAuthorized(bus, toolCallId, "http");
			await expect(
				runTool(tools, "http", toolCallId, { url: "https://example.com", method: "POST" }, ctx),
			).rejects.toThrow(/changed/);
			expect(fetchStub.calls).toHaveLength(0);
		} finally {
			fetchStub.restore();
		}
	});

	test("denied/non-UI confirmation leaves no authorization to consume", async () => {
		const { bus, tools, ctx } = await createHarness({ safeMode: "smart" });
		const fetchStub = stubFetch();
		const toolCallId = "call-denied";
		try {
			expect(
				await askPermTool(bus, "http", { url: "https://example.com", method: "POST" }, "smart", toolCallId),
			).toMatchObject({ action: "confirm" });
			await expect(
				runTool(tools, "http", toolCallId, { url: "https://example.com", method: "POST" }, ctx),
			).rejects.toThrow(/not approved/);
			expect(fetchStub.calls).toHaveLength(0);
		} finally {
			fetchStub.restore();
		}
	});

	test("web_search must present a matching authorized ticket before fetching", async () => {
		const { bus, tools, ctx } = await createHarness({ safeMode: "smart" });
		const fetchStub = stubFetch();
		try {
			// No preflight at all.
			await expect(runTool(tools, "web_search", "call-search-direct", { query: "pi" }, ctx)).rejects.toThrow(
				/Blocked web_search request/,
			);

			// Preflighted but not authorized.
			const denied = "call-search-denied";
			await askPermTool(bus, "web_search", { query: "pi" }, "smart", denied);
			await expect(runTool(tools, "web_search", denied, { query: "pi" }, ctx)).rejects.toThrow(/not approved/);
			expect(fetchStub.calls).toHaveLength(0);

			// Fresh preflight + safe-mode authorization executes.
			const allowed = "call-search-allowed";
			await askPermTool(bus, "web_search", { query: "pi" }, "smart", allowed);
			emitToolAuthorized(bus, allowed, "web_search");
			await runTool(tools, "web_search", allowed, { query: "pi" }, ctx);
			expect(fetchStub.calls.length).toBeGreaterThan(0);
		} finally {
			fetchStub.restore();
		}
	});

	test("blocked decisions store no ticket at all", async () => {
		const { bus, tools, ctx } = await createHarness({ safeMode: "yolo" });
		const fetchStub = stubFetch();
		const toolCallId = "call-blocked-no-ticket";
		try {
			bus.emit("px:permissions-core:net:state:set", { setting: "deny-all", source: "test" });
			expect(await askPermTool(bus, "http", { url: "https://example.com" }, "yolo", toolCallId)).toMatchObject({
				action: "block",
			});
			// No ticket was stored, so this fails at the "no authorization" check
			// rather than the "not approved" check.
			await expect(runTool(tools, "http", toolCallId, { url: "https://example.com" }, ctx)).rejects.toThrow(
				/no authorization/,
			);
			expect(fetchStub.calls).toHaveLength(0);
		} finally {
			fetchStub.restore();
		}
	});

	test("a timeout handoff before a late provider reply leaves the late ticket unauthorized", async () => {
		const { bus, tools, ctx } = await createHarness({
			core: false,
			safeMode: "yolo",
			beforeSession: (b) => {
				registerNetProvider(b, "slow-allow", "allow", 100);
				b.emit("hub:register", { id: "slow-allow", caps: { provide: ["perm:net"] } });
			},
		});
		const fetchStub = stubFetch();
		const toolCallId = "call-timeout-late";
		try {
			const answer = askPermTool(bus, "http", { url: "https://example.com" }, "yolo", toolCallId);
			// Simulate safe-mode's timeout fallback emitting its own allow while
			// the provider classification is still in flight: no ticket exists yet.
			emitToolAuthorized(bus, toolCallId, "http");
			expect(await answer).toMatchObject({ action: "allow" });

			// The late ticket stored when the provider finally replied must remain
			// unauthorized because the earlier handoff was missed.
			await expect(runTool(tools, "http", toolCallId, { url: "https://example.com" }, ctx)).rejects.toThrow(
				/not approved/,
			);
			expect(fetchStub.calls).toHaveLength(0);
		} finally {
			fetchStub.restore();
		}
	});

	test("a handoff from a source other than safe-mode cannot authorize", async () => {
		const { bus, tools, ctx } = await createHarness({ safeMode: "yolo" });
		const fetchStub = stubFetch();
		try {
			const forged = "call-forged-source";
			await askPermTool(bus, "http", { url: "https://example.com" }, "yolo", forged);
			emitToolAuthorized(bus, forged, "http", "not-safe-mode");
			await expect(runTool(tools, "http", forged, { url: "https://example.com" }, ctx)).rejects.toThrow(
				/not approved/,
			);

			// A missing source is rejected too.
			const missing = "call-missing-source";
			await askPermTool(bus, "http", { url: "https://example.com" }, "yolo", missing);
			bus.emit("px:safe-mode:tool-authorized", { toolCallId: missing, toolName: "http" });
			await expect(runTool(tools, "http", missing, { url: "https://example.com" }, ctx)).rejects.toThrow(
				/not approved/,
			);
			expect(fetchStub.calls).toHaveLength(0);
		} finally {
			fetchStub.restore();
		}
	});

	test("delayed successful classification plus handoff still executes", async () => {
		const { bus, tools, ctx } = await createHarness({
			core: false,
			safeMode: "yolo",
			beforeSession: (b) => {
				registerNetProvider(b, "delayed-ok", "allow", 80);
				b.emit("hub:register", { id: "delayed-ok", caps: { provide: ["perm:net"] } });
			},
		});
		const fetchStub = stubFetch();
		const toolCallId = "call-delayed-ok";
		try {
			expect(
				await askPermTool(bus, "http", { url: "https://example.com" }, "yolo", toolCallId),
			).toMatchObject({ action: "allow" });
			emitToolAuthorized(bus, toolCallId, "http");
			await runTool(tools, "http", toolCallId, { url: "https://example.com" }, ctx);
			expect(fetchStub.calls).toHaveLength(1);
		} finally {
			fetchStub.restore();
		}
	});

	test("changed spillMode invalidates an authorized ticket", async () => {
		const { bus, tools, ctx } = await createHarness({ safeMode: "yolo" });
		const fetchStub = stubFetch();
		const toolCallId = "call-spill-changed";
		try {
			await askPermTool(
				bus,
				"http",
				{ url: "https://example.com", spillMode: "in_memory" },
				"yolo",
				toolCallId,
			);
			emitToolAuthorized(bus, toolCallId, "http");
			await expect(
				runTool(tools, "http", toolCallId, { url: "https://example.com", spillMode: "to_file" }, ctx),
			).rejects.toThrow(/changed/);
			expect(fetchStub.calls).toHaveLength(0);
		} finally {
			fetchStub.restore();
		}
	});

	test("changed webToMdMaxBytes invalidates an authorized ticket", async () => {
		const { bus, tools, ctx } = await createHarness({ safeMode: "yolo" });
		const toolCallId = "call-webmd-changed";
		await askPermTool(bus, "http_md", { url: "https://example.com", webToMdMaxBytes: 1000 }, "yolo", toolCallId);
		emitToolAuthorized(bus, toolCallId, "http_md");
		await expect(
			runTool(tools, "http_md", toolCallId, { url: "https://example.com", webToMdMaxBytes: 2000 }, ctx),
		).rejects.toThrow(/changed/);
	});

	test("session lifecycle events reset the authorization store", async () => {
		const { bus, tools, ctx, lifecycle } = await createHarness({ safeMode: "yolo" });
		const toolCallId = "call-reset";
		const events: Array<{ name: string; event: unknown }> = [
			{ name: "session_start", event: {} },
			{ name: "session_tree", event: {} },
			{ name: "session_before_switch", event: { reason: "new" } },
			{ name: "session_shutdown", event: {} },
		];
		for (const { name, event } of events) {
			await askPermTool(bus, "http", { url: "https://example.com" }, "yolo", toolCallId);
			emitToolAuthorized(bus, toolCallId, "http");
			for (const handler of lifecycle.get(name) ?? []) {
				await handler(event, ctx);
			}
			await expect(runTool(tools, "http", toolCallId, { url: "https://example.com" }, ctx)).rejects.toThrow(
				/no authorization/,
			);
		}
	});

	test("MemoryFS-only reads bypass the authorization gate", async () => {
		const { tools, ctx } = await createHarness({ safeMode: "yolo" });
		// No ticket exists. A MemoryFS read is not a network operation, so it must
		// reach the entry lookup (and fail there for a missing id) rather than the
		// authorization gate.
		await expect(runTool(tools, "http", "call-memfs", { memfs: { id: "missing" } }, ctx)).rejects.toThrow(
			/MemoryFS entry not found/,
		);
	});
});
