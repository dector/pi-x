import { expect, test } from "bun:test";
import { combineAbortSignals, interpolatePrevious, mapWithConcurrencyLimit } from "./execution.ts";

test("parallel mapping preserves input order and limits concurrency", async () => {
	let active = 0;
	let peak = 0;
	const results = await mapWithConcurrencyLimit([30, 5, 15, 1], 2, async (delay, index) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, delay));
		active--;
		return `result-${index}`;
	});
	expect(peak).toBe(2);
	expect(results).toEqual(["result-0", "result-1", "result-2", "result-3"]);
});

test("chain interpolation replaces every previous placeholder", () => {
	expect(interpolatePrevious("before {previous} after {previous}", "value")).toBe("before value after value");
});

test("combineAbortSignals aborts when any source aborts", () => {
	const first = new AbortController();
	const second = new AbortController();
	const combined = combineAbortSignals(first.signal, second.signal);
	expect(combined?.aborted).toBe(false);
	second.abort();
	expect(combined?.aborted).toBe(true);
});

test("combineAbortSignals returns the single signal and undefined for none", () => {
	const only = new AbortController();
	expect(combineAbortSignals(only.signal)).toBe(only.signal);
	expect(combineAbortSignals(undefined)).toBeUndefined();
});

test("combineAbortSignals is already aborted when a source is", () => {
	const aborted = new AbortController();
	aborted.abort();
	const combined = combineAbortSignals(aborted.signal, new AbortController().signal);
	expect(combined?.aborted).toBe(true);
});
