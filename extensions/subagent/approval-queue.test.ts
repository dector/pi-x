import { expect, test } from "bun:test";
import { ApprovalQueue } from "./approval-queue.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("approval queue serializes dialogs globally", async () => {
	const queue = new ApprovalQueue();
	const order: string[] = [];
	const first = queue.enqueue({ runId: "a", requestId: "1", async run() { order.push("a:start"); await delay(5); order.push("a:end"); return "a"; } });
	const second = queue.enqueue({ runId: "b", requestId: "1", async run() { order.push("b:start"); return "b"; } });
	expect(await Promise.all([first, second])).toEqual(["a", "b"]);
	expect(order).toEqual(["a:start", "a:end", "b:start"]);
});

test("cancelling a run leaves other requests queued", async () => {
	const queue = new ApprovalQueue();
	const first = queue.enqueue({ runId: "a", requestId: "1", run: (signal) => new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("cancelled"), { once: true })) });
	const removed = queue.enqueue({ runId: "a", requestId: "2", async run() { return "wrong"; } });
	const retained = queue.enqueue({ runId: "b", requestId: "1", async run() { return "kept"; } });
	queue.cancelRun("a");
	expect(await first).toBe("cancelled");
	expect(await removed).toBeUndefined();
	expect(await retained).toBe("kept");
});

test("clear cancels the active dialog and drops every queued request", async () => {
	const queue = new ApprovalQueue();
	const active = queue.enqueue({ runId: "a", requestId: "1", run: (signal) => new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("aborted"), { once: true })) });
	const queued = queue.enqueue({ runId: "b", requestId: "1", async run() { return "never"; } });

	queue.clear();

	expect(await active).toBe("aborted");
	expect(await queued).toBeUndefined();

	// The queue is reusable after a shutdown clear.
	const later = queue.enqueue({ runId: "c", requestId: "1", async run() { return "later"; } });
	expect(await later).toBe("later");
});
