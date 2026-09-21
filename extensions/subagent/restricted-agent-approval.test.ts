/**
 * Restricted-agent approval UI tests.
 *
 * Cover the parent-side prompt only: text formatting, the confirm call and its
 * timeout conversion, fail-closed behavior without UI, and the user-wait
 * declare/clear contract around the dialog.
 */

import { describe, expect, test } from "bun:test";
import type { RestrictedAgentApprovalRequest } from "./prepare.ts";
import {
	formatRestrictedAgentApprovalPrompt,
	requestRestrictedAgentApproval,
	type RestrictedAgentApprovalContext,
} from "./restricted-agent-approval.ts";

type Handler = (payload: unknown) => void;
type Emitted = { event: string; payload: unknown };

interface Bus {
	emitted: Emitted[];
	emit(event: string, payload: unknown): void;
	on(event: string, handler: Handler): () => void;
}

/** Event bus with an optional hub that synchronously acks `set`. */
function createBus(hub: boolean): Bus {
	const handlers = new Map<string, Set<Handler>>();
	const emitted: Emitted[] = [];
	return {
		emitted,
		emit(event, payload) {
			emitted.push({ event, payload });
			if (hub && event === "hub:user-wait:set") {
				const parsed = payload as { id: string; owner: string };
				for (const handler of [...(handlers.get("hub:user-wait:ack") ?? [])]) {
					handler({ id: parsed.id, owner: parsed.owner, operation: "set" });
				}
			}
			for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
		},
		on(event, handler) {
			const set = handlers.get(event) ?? new Set<Handler>();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
	};
}

function named(emitted: Emitted[], event: string): Emitted[] {
	return emitted.filter((entry) => entry.event === event);
}

const request: RestrictedAgentApprovalRequest = {
	mode: "parallel",
	restrictedAgents: ["reviewer-ultra-explicit", "worker-strong"],
	patterns: ["*-strong", "*-explicit"],
	alternatives: ["reviewer-fast", "worker-fast"],
};

interface ConfirmCall {
	title: string;
	message: string;
	options: { timeout?: number } | undefined;
}

function createContext(
	answer: boolean | Promise<boolean> = true,
	onCall?: (call: ConfirmCall) => void,
): { ctx: RestrictedAgentApprovalContext; calls: ConfirmCall[] } {
	const calls: ConfirmCall[] = [];
	const ctx: RestrictedAgentApprovalContext = {
		hasUI: true,
		ui: {
			async confirm(title, message, options) {
				const call = { title, message, options };
				calls.push(call);
				onCall?.(call);
				return answer;
			},
		},
	};
	return { ctx, calls };
}

describe("formatRestrictedAgentApprovalPrompt", () => {
	test("lists names, patterns, alternatives, scope, and timeout", () => {
		const prompt = formatRestrictedAgentApprovalPrompt(request, 15);

		expect(prompt.title).toBe("Approve restricted agents?");
		expect(prompt.message).toContain("reviewer-ultra-explicit, worker-strong");
		expect(prompt.message).toContain("*-strong, *-explicit");
		expect(prompt.message).toContain("reviewer-fast, worker-fast");
		expect(prompt.message).toContain("Approval is for this dispatch only and is not remembered.");
		expect(prompt.message).toContain("Auto-denies after 15 seconds without an answer.");
		expect(prompt.label).toBe("restricted agents: reviewer-ultra-explicit, worker-strong");
	});

	test("uses singular wording and names empty alternatives", () => {
		const prompt = formatRestrictedAgentApprovalPrompt(
			{
				mode: "single",
				restrictedAgents: ["reviewer-strong"],
				patterns: ["*-strong"],
				alternatives: [],
			},
			7,
		);

		expect(prompt.title).toBe("Approve restricted agent?");
		expect(prompt.message).toContain("Restricted agent: reviewer-strong");
		expect(prompt.message).toContain("Allowed alternatives: none");
		expect(prompt.message).toContain("Auto-denies after 7 seconds without an answer.");
	});
});

describe("requestRestrictedAgentApproval", () => {
	test("approves via one timed confirm dialog and clears the wait", async () => {
		const bus = createBus(true);
		const { ctx, calls } = createContext(true);

		const approved = await requestRestrictedAgentApproval(request, 15, ctx, bus);

		expect(approved).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.title).toBe("Approve restricted agents?");
		expect(calls[0]?.options).toEqual({ timeout: 15_000 });
		expect(named(bus.emitted, "hub:user-wait:set")).toHaveLength(1);
		expect(named(bus.emitted, "hub:user-wait:clear")).toHaveLength(1);
		expect(named(bus.emitted, "herdr:blocked")).toHaveLength(0);

		const set = named(bus.emitted, "hub:user-wait:set")[0]!.payload as { kind?: string; owner: string };
		expect(set).toMatchObject({ owner: "subagent", kind: "approval" });
	});

	test("returns false when the user denies", async () => {
		const bus = createBus(true);
		const { ctx, calls } = createContext(false);

		expect(await requestRestrictedAgentApproval(request, 15, ctx, bus)).toBe(false);
		expect(calls).toHaveLength(1);
		expect(named(bus.emitted, "hub:user-wait:clear")).toHaveLength(1);
	});

	test("returns false when the dialog times out (late false)", async () => {
		const bus = createBus(true);
		let release!: (value: boolean) => void;
		const pending = new Promise<boolean>((resolve) => {
			release = resolve;
		});
		const { ctx } = createContext(pending);

		const result = requestRestrictedAgentApproval(request, 15, ctx, bus);
		release(false);

		expect(await result).toBe(false);
		expect(named(bus.emitted, "hub:user-wait:clear")).toHaveLength(1);
	});

	test("converts the timeout from seconds to milliseconds", async () => {
		const bus = createBus(true);
		const { ctx, calls } = createContext(true);

		await requestRestrictedAgentApproval(request, 2.5, ctx, bus);

		expect(calls[0]?.options).toEqual({ timeout: 2500 });
	});

	test("returns false without a dialog or wait when UI is unavailable", async () => {
		const bus = createBus(true);
		const { ctx, calls } = createContext(true);
		ctx.hasUI = false;

		expect(await requestRestrictedAgentApproval(request, 15, ctx, bus)).toBe(false);
		expect(calls).toHaveLength(0);
		expect(bus.emitted).toHaveLength(0);
	});

	test("prompts again for a second dispatch (allow-once, no session cache)", async () => {
		const bus = createBus(true);
		const { ctx, calls } = createContext(true);

		expect(await requestRestrictedAgentApproval(request, 15, ctx, bus)).toBe(true);
		expect(await requestRestrictedAgentApproval(request, 15, ctx, bus)).toBe(true);

		expect(calls).toHaveLength(2);
		expect(named(bus.emitted, "hub:user-wait:set")).toHaveLength(2);
		expect(named(bus.emitted, "hub:user-wait:clear")).toHaveLength(2);
	});

	test("returns false without touching the UI when ctx is missing", async () => {
		const bus = createBus(true);

		expect(await requestRestrictedAgentApproval(request, 15, undefined, bus)).toBe(false);
		expect(bus.emitted).toHaveLength(0);
	});

	test("falls back to herdr:blocked when the hub is absent", async () => {
		const bus = createBus(false);
		const { ctx } = createContext(true);

		await requestRestrictedAgentApproval(request, 15, ctx, bus);

		expect(named(bus.emitted, "hub:user-wait:set")).toHaveLength(1);
		expect(named(bus.emitted, "hub:user-wait:clear")).toHaveLength(0);
		expect(named(bus.emitted, "herdr:blocked").map((entry) => entry.payload)).toEqual([
			{ active: true, label: "restricted agents: reviewer-ultra-explicit, worker-strong" },
			{ active: false },
		]);
	});

	test("clears the wait when the dialog throws", async () => {
		const bus = createBus(true);
		const ctx: RestrictedAgentApprovalContext = {
			hasUI: true,
			ui: {
				confirm: async () => {
					throw new Error("dialog failed");
				},
			},
		};

		await expect(requestRestrictedAgentApproval(request, 15, ctx, bus)).rejects.toThrow("dialog failed");
		expect(named(bus.emitted, "hub:user-wait:clear")).toHaveLength(1);
	});
});
