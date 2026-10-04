import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import statusBarExtension, { buildFirstLineTokenLabel, buildFrameContextParts } from "./index.ts";

function fixture() {
	let entries: Record<string, unknown>[] = [];
	let leafId: string | null = null;
	let sessionId = "session-a";
	let traversals = 0;
	const manager = {
		getSessionId: () => sessionId,
		getLeafId: () => leafId,
		getBranch: () => { traversals++; return entries; },
	};
	const ctx = {
		hasUI: false,
		sessionManager: manager,
		getContextUsage: () => ({ percent: 10, tokens: 100 }),
		model: { provider: "anthropic" },
	} as unknown as ExtensionContext;
	return {
		ctx,
		get traversals() { return traversals; },
		setBranch(next: Record<string, unknown>[], leaf = "leaf", session = sessionId) {
			entries = next; leafId = leaf; sessionId = session;
		},
	};
}

const assistant = (input: number, cost: number) => ({
	type: "message", message: { role: "assistant", usage: { input, output: 50, cacheRead: 25, cost: { total: cost } } },
});
const details = (cost: number, messages: unknown[] = []) => ({ results: [{ usage: { cost }, messages }] });
const theme = { fg: (_token: unknown, text: string) => text };

function handlers() {
	const registered = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void>>>();
	statusBarExtension({
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
			registered.set(event, [...(registered.get(event) ?? []), handler]);
		},
		events: { on() {}, emit() {} }, registerCommand() {},
	} as unknown as ExtensionAPI);
	return registered;
}

test("footer and editor accesses share one traversal; model presentation does not invalidate totals", () => {
	const f = fixture();
	f.setBranch([assistant(100, 0.01)]);
	for (let i = 0; i < 10; i++) {
		expect(buildFirstLineTokenLabel(f.ctx, theme)).toContain("↑100/↓50/25");
		expect(buildFrameContextParts(f.ctx).cost).toContain("0.01");
	}
	f.ctx.model = { provider: "other" } as ExtensionContext["model"];
	buildFirstLineTokenLabel(f.ctx, theme);
	buildFrameContextParts(f.ctx);
	expect(f.traversals).toBe(1);
});

test("message completion invalidates, and persistence after the handler advances the cache key", async () => {
	const f = fixture();
	const registered = handlers();
	buildFrameContextParts(f.ctx);
	// Pi dispatches message_end before appending the finalized message.
	await registered.get("message_end")![0]({}, f.ctx);
	buildFrameContextParts(f.ctx);
	f.setBranch([assistant(200, 0.02)], "completed");
	expect(buildFirstLineTokenLabel(f.ctx, theme)).toContain("↑200/↓50/25");
	expect(buildFrameContextParts(f.ctx).cost).toContain("0.02");
	expect(f.traversals).toBe(3);
});

test("async custom entries and blocking results include nested subagent costs without a completion event", () => {
	const f = fixture();
	const base = [assistant(100, 0.01)];
	f.setBranch(base, "assistant");
	buildFrameContextParts(f.ctx);
	f.setBranch([...base, {
		type: "custom_message", customType: "subagent-completion",
		details: details(0.02, [{ role: "toolResult", details: details(0.003) }]),
	}, {
		type: "message", message: { role: "toolResult", details: details(0.004) },
	}], "async-completion");
	expect(buildFrameContextParts(f.ctx).cost).toBe("󰇁\u200b0.01 · 󰇁\u200b󰇁\u200b0.037");
	buildFirstLineTokenLabel(f.ctx, theme);
	expect(f.traversals).toBe(2);
});

test("session identity and manager identity isolate otherwise identical leaves", () => {
	const f = fixture();
	f.setBranch([assistant(100, 0.01)]);
	buildFrameContextParts(f.ctx);
	f.setBranch([assistant(300, 0.03)], "leaf", "session-b");
	expect(buildFirstLineTokenLabel(f.ctx, theme)).toContain("↑300");
	const other = fixture();
	other.setBranch([assistant(400, 0.04)]);
	expect(buildFirstLineTokenLabel(other.ctx, theme)).toContain("↑400");
	expect(f.traversals).toBe(2);
	expect(other.traversals).toBe(1);
});

test("lifecycle invalidation covers tree, compact, switch/fork session_start, and shutdown", async () => {
	const registered = handlers();
	for (const [event, reason] of [
		["session_tree", undefined], ["session_compact", undefined],
		["session_start", "resume"], ["session_start", "fork"], ["session_shutdown", undefined],
	]) {
		const f = fixture();
		f.setBranch([assistant(100, 0.01)]);
		buildFrameContextParts(f.ctx);
		// Hold the key stable to prove explicit lifecycle invalidation as well.
		f.setBranch([assistant(500, 0.05)]);
		await registered.get(event!)![0]({ reason }, f.ctx);
		expect(buildFirstLineTokenLabel(f.ctx, theme)).toContain("↑500");
		buildFrameContextParts(f.ctx);
		expect(f.traversals).toBe(2);
	}
});
