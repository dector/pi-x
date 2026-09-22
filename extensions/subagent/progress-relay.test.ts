/**
 * Tests for the child-to-parent progress relay wire helpers.
 *
 * The pure suite covers envelope validation, owner hardening, tool-list
 * injection, and the "never throw out of the parent handler" guarantee. The
 * integration test drives `parseProgressRelay` into the real hub extension to
 * prove a relayed child mutation reaches a parent `hub:progress:changed`
 * snapshot. No production module imports the hub extension; this test-only
 * import is allowed by the plan in `extensions/hub/idea-progress.md` stage 5.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import hubExtension from "../hub/index.ts";
import {
	applyProgressRelay,
	MAX_PROGRESS_RELAY_BYTES,
	parseProgressRelay,
	PROGRESS_RELAY_CHANNELS,
	PROGRESS_RELAY_OWNER,
	PROGRESS_RELAY_STATUS_KEY,
	withProgressGuidance,
	withProgressTool,
	type ProgressRelayChannel,
} from "./progress-relay.ts";

function envelope(channel: ProgressRelayChannel, payload: Record<string, unknown> = {}): string {
	return JSON.stringify({ version: 1, channel, payload });
}

describe("progress relay envelope parsing", () => {
	test("accepts every allowlisted mutation channel", () => {
		for (const channel of PROGRESS_RELAY_CHANNELS) {
			const parsed = parseProgressRelay(envelope(channel, { requestId: "r" }));
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.channel).toBe(channel);
		}
	});

	test("rejects a non-1 version", () => {
		const text = JSON.stringify({ version: 2, channel: "hub:progress:create", payload: {} });
		expect(parseProgressRelay(text)).toEqual({ ok: false, reason: "unsupported-version" });
	});

	test("rejects a channel outside the mutation allowlist", () => {
		for (const channel of ["hub:progress:changed", "hub:progress:ack", "hub:progress:snapshot", "hub:progress:query"]) {
			const text = JSON.stringify({ version: 1, channel, payload: {} });
			expect(parseProgressRelay(text)).toEqual({ ok: false, reason: "unknown-channel" });
		}
	});

	test("rejects malformed JSON without throwing", () => {
		expect(parseProgressRelay("{not json")).toEqual({ ok: false, reason: "malformed-json" });
	});

	test("rejects a non-record payload", () => {
		for (const payload of [[], "text", 42, null]) {
			const text = JSON.stringify({ version: 1, channel: "hub:progress:create", payload });
			expect(parseProgressRelay(text)).toEqual({ ok: false, reason: "invalid-payload" });
		}
	});

	test("rejects non-string statusText", () => {
		for (const value of [undefined, null, 42, {}, ["x"]]) {
			expect(parseProgressRelay(value)).toEqual({ ok: false, reason: "not-a-string" });
		}
	});

	test("rejects oversized text by utf8 byte length", () => {
		const oversized = envelope("hub:progress:create", { blob: "x".repeat(MAX_PROGRESS_RELAY_BYTES) });
		expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(MAX_PROGRESS_RELAY_BYTES);
		expect(parseProgressRelay(oversized)).toEqual({ ok: false, reason: "too-large" });
	});

	test("overwrites a relayed owner instead of trusting the child", () => {
		const parsed = parseProgressRelay(
			envelope("hub:progress:update", { owner: "evil-child", requestId: "r", trackerId: "t1" }),
		);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.payload.owner).toBe(PROGRESS_RELAY_OWNER);
			expect(parsed.payload.requestId).toBe("r");
		}
	});

	test("failure reasons never echo the raw payload", () => {
		const secret = "super-secret-payload-value";
		const parsed = parseProgressRelay(`{"version":1,"channel":"nope","payload":"${secret}"`);
		expect(parsed.ok).toBe(false);
		expect(JSON.stringify(parsed)).not.toContain(secret);
	});
});

describe("progress relay application", () => {
	test("hands a validated mutation to emit", () => {
		const seen: Array<{ channel: string; payload: Record<string, unknown> }> = [];
		const applied = applyProgressRelay(
			envelope("hub:progress:finish", { trackerId: "t1" }),
			(channel, payload) => seen.push({ channel, payload }),
			() => {
				throw new Error("should not report malformed");
			},
		);

		expect(applied).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.channel).toBe("hub:progress:finish");
		expect(seen[0]?.payload.owner).toBe(PROGRESS_RELAY_OWNER);
	});

	test("malformed input reports once and never throws out of the handler", () => {
		let diagnostics = 0;
		const applied = applyProgressRelay(
			"{broken",
			() => {
				throw new Error("emit must not run");
			},
			() => {
				diagnostics += 1;
			},
		);

		expect(applied).toBe(false);
		expect(diagnostics).toBe(1);
	});

	test("a throwing parent listener cannot escape applyProgressRelay", () => {
		expect(() =>
			applyProgressRelay(
				envelope("hub:progress:remove", { trackerId: "t1" }),
				() => {
					throw new Error("parent bus listener exploded");
				},
				() => {},
			),
		).not.toThrow();
	});
});

describe("withProgressTool", () => {
	test("appends progress when the parent has the tool", () => {
		expect(withProgressTool(["read", "grep"], true)).toEqual(["read", "grep", "progress"]);
	});

	test("does not duplicate an existing progress entry", () => {
		const tools = ["progress", "read"];
		const result = withProgressTool(tools, true);
		expect(result).toEqual(["progress", "read"]);
		expect(result).toBe(tools);
	});

	test("preserves an explicit list exactly when progress is unavailable", () => {
		const tools = ["read", "grep", "find", "ls"];
		const result = withProgressTool(tools, false);
		expect(result).toBe(tools);
		expect(result).not.toContain("progress");
	});

	test("leaves absent or empty lists unchanged", () => {
		expect(withProgressTool(undefined, true)).toBeUndefined();
		const empty: string[] = [];
		expect(withProgressTool(empty, true)).toBe(empty);
	});
});

describe("withProgressGuidance", () => {
	test("appends delegated lifecycle rules when progress is available", () => {
		const result = withProgressGuidance("You are a worker.\n", true);

		expect(result).toStartWith("You are a worker.\n\n## Delegated progress reporting\n");
		expect(result).toContain("`trackerId`, `trackerToken`, and `chunkId`");
		expect(result).toContain("mark only that leaf `active`");
		expect(result).toContain("Do not update containers or other leaves");
		expect(result).toContain("Do not start, finish, or clear the parent tracker");
		expect(result).toContain("best-effort");
		expect(result).toContain("never claim that the parent accepted");
		expect(result).toContain("If any of the three identifiers is absent");
	});

	test("leaves the prompt unchanged when progress is unavailable", () => {
		const prompt = "You are a worker.\n";
		expect(withProgressGuidance(prompt, false)).toBe(prompt);
	});

	test("provides guidance even when an agent has no custom prompt", () => {
		expect(withProgressGuidance("", true)).toStartWith("## Delegated progress reporting\n");
	});
});

describe("restrictive shipped agent tool list", () => {
	function plannerFastTools(): string[] {
		const file = readFileSync(new URL("./agents/planner-fast.md", import.meta.url), "utf-8");
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(file);
		const raw = frontmatter.tools;
		const tools = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [])
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean);
		return tools;
	}

	test("receives progress when available and keeps its exact list when absent", () => {
		const tools = plannerFastTools();
		expect(tools.length).toBeGreaterThan(0);
		expect(tools).not.toContain("progress");

		expect(withProgressTool(tools, true)).toEqual([...tools, "progress"]);

		const absent = withProgressTool(tools, false);
		expect(absent).toBe(tools);
		expect(absent).toEqual(tools);
	});
});

// ---------------------------------------------------------------------------
// Integration: relay -> parent hub changed snapshot
// ---------------------------------------------------------------------------

type Emitted = { event: string; payload: unknown };
type EventHandler = (data: unknown) => void;

interface Bus {
	emitted: Emitted[];
	emit(event: string, payload: unknown): void;
	send(event: string, payload: unknown): void;
	on(event: string, handler: EventHandler): () => void;
}

function createBus(): Bus {
	const handlers = new Map<string, Set<EventHandler>>();
	const emitted: Emitted[] = [];
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

function createFakePi(bus: Bus) {
	const lifecycle = new Map<string, PiLifecycle>();
	const pi = {
		events: bus,
		on: (name: string, handler: PiLifecycle) => {
			lifecycle.set(name, handler);
		},
		registerCommand() {},
		registerTool() {},
		registerFlag() {},
		registerShortcut() {},
		appendEntry() {},
		getFlag() {
			return undefined;
		},
		sendUserMessage() {},
	};
	return { pi, lifecycle };
}

/** Emit a child relay exactly as the subagent extension would after parsing. */
function relayIntoHub(bus: Bus, channel: ProgressRelayChannel, payload: Record<string, unknown>): void {
	const parsed = parseProgressRelay(envelope(channel, payload));
	if (!parsed.ok) throw new Error(`test envelope rejected: ${parsed.reason}`);
	bus.send(parsed.channel, parsed.payload);
}

let savedHerdrTab: string | undefined;

beforeEach(() => {
	savedHerdrTab = process.env.PI_HUB_HERDR_TAB;
	process.env.PI_HUB_HERDR_TAB = "0";
});

afterEach(() => {
	if (savedHerdrTab === undefined) delete process.env.PI_HUB_HERDR_TAB;
	else process.env.PI_HUB_HERDR_TAB = savedHerdrTab;
});

describe("relay to parent hub integration", () => {
	test("a relayed child create then update produces changed snapshots", async () => {
		const bus = createBus();
		const { pi, lifecycle } = createFakePi(bus);
		hubExtension(pi as never);
		await lifecycle.get("session_start")?.({}, {});

		relayIntoHub(bus, "hub:progress:create", {
			requestId: "child-1",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: "evil-child",
			title: "Authentication",
			unit: "Stage",
			chunks: [{ id: "a" }, { id: "b" }],
		});

		const created = bus.emitted.filter((entry) => entry.event === "hub:progress:changed").at(-1)?.payload as {
			count: number;
			trackers: Array<{ owner: string; chunks: Array<{ state: string }> }>;
		};
		expect(created.count).toBe(1);
		expect(created.trackers[0]?.owner).toBe(PROGRESS_RELAY_OWNER);

		relayIntoHub(bus, "hub:progress:update", {
			requestId: "child-2",
			trackerId: "t1",
			trackerToken: "tok-1",
			owner: "evil-child",
			chunkId: "a",
			state: "active",
			phase: "reviewing",
		});

		const updated = bus.emitted.filter((entry) => entry.event === "hub:progress:changed").at(-1)?.payload as {
			trackers: Array<{ chunks: Array<{ state: string; phase?: string }> }>;
		};
		expect(updated.trackers[0]?.chunks[0]).toEqual({ index: 1, state: "active", phase: "reviewing" });
	});

	test("the relay status key is the exact wire constant", () => {
		expect(PROGRESS_RELAY_STATUS_KEY).toBe("px:hub-progress-relay");
	});
});
