import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { detectReloadState, gustClient, reloadClient } from "./gust.ts";
import gustExtension from "./index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const submitted =
	'{"id":"t1","path":"/p","text":"x","html":"","locator":"","state":"submitted","messages":[],"createdAt":"c","updatedAt":"u"}';
const seen =
	'{"id":"t1","path":"/p","text":"x","html":"","locator":"","state":"seen","messages":[],"createdAt":"c","updatedAt":"u"}';

test("watch and seen parse ctl output", async () => {
	const script = `/tmp/gust-fake-${process.pid}.sh`;
	const log = `${script}.log`;
	writeFileSync(
		script,
		`#!/usr/bin/env bash
echo "$PWD|$@" >> ${JSON.stringify(log)}
case "$*" in
  *"comments watch"*) echo '{"cursor":7,"comments":[${submitted}]}' ;;
  *"comments seen"*) echo '${seen}' ;;
  *"pause"*) touch "${script}.paused"; echo 'auto_reload: paused' ;;
  *"resume"*) rm -f "${script}.paused"; echo 'auto_reload: active' ;;
  *"status"*) if test -f "${script}.paused"; then echo 'auto_reload: paused'; else echo 'auto_reload: active'; fi ;;
  *) echo '[]' ;;
esac
`,
	);
	chmodSync(script, 0o755);
	process.env.GUST_CMD = script;
	try {
		const snapshot = await gustClient.watch(0);
		expect(snapshot.cursor).toBe(7);
		expect(snapshot.comments[0]?.state).toBe("submitted");

		const claimed = await gustClient.seen("t1");
		expect(claimed.state).toBe("seen");

		const calls = await Bun.file(log).text();
		expect(calls).toContain("comments watch --since 0");
		expect(calls).toContain("comments seen t1");

		const target = { cwd: "/tmp", socket: "/tmp/test-gust.sock" };
		expect(await reloadClient.status(target)).toBe("active");
		expect(await detectReloadState(target)).toBe("active");
		await reloadClient.pause(target);
		expect(await detectReloadState(target)).toBe("paused");
		await reloadClient.resume(target);
		expect(await detectReloadState(target)).toBe("active");
		expect(await detectReloadState({ cwd: `${script}.missing` })).toBeUndefined();
		const controlCalls = await Bun.file(log).text();
		expect(controlCalls).toContain("ctl -S /tmp/test-gust.sock status");
		expect(controlCalls).toContain("ctl -S /tmp/test-gust.sock pause");
		expect(controlCalls).toContain("ctl -S /tmp/test-gust.sock resume");

		// Drive the real registration wiring, including a replacement runtime.
		const commands = new Map<string, any>();
		const events = new Map<string, any>();
		const emitted: Array<{ name: string; payload: unknown }> = [];
		const pi = {
			registerCommand(name: string, command: unknown) { commands.set(name, command); },
			on(name: string, handler: unknown) { events.set(name, handler); },
			events: {
				emit(name: string, payload: unknown) { emitted.push({ name, payload }); },
				on(name: string, handler: unknown) { events.set(name, handler); },
			},
		} as unknown as ExtensionAPI;
		const ctx = { cwd: "/tmp", isIdle: () => true, ui: { notify() {}, setStatus() {} } };
		gustExtension(pi);
		await events.get("px:gust:hold:toggle")({ ctx });
		expect(emitted.at(-1)).toEqual({ name: "px:status-bar:gust-hold:set", payload: { enabled: true, running: true, paused: false } });
		await events.get("px:gust:hold:toggle")({ ctx });
		expect(emitted.at(-1)).toEqual({ name: "px:status-bar:gust-hold:set", payload: { enabled: false, running: true, paused: false } });
		await commands.get("gust").handler("hold", ctx);
		await events.get("before_agent_start")({}, ctx);
		await events.get("agent_start")({}, ctx);
		await events.get("agent_settled")({}, ctx);
		await events.get("session_shutdown")({ reason: "new" }, ctx);
		gustExtension(pi);
		await events.get("session_start")({ reason: "new" }, ctx);
		await events.get("agent_start")({}, ctx);
		await events.get("session_shutdown")({ reason: "quit" }, ctx);
		expect(emitted).toContainEqual({ name: "px:status-bar:gust-hold:set", payload: { enabled: true, running: true, paused: true } });
		expect(emitted.at(-1)).toEqual({ name: "px:status-bar:gust-hold:set", payload: { enabled: false, running: false, paused: false } });
		const lifecycleCalls = (await Bun.file(log).text()).slice(controlCalls.length);
		expect(lifecycleCalls.match(/ctl pause/g)).toHaveLength(2);
		expect(lifecycleCalls.match(/ctl resume/g)).toHaveLength(2);

		const folder = `${script}.docs`;
		mkdirSync(folder);
		try {
			await commands.get("gust").handler(`hold ${folder.slice("/tmp/".length)}`, ctx);
			await events.get("agent_start")({}, ctx);
			await events.get("agent_settled")({}, ctx);
			await events.get("session_shutdown")({ reason: "new" }, ctx);
			gustExtension(pi);
			await events.get("agent_start")({}, ctx);
			await commands.get("gust").handler("hold", ctx);
			await commands.get("px:gust").handler(`hold ${folder}`, ctx);
			await events.get("agent_start")({}, ctx);
			await events.get("session_shutdown")({ reason: "quit" }, ctx);
			const folderCalls = (await Bun.file(log).text()).slice(controlCalls.length + lifecycleCalls.length).trim().split("\n");
			expect(folderCalls.every((line) => line.startsWith(`${folder}|ctl `))).toBe(true);
			expect(folderCalls.filter((line) => line.endsWith("ctl pause"))).toHaveLength(3);
			expect(folderCalls.filter((line) => line.endsWith("ctl resume"))).toHaveLength(3);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
		// A hung detector must not inherit the normal control timeout.
		writeFileSync(script, '#!/usr/bin/env bash\nexec sleep 10\n');
		const detectionStarted = Date.now();
		expect(await detectReloadState(target)).toBeUndefined();
		expect(Date.now() - detectionStarted).toBeLessThan(1_500);
	} finally {
		delete process.env.GUST_CMD;
		delete (globalThis as { __piXGustHold?: unknown }).__piXGustHold;
		rmSync(`${script}.paused`, { force: true });
		rmSync(script, { force: true });
		rmSync(log, { force: true });
	}
});
