import { expect, test } from "bun:test";
import { abortError, raceWithAbort, RunStopController, throwIfAborted } from "./run-stop.ts";

function fakeClock(): { timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }; fire(): void; cleared: unknown[] } {
	let scheduled: (() => void) | undefined;
	const cleared: unknown[] = [];
	return {
		timers: {
			set(fn) {
				scheduled = fn;
				return "timer-1";
			},
			clear(handle) {
				cleared.push(handle);
				scheduled = undefined;
			},
		},
		fire() {
			const fn = scheduled;
			scheduled = undefined;
			fn?.();
		},
		cleared,
	};
}

test("first stop aborts cooperatively and schedules bounded escalation", () => {
	const calls: string[] = [];
	const clock = fakeClock();
	const controller = new RunStopController(
		{ requestAbort: () => calls.push("abort"), terminate: () => { calls.push("terminate"); } },
		{ graceMs: 100, timers: clock.timers },
	);

	controller.request();

	expect(calls).toEqual(["abort"]);
	expect(controller.stopped).toBe(true);
	expect(controller.escalating).toBe(false);

	clock.fire();

	expect(calls).toEqual(["abort", "terminate"]);
	expect(controller.escalating).toBe(true);
});

test("a repeated stop escalates immediately instead of becoming a no-op", () => {
	const calls: string[] = [];
	const clock = fakeClock();
	const controller = new RunStopController(
		{ requestAbort: () => calls.push("abort"), terminate: () => { calls.push("terminate"); } },
		{ graceMs: 100, timers: clock.timers },
	);

	controller.request();
	controller.request();

	expect(calls).toEqual(["abort", "terminate"]);
	expect(controller.escalating).toBe(true);
});

test("a cooperative-abort failure escalates immediately and a third stop is idempotent", () => {
	const calls: string[] = [];
	const controller = new RunStopController(
		{
			requestAbort: () => {
				throw new Error("stdin closed");
			},
			terminate: () => { calls.push("terminate"); },
		},
		{ graceMs: 100, timers: fakeClock().timers },
	);

	controller.request();
	controller.request();
	controller.request();

	expect(calls).toEqual(["terminate"]);
});

test("dispose clears the pending escalation timer", () => {
	const clock = fakeClock();
	const calls: string[] = [];
	const controller = new RunStopController(
		{ requestAbort: () => calls.push("abort"), terminate: () => { calls.push("terminate"); } },
		{ graceMs: 100, timers: clock.timers },
	);

	controller.request();
	controller.dispose();
	clock.fire();

	expect(calls).toEqual(["abort"]);
	expect(clock.cleared).toEqual(["timer-1"]);
});

test("throwIfAborted only throws for an aborted signal", () => {
	expect(() => throwIfAborted(undefined)).not.toThrow();
	expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
	const controller = new AbortController();
	controller.abort();
	expect(() => throwIfAborted(controller.signal)).toThrow("aborted");
});

test("raceWithAbort rejects on abort without leaking an unhandled rejection", async () => {
	const controller = new AbortController();
	let rejectLate!: (error: Error) => void;
	const late = new Promise<string>((_resolve, reject) => {
		rejectLate = reject;
	});
	const raced = raceWithAbort(late, controller.signal);
	controller.abort();
	await expect(raced).rejects.toThrow("aborted");
	rejectLate(abortError("late timeout"));
	// Give the rejection a turn to surface if it were unhandled.
	await new Promise((resolve) => setTimeout(resolve, 0));
});

test("raceWithAbort resolves the original value when the signal never fires", async () => {
	expect(await raceWithAbort(Promise.resolve("ok"), new AbortController().signal)).toBe("ok");
});
