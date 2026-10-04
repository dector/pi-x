import { describe, expect, test } from "bun:test";
import { STATUS_BAR_EVENTS } from "./contract.ts";
import { REWIRE_PREVIEW_MS, RewirePreview, resolveRewireDisplay } from "./rewire-preview.ts";

function makeFakeTimer() {
	let nextId = 1;
	const pending = new Map<number, { handler: () => void; ms: number }>();
	const timer = {
		set: (handler: () => void, ms: number) => {
			const id = nextId++;
			pending.set(id, { handler, ms });
			return id;
		},
		clear: (handle: unknown) => {
			pending.delete(handle as number);
		},
	};
	return {
		timer,
		pending,
		/** Fire one pending timeout; returns false when it was already cleared. */
		fire(id: number): boolean {
			const entry = pending.get(id);
			if (!entry) return false;
			pending.delete(id);
			entry.handler();
			return true;
		},
	};
}

describe("RewirePreview", () => {
	test("shows a target and schedules the default 1.5-second timeout", () => {
		const fake = makeFakeTimer();
		let expires = 0;
		const preview = new RewirePreview({ timer: fake.timer, onExpire: () => { expires += 1; } });

		preview.show({ model: "anthropic/claude", thinkingLevel: "high" });

		expect(preview.current).toEqual({ model: "anthropic/claude", thinkingLevel: "high" });
		const scheduled = [...fake.pending.values()];
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]!.ms).toBe(REWIRE_PREVIEW_MS);
		expect(REWIRE_PREVIEW_MS).toBe(1500);
		expect(expires).toBe(0);
	});

	test("expiry clears the preview and notifies the caller once", () => {
		const fake = makeFakeTimer();
		let expires = 0;
		const preview = new RewirePreview({ timer: fake.timer, onExpire: () => { expires += 1; } });
		preview.show({ model: "a/b", thinkingLevel: "low" });
		const id = [...fake.pending.keys()][0]!;

		expect(fake.fire(id)).toBe(true);

		expect(preview.current).toBeUndefined();
		expect(expires).toBe(1);
		// The handle is gone, so a second fire is a no-op.
		expect(fake.fire(id)).toBe(false);
		expect(expires).toBe(1);
	});

	test("repeated changes restart the timeout instead of stacking", () => {
		const fake = makeFakeTimer();
		let expires = 0;
		const preview = new RewirePreview({ timer: fake.timer, onExpire: () => { expires += 1; } });

		preview.show({ model: "a/one", thinkingLevel: "low" });
		const first = [...fake.pending.keys()][0]!;
		preview.show({ model: "a/two", thinkingLevel: "high" });
		const second = [...fake.pending.keys()][0]!;

		expect(first).not.toBe(second);
		expect(fake.pending.size).toBe(1);
		expect(fake.fire(first)).toBe(false);
		expect(preview.current).toEqual({ model: "a/two", thinkingLevel: "high" });

		expect(fake.fire(second)).toBe(true);
		expect(preview.current).toBeUndefined();
		expect(expires).toBe(1);
	});

	test("cancel drops the preview and its timeout without expiring", () => {
		const fake = makeFakeTimer();
		let expires = 0;
		const preview = new RewirePreview({ timer: fake.timer, onExpire: () => { expires += 1; } });
		preview.show({ model: "a/b", thinkingLevel: "low" });
		const id = [...fake.pending.keys()][0]!;

		preview.cancel();

		expect(preview.current).toBeUndefined();
		expect(fake.pending.size).toBe(0);
		expect(fake.fire(id)).toBe(false);
		expect(expires).toBe(0);
	});

	test("cancel is a no-op when nothing is pending", () => {
		const fake = makeFakeTimer();
		const preview = new RewirePreview({ timer: fake.timer, onExpire: () => { throw new Error("must not expire"); } });
		expect(() => preview.cancel()).not.toThrow();
		expect(preview.current).toBeUndefined();
	});
});

describe("resolveRewireDisplay", () => {
	const persistent = { model: "a/live", thinkingLevel: "medium" };
	const preview = { model: "a/preview", thinkingLevel: "high" };

	test("a live preview wins and is muted", () => {
		expect(resolveRewireDisplay(persistent, preview)).toEqual({ target: preview, colorToken: "muted" });
	});

	test("the persistent enabled target is red", () => {
		expect(resolveRewireDisplay(persistent, undefined)).toEqual({ target: persistent, colorToken: "error" });
	});

	test("a preview alone does not imply the persistent enabled state", () => {
		expect(resolveRewireDisplay(undefined, preview)).toEqual({ target: preview, colorToken: "muted" });
	});

	test("nothing to show when both are absent", () => {
		expect(resolveRewireDisplay(undefined, undefined)).toBeUndefined();
	});
});

describe("preview channel contract", () => {
	test("preview is a distinct event from the persistent set/clear channels", () => {
		expect(STATUS_BAR_EVENTS.rewirePreview).toBe("px:status-bar:rewire:preview");
		expect(STATUS_BAR_EVENTS.rewirePreview).not.toBe(STATUS_BAR_EVENTS.rewireSet);
		expect(STATUS_BAR_EVENTS.rewirePreview).not.toBe(STATUS_BAR_EVENTS.rewireClear);
	});
});
