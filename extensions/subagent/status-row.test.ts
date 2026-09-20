import { expect, test } from "bun:test";
import {
	formatSubagentStatusRow,
	StatusBarPresence,
	SUBAGENT_STATUS_ROW_ORDER,
} from "./status-row.ts";

test("subagent status row is hidden when nothing is running", () => {
	expect(formatSubagentStatusRow(0)).toBeUndefined();
	expect(formatSubagentStatusRow(-1)).toBeUndefined();
	expect(formatSubagentStatusRow(Number.NaN)).toBeUndefined();
});

test("subagent status row reports the running count with correct pluralization", () => {
	expect(formatSubagentStatusRow(1)).toContain("1 subagent running");
	expect(formatSubagentStatusRow(2)).toContain("2 subagents running");
	expect(formatSubagentStatusRow(2.9)).toContain("2 subagents running");
});

test("subagent status row sorts above proc's order", () => {
	expect(SUBAGENT_STATUS_ROW_ORDER).toBeLessThan(100);
});

function makeHarness() {
	let nextHandle = 1;
	const pending = new Map<number, () => void>();
	let pings = 0;
	let warnings = 0;
	const presence = new StatusBarPresence({
		delayMs: 500,
		timers: {
			set(fn) {
				const handle = nextHandle++;
				pending.set(handle, fn);
				return handle;
			},
			clear(handle) {
				pending.delete(handle as number);
			},
		},
		onPing: () => {
			pings += 1;
		},
		onWarn: () => {
			warnings += 1;
		},
	});
	return {
		presence,
		fire: () => {
			const callbacks = [...pending.values()];
			pending.clear();
			for (const callback of callbacks) callback();
		},
		pending: () => pending.size,
		pings: () => pings,
		warnings: () => warnings,
	};
}

test("presence watch pings once and warns once when no pong arrives", () => {
	const harness = makeHarness();
	harness.presence.watch();
	harness.presence.watch();
	expect(harness.pings()).toBe(1);
	expect(harness.pending()).toBe(1);
	harness.fire();
	expect(harness.warnings()).toBe(1);
	harness.presence.watch();
	expect(harness.warnings()).toBe(1);
});

test("presence cancel disarms the warning when the run finishes first", () => {
	const harness = makeHarness();
	harness.presence.watch();
	harness.presence.cancel();
	expect(harness.pending()).toBe(0);
	harness.fire();
	expect(harness.warnings()).toBe(0);
});

test("presence pong disarms the warning", () => {
	const harness = makeHarness();
	harness.presence.watch();
	harness.presence.markAvailable();
	expect(harness.pending()).toBe(0);
	harness.fire();
	expect(harness.warnings()).toBe(0);
	harness.presence.watch();
	expect(harness.pings()).toBe(1);
});

test("presence reset re-arms a new session", () => {
	const harness = makeHarness();
	harness.presence.watch();
	harness.fire();
	expect(harness.warnings()).toBe(1);
	harness.presence.reset();
	harness.presence.watch();
	harness.fire();
	expect(harness.warnings()).toBe(2);
});
