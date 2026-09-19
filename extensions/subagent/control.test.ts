import { expect, test } from "bun:test";
import { PauseGate } from "./control.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("pause gate waits at a boundary and resumes idempotently", async () => {
	const states: string[] = [];
	const gate = new PauseGate((state) => states.push(state));
	gate.requestPause();
	gate.requestPause();
	let passed = false;
	const waiting = gate.waitAtBoundary().then(() => { passed = true; });
	await tick();
	expect(gate.state).toBe("paused");
	expect(passed).toBe(false);
	gate.resume();
	gate.resume();
	await waiting;
	expect(passed).toBe(true);
	expect(states).toEqual(["pause-requested", "paused", "running"]);
});

test("abort releases paused waiters", async () => {
	const gate = new PauseGate();
	gate.requestPause();
	const waiting = gate.waitAtBoundary();
	gate.abort();
	await expect(waiting).resolves.toBeUndefined();
	expect(gate.state).toBe("running");
});
