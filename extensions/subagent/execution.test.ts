import { expect, test } from "bun:test";
import { interpolatePrevious, mapWithConcurrencyLimit } from "./execution.ts";

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
