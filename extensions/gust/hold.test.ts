import { expect, test } from "bun:test";
import { ReloadHold } from "./hold.ts";
import type { ReloadClient, ReloadTarget } from "./gust.ts";

const target = { cwd: "/project", socket: "/tmp/gust.sock" };
function setup(initial: "active" | "paused" = "active") {
	const calls: string[] = [];
	let state = initial;
	const client: ReloadClient = {
		async status() { calls.push("status"); return state; },
		async pause() { calls.push("pause"); state = "paused"; },
		async resume() { calls.push("resume"); state = "active"; },
	};
	const settings = { enabled: false };
	return { calls, client, settings, hold: new ReloadHold(client, settings) };
}

test("opt-in leaves idle Gust active; starts coalesce until settle", async () => {
	const { hold, calls } = setup();
	await hold.start(target);
	expect(calls).toEqual([]);
	expect(await hold.toggle(target, false)).toBe(true);
	expect(calls).toEqual(["status"]);
	await hold.start(target);
	await hold.start(target);
	expect(calls).toEqual(["status", "status", "pause", "status"]);
	await hold.settle();
	await hold.settle();
	expect(calls).toEqual(["status", "status", "pause", "status", "resume"]);
	await hold.start(target);
	await hold.settle();
	expect(calls.slice(-3)).toEqual(["status", "pause", "resume"]);
});

test("toggle off while working releases pause and disables future holds", async () => {
	const { hold, calls } = setup();
	await hold.toggle(target, true);
	expect(calls).toEqual(["status", "status", "pause"]);
	expect(await hold.toggle(target, true)).toBe(false);
	await hold.start(target);
	await hold.settle();
	expect(calls.at(-1)).toBe("resume");
	expect(calls.filter(c => c === "pause")).toHaveLength(1);
});

test("never releases a pre-existing manual pause", async () => {
	const { hold, calls } = setup("paused");
	await hold.toggle(target, true);
	await hold.settle();
	await hold.shutdown(true);
	expect(calls).toEqual(["status", "status"]);
});

test("replacement preserves opt-in, quit clears it and releases ownership", async () => {
	const { hold, calls, client, settings } = setup();
	await hold.toggle(target, true);
	await hold.shutdown(false);
	expect(settings.enabled).toBe(true);
	const replacement = new ReloadHold(client, settings);
	await replacement.start(target);
	await replacement.shutdown(true);
	expect(settings.enabled).toBe(false);
	expect(calls.filter(c => c === "resume")).toHaveLength(2);
});

test("a failed resume keeps ownership so cleanup can retry", async () => {
	const { hold, client, calls } = setup();
	await hold.toggle(target, true);
	const resume = client.resume;
	client.resume = async () => { throw new Error("offline"); };
	await expect(hold.settle()).rejects.toThrow("offline");
	client.resume = resume;
	await hold.shutdown(true);
	expect(calls.at(-1)).toBe("resume");
});

test("failed pause response still attempts cleanup", async () => {
	const { hold, client, calls } = setup();
	client.pause = async () => { throw new Error("reply lost"); };
	await expect(hold.toggle(target, true)).rejects.toThrow("reply lost");
	await hold.settle();
	expect(calls.at(-1)).toBe("resume");
});

test("replacement retries ownership after a failed shutdown release", async () => {
	const { hold, client, calls, settings } = setup();
	await hold.toggle(target, true);
	const resume = client.resume;
	client.resume = async () => { throw new Error("offline"); };
	await expect(hold.shutdown(false)).rejects.toThrow("offline");
	client.resume = resume;
	const replacement = new ReloadHold(client, settings);
	await replacement.settle();
	expect(calls.at(-1)).toBe("resume");
	expect(settings.enabled).toBe(true);
});

test("a lost resume reply does not leave the next run unpaused", async () => {
	const { hold, client, calls } = setup();
	await hold.toggle(target, true);
	const resume = client.resume;
	client.resume = async t => { await resume(t); throw new Error("reply lost"); };
	await expect(hold.settle()).rejects.toThrow("reply lost");
	await hold.start(target);
	expect(calls.filter(c => c === "pause")).toHaveLength(2);
});

test("unavailable Gust does not enable the mode", async () => {
	const { hold, client, settings } = setup();
	client.status = async () => { throw new Error("offline"); };
	await expect(hold.toggle(target, false)).rejects.toThrow("offline");
	expect(settings.enabled).toBe(false);
});

test("overlapping start and settle serialize and use captured target", async () => {
	const { hold, client, calls } = setup();
	await hold.toggle(target, false);
	let finish!: () => void;
	client.pause = async () => {
		calls.push("pause");
		await new Promise<void>(resolve => { finish = resolve; });
	};
	let resumed: ReloadTarget | undefined;
	client.resume = async t => { resumed = t; calls.push("resume"); };
	const mutableTarget = { ...target };
	const start = hold.start(mutableTarget);
	await new Promise(resolve => setTimeout(resolve, 0));
	const settle = hold.settle();
	mutableTarget.cwd = "/different";
	finish();
	await Promise.all([start, settle]);
	expect(calls.slice(-2)).toEqual(["pause", "resume"]);
	expect(resumed).toEqual(target);
});
