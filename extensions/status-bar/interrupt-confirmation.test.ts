import { describe, expect, test } from "bun:test";
import { createProtectedInterrupt, InterruptConfirmationGuard } from "./interrupt-confirmation";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("InterruptConfirmationGuard", () => {
	test("does not consume an interrupt while idle", () => {
		let confirms = 0;
		const guard = new InterruptConfirmationGuard({
			getOperationToken: () => undefined,
			confirm: async () => {
				confirms += 1;
				return true;
			},
		});

		expect(guard.request(() => {})).toBe(false);
		expect(confirms).toBe(0);
	});

	test("interrupts active work only after confirmation", async () => {
		const operation = new AbortController().signal;
		let interrupts = 0;
		const confirmation = deferred<boolean>();
		const guard = new InterruptConfirmationGuard({
			getOperationToken: () => operation,
			confirm: () => confirmation.promise,
		});

		expect(guard.request(() => interrupts++)).toBe(true);
		expect(interrupts).toBe(0);
		confirmation.resolve(true);
		await flush();
		expect(interrupts).toBe(1);
	});

	test("coalesces repeated interrupt requests and interrupts once", async () => {
		const operation = new AbortController().signal;
		let confirms = 0;
		let interrupts = 0;
		const confirmation = deferred<boolean>();
		const guard = new InterruptConfirmationGuard({
			getOperationToken: () => operation,
			confirm: () => {
				confirms += 1;
				return confirmation.promise;
			},
		});

		expect(guard.request(() => interrupts++)).toBe(true);
		expect(guard.request(() => interrupts++)).toBe(true);
		expect(confirms).toBe(1);
		confirmation.resolve(true);
		await flush();
		expect(interrupts).toBe(1);
	});

	test("does not interrupt if the operation settles before confirmation", async () => {
		let operation: object | undefined = new AbortController().signal;
		let interrupts = 0;
		const confirmation = deferred<boolean>();
		const guard = new InterruptConfirmationGuard({
			getOperationToken: () => operation,
			confirm: () => confirmation.promise,
		});

		guard.request(() => interrupts++);
		operation = undefined;
		confirmation.resolve(true);
		await flush();
		expect(interrupts).toBe(0);
	});

	test("does not interrupt newer work after the original operation settles", async () => {
		let operation: object | undefined = new AbortController().signal;
		let interrupts = 0;
		const confirmation = deferred<boolean>();
		const guard = new InterruptConfirmationGuard({
			getOperationToken: () => operation,
			confirm: () => confirmation.promise,
		});

		guard.request(() => interrupts++);
		operation = new AbortController().signal;
		confirmation.resolve(true);
		await flush();
		expect(interrupts).toBe(0);
	});

	test("resets after success so a later operation can be confirmed", async () => {
		let operation: object | undefined = new AbortController().signal;
		let interrupts = 0;
		const guard = new InterruptConfirmationGuard({
			getOperationToken: () => operation,
			confirm: async () => true,
		});

		guard.request(() => interrupts++);
		await flush();
		operation = new AbortController().signal;
		expect(guard.request(() => interrupts++)).toBe(true);
		await flush();
		expect(interrupts).toBe(2);
	});

	test("treats a rejected dialog as declined and allows another request", async () => {
		const operation = new AbortController().signal;
		let confirms = 0;
		const first = deferred<boolean>();
		const guard = new InterruptConfirmationGuard({
			getOperationToken: () => operation,
			confirm: () => {
				confirms += 1;
				return first.promise;
			},
		});

		guard.request(() => {});
		first.reject(new Error("dialog closed"));
		await flush();
		expect(guard.request(() => {})).toBe(true);
		expect(confirms).toBe(2);
	});
});

describe("createProtectedInterrupt", () => {
	test("delegates to pi's native handler exactly once while idle", () => {
		let nativeInterrupts = 0;
		const guard = new InterruptConfirmationGuard({
			getOperationToken: () => undefined,
			confirm: async () => true,
		});
		const interrupt = createProtectedInterrupt(() => nativeInterrupts++, guard);

		interrupt();
		expect(nativeInterrupts).toBe(1);
	});

	test("suppresses pi's native handler until active work is confirmed", async () => {
		const operation = new AbortController().signal;
		let nativeInterrupts = 0;
		const confirmation = deferred<boolean>();
		const guard = new InterruptConfirmationGuard({
			getOperationToken: () => operation,
			confirm: () => confirmation.promise,
		});
		const interrupt = createProtectedInterrupt(() => nativeInterrupts++, guard);

		interrupt();
		expect(nativeInterrupts).toBe(0);
		confirmation.resolve(true);
		await flush();
		expect(nativeInterrupts).toBe(1);
	});
});
