import { expect, test } from "bun:test";
import { Orchestrator } from "./orchestrator.ts";
import type { GustClient } from "./gust.ts";
import type { Thread } from "./types.ts";

const thread: Thread = { id: "t1", text: "root request", path: "/", html: "", locator: "", state: "submitted", messages: [], createdAt: "", updatedAt: "" };
function client(): GustClient {
	let first = true;
	return {
		async listThreads() { return [thread]; },
		async seen() { return { ...thread, state: "seen" }; },
		async watch(_cursor, signal) {
			if (first) { first = false; return { cursor: 1, comments: [thread] }; }
			return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
		},
		reply: async () => thread, review: async () => thread, done: async () => thread,
		invocationLabel: () => "gust", socketLabel: () => "",
	};
}
async function waitFor(predicate: () => boolean) {
	for (let i = 0; i < 100; i++) { if (predicate()) return; await Bun.sleep(5); }
	throw new Error("timed out");
}

test("list is available before process starts and subscriptions repaint activity and stop", async () => {
	const worker = new Orchestrator("/tmp", client(), async (options) => {
		options.onActivity?.({ kind: "text", text: "partial output" });
		return new Promise((resolve) => options.signal.addEventListener("abort", () => resolve({ code: 124 }), { once: true }));
	});
	await worker.loadThreads();
	expect(worker.isRunning()).toBe(false);
	expect(worker.monitorThreads()[0].text).toBe("root request");
	expect(worker.activity("t1").state).toBe("idle");
	let notified = 0;
	const unsubscribe = worker.subscribe(() => { notified++; });
	worker.start();
	await waitFor(() => worker.activity("t1").entries.length > 0);
	expect(worker.activity("t1").state).toBe("running");
	await worker.stop();
	expect(worker.activity("t1").state).toBe("stopped");
	expect(worker.activity("t1").entries[0].text).toBe("partial output");
	expect(notified).toBeGreaterThan(3);
	unsubscribe();
});

test("dispatch and missing model failures are visible in history", async () => {
	for (const modelFailure of [false, true]) {
		const worker = new Orchestrator("/tmp", client(), async () => { throw new Error("worker failed"); }, modelFailure ? () => { throw new Error("no foreground model"); } : undefined);
		worker.start();
		await waitFor(() => worker.status().failed === 1);
		await worker.stop();
		expect(worker.activity("t1").state).toBe("failed");
		expect(worker.activity("t1").entries.at(-1)?.text).toContain(modelFailure ? "no foreground model" : "worker failed");
	}
});
