import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate real stream monkey-patches and argv from Bun's runner and other suites.
const script = `
import assert from "node:assert/strict";
import focusModeExtension from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
import { loadGlobalState } from ${JSON.stringify(join(import.meta.dir, "state.ts"))};
const scenario = JSON.parse(process.env.FOCUS_TEST_SCENARIO);
process.argv = ["bun", scenario.embedded ? "sdk-host.js" : "pi", ...scenario.args];
Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
Object.defineProperty(process.stdout, "columns", { configurable: true, writable: true, value: 240 });
const writes = [], inputs = [], resizes = [];
const write = process.stdout.write = (chunk) => { writes.push(chunk); return true; };
const emit = process.stdin.emit = (event, chunk) => { inputs.push([event, chunk]); return true; };
process.stdout.emit = (event) => { resizes.push(event); return true; };
let timers = 0, cleared = 0;
const setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
globalThis.setTimeout = (...args) => { timers++; return setTimer(...args); };
globalThis.clearTimeout = (...args) => { cleared++; return clearTimer(...args); };
const ctx = {
  mode: scenario.mode, hasUI: true,
  ui: { notify: (message, type) => notices.push({ message, type }), custom: () => { throw Error("unexpected custom UI"); } },
};
const notices = [];
function fixture() {
  const handlers = new Map(), commands = new Map(), bus = new Map(), published = [];
  focusModeExtension({
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, command) => commands.set(name, command),
    events: { on: (name, fn) => bus.set(name, fn), emit: (name, payload) => published.push({ name, payload }) },
  });
  return {
    start: () => handlers.get("session_start")({}, ctx),
    shutdown: () => handlers.get("session_shutdown")({}, ctx),
    command: (args) => commands.get("px:focus").handler(args, ctx),
    toggle: () => bus.get("px:focus-mode:toggle")({ ctx }), published,
  };
}
function untouched() {
  assert.equal(process.stdout.write, write);
  assert.equal(process.stdin.emit, emit);
  assert.deepEqual(Object.getOwnPropertyDescriptor(process.stdout, "columns"), { configurable: true, enumerable: false, writable: true, value: 240 });
}
const f = fixture();
if (scenario.mode !== "tui") {
  untouched(); // No setup even before session_start, including RPC under a PTY.
  await f.start();
  untouched();
  const resizeCount = resizes.length;
  await f.command("set 120/-50");
  assert.equal(loadGlobalState().state.width, 120);
  assert.equal(loadGlobalState().state.bias, -50);
  await f.command("-s set 90/100");
  assert.equal(loadGlobalState().state.width, 120);
  await f.command("status");
  assert.match(notices.at(-1).message, /on=true width=90 bias=100.*not applied/);
  await f.command("config");
  assert.match(notices.at(-1).message, /config needs an interactive terminal/);
  f.toggle();
  assert.deepEqual(f.published.at(-1).payload, { enabled: false, width: 90, bias: 100 });
  assert.equal(loadGlobalState().state.enabled, false);
  assert.equal(f.published[0].name, "px:focus-mode:state");
  untouched();
  const record = '{"type":"response","text":"hi"}\\n';
  process.stdout.write(record);
  assert.equal(writes.at(-1), record);
  const mouse = "\\x1b[<0;100;4M";
  process.stdin.emit("data", mouse);
  assert.equal(inputs.at(-1)[1], mouse);
  assert.equal(resizes.length, resizeCount);
  assert.equal(timers, 0);
  await f.shutdown(); await f.shutdown();
  untouched();
} else {
  // The first frame precedes session_start in Pi v1.0.1.
  assert.equal(process.stdout.columns, 100);
  const frame = "\\x1b[1;1Hhello";
  process.stdout.write(frame);
  assert.equal(writes.at(-1), "\\x1b[1;71Hhello");
  process.stdin.emit("data", "\\x1b[<0;100;4M");
  assert.equal(inputs.at(-1)[1], "\\x1b[<0;30;4M");
  const count = resizes.length;
  await f.start(); await f.start();
  assert.equal(resizes.length, count);
  // A second factory shares rather than stacks the process patch.
  const reloaded = fixture();
  process.stdout.write(frame);
  assert.equal(writes.at(-1), "\\x1b[1;71Hhello");
  await reloaded.start();
  await reloaded.command("bias 50"); // margin-only repaint timer
  assert.equal(timers, 1);
  await reloaded.shutdown(); await reloaded.shutdown();
  assert.equal(cleared, 1);
  untouched();
  // Reload after shutdown installs afresh, using the saved preference.
  const fresh = fixture();
  assert.equal(process.stdout.columns, 100);
  process.stdout.write(frame);
  assert.equal(writes.at(-1), "\\x1b[1;106Hhello");
  await fresh.start();
  await fresh.command("off");
  process.stdout.write(frame);
  assert.equal(writes.at(-1), frame);
  await fresh.command("on 120");
  assert.equal(process.stdout.columns, 120);
  await fresh.shutdown();
  untouched();
}
`;

for (const scenario of [
	{ mode: "rpc", args: ["--mode", "rpc"] },
	{ mode: "rpc", args: ["--mode=rpc"] },
	{ mode: "json", args: ["--mode", "json"] },
	{ mode: "print", args: ["--print"] },
	{ mode: "print", args: ["-p"] },
	{ mode: "rpc", args: [], embedded: true },
	{ args: ["--mode", "rpc"] },
	{ mode: "tui", args: [] },
	{ mode: "tui", args: ["--mode", "text"] },
	{ mode: "tui", args: ["--", "--mode", "rpc", "--print"] },
]) {
	test(`TTY streams: ${JSON.stringify(scenario)}`, () => {
		const root = mkdtempSync(join(tmpdir(), "focus-mode-stdio-"));
		try {
			const result = spawnSync(process.execPath, ["--eval", script], {
				env: { ...process.env, PI_FOCUS_MODE_STATE_PATH: join(root, "state.json"), FOCUS_TEST_SCENARIO: JSON.stringify(scenario) },
				encoding: "utf8", timeout: 10_000,
			});
			expect(result.stderr).toBe("");
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
