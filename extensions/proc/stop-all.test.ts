import { expect, test } from "bun:test";
import {
	PROC_STOP_ALL_MAX_WAIT_MS,
	PROC_STOP_ALL_REPLY_EVENT,
	PROC_STOP_ALL_REQUEST_EVENT,
	stopAllRunningProcesses,
	validateProcStopAllRequest,
} from "./stop-all.ts";

test("stop-all contract uses stable correlated event names", () => {
	expect(PROC_STOP_ALL_REQUEST_EVENT).toBe("px:proc:stop-all:request");
	expect(PROC_STOP_ALL_REPLY_EVENT).toBe("px:proc:stop-all:reply");
});

test("request validation accepts only a bounded correlation id", () => {
	expect(validateProcStopAllRequest({ id: "reset-1" })).toEqual({ id: "reset-1" });
	for (const invalid of [null, [], {}, { id: "" }, { id: "x".repeat(129) }, { id: 1 }, { id: "a", timeoutMs: 10 }]) {
		expect(validateProcStopAllRequest(invalid)).toBeUndefined();
	}
});

test("signals only running records and reports stopping records as affected", async () => {
	const records = [
		{ name: "live", state: "running" },
		{ name: "already-stopping", state: "stopping" },
		{ name: "done", state: "exited" },
	];
	const calls: string[] = [];
	const resultPromise = stopAllRunningProcesses(
		records,
		(record) => calls.push(record.name),
		async (record) => {
			if (record.name === "live") record.state = "exited";
			if (record.name === "already-stopping") record.state = "exited";
		},
		10,
	);
	// `already-stopping` is waited for but never re-signalled.
	expect(await resultPromise).toEqual({ stopped: ["live", "already-stopping"], timedOut: [] });
	expect(calls).toEqual(["live"]);
});

test("settlement is bounded by the contract maximum", async () => {
	const started = Date.now();
	const result = await stopAllRunningProcesses(
		[{ name: "stuck", state: "running" }],
		() => undefined,
		() => new Promise<void>(() => {}),
		PROC_STOP_ALL_MAX_WAIT_MS + 100,
	);
	expect(result).toEqual({ stopped: [], timedOut: ["stuck"] });
	expect(Date.now() - started).toBeLessThan(PROC_STOP_ALL_MAX_WAIT_MS + 500);
});
