import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Isolate globals, stream spies, and debounce clock from other pi-ui suites.
const script = `
import assert from "node:assert/strict";
import extension from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
const scenario = JSON.parse(process.env.BELL_SCENARIO);
if (scenario.pty) {
  assert.equal(process.stdout.isTTY, true);
  assert.equal(process.stdin.isTTY, true);
} else {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: scenario.tty });
}
let now = 10000;
Date.now = () => now;
const handlers = new Map(), commands = new Map(), notices = [], calls = [];
const methods = ["select", "confirm", "input", "editor", "custom"];
const args = ["title", { timeout: 100, signal: new AbortController().signal }, () => {}];
const results = ["choice", false, undefined, "text", { custom: true }];
const ui = { notify(message, type) { notices.push({ message, type }); },
  setWidget() {}, setHeader() {} };
methods.forEach((name, index) => { ui[name] = function (...received) {
  assert.equal(this, ui);
  assert.deepEqual(received, args);
  calls.push(name);
  return Promise.resolve(results[index]);
}; });
const originals = methods.map(name => ui[name]);
const ctx = { mode: scenario.mode, hasUI: scenario.hasUI, ui,
  isIdle: () => true, hasPendingMessages: () => false };
extension({ on: (name, fn) => handlers.set(name, fn),
  registerCommand: (name, cmd) => commands.set(name, cmd), registerShortcut() {},
  events: { on() {}, emit() {} } });
const event = name => handlers.get(name)({}, ctx);
const command = arg => commands.get("px:pi-ui-bell").handler(arg, ctx);
const tui = scenario.mode === "tui" && scenario.hasUI;
const rings = tui && process.stdout.isTTY;
await event("session_start");
const patched = methods.map(name => ui[name]);
methods.forEach((name, i) => assert.equal(ui[name] === originals[i], !tui));
assert.equal(ui.__pi_ui_bell_ui_input_patch_v1, tui ? true : undefined);
assert.equal(globalThis.__pi_ui_bell_last_ring_ms, rings ? now : undefined);
for (const name of ["session_tree", "before_agent_start", "input", "agent_end"]) await event(name);
methods.forEach((name, i) => assert.equal(ui[name], patched[i]));
for (let i = 0; i < methods.length; i++) {
  now += 250;
  assert.equal(await ui[methods[i]](...args), results[i]);
}
assert.deepEqual(calls, methods);
await command("status"); await command("off");
await event("agent_end");
await command("on"); await command("on"); // force must never bypass mode/TTY
await command("toggle"); await command("toggle"); await command("invalid");
assert.equal(notices.length, scenario.hasUI ? 7 : 0);
if (scenario.hasUI) {
  assert.match(notices[0].message, /pi-ui bell: on/);
  assert.deepEqual(notices[1], { message: "pi-ui bell disabled", type: "info" });
  assert.match(notices.at(-1).message, /Usage:/);
}
if (!rings) assert.equal(globalThis.__pi_ui_bell_last_ring_ms, undefined);
// A skipped RPC attempt must not consume cooldown for a subsequent TUI context.
if (!scenario.pty && !tui && process.stdout.isTTY) {
  await handlers.get("agent_end")({}, { ...ctx, mode: "tui", hasUI: true });
  assert.equal(globalThis.__pi_ui_bell_last_ring_ms, now);
}
await event("session_shutdown");
process.stdout.write(JSON.stringify({ type: "response", success: true }) + "\\n");
`;

const python = `
import os, pty, subprocess, errno, sys, termios
master, slave = pty.openpty()
attrs = termios.tcgetattr(slave)
attrs[1] &= ~termios.OPOST
termios.tcsetattr(slave, termios.TCSANOW, attrs)
p = subprocess.Popen([sys.argv[1], "--eval", sys.argv[2]], stdin=slave, stdout=slave, stderr=subprocess.PIPE)
os.close(slave)
output = b""
try:
    while True:
        try: chunk = os.read(master, 65536)
        except OSError as e:
            if e.errno == errno.EIO: break
            raise
        if not chunk: break
        output += chunk
finally: os.close(master)
_, err = p.communicate(timeout=5)
sys.stdout.buffer.write(output)
sys.stderr.buffer.write(err)
sys.exit(p.returncode)
`;

for (const scenario of [
	{ mode: "rpc", hasUI: true, tty: true, pty: true },
	{ mode: "tui", hasUI: true, tty: true, pty: true },
	{ mode: "rpc", hasUI: true, tty: false },
	{ mode: "json", hasUI: false, tty: true },
	{ mode: "print", hasUI: false, tty: false },
	{ hasUI: true, tty: true },
	{ mode: "unknown", hasUI: true, tty: true },
	{ mode: "tui", hasUI: false, tty: true },
	{ mode: "tui", hasUI: true, tty: false },
]) {
	test(`bell and prompt guards: ${JSON.stringify(scenario)}`, () => {
		const result = spawnSync(scenario.pty ? "python3" : process.execPath,
			scenario.pty ? ["-c", python, process.execPath, script] : ["--eval", script], {
				env: { ...process.env, PI_UI_BELL: "true", PI_UI_BELL_DEBOUNCE_MS: "250", BELL_SCENARIO: JSON.stringify(scenario) },
				encoding: "utf8", timeout: 10_000,
			});
		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		// Non-TUI scenarios deliberately ring once only after switching to TUI.
		const bells = scenario.mode === "tui" && scenario.hasUI && scenario.tty ? 9
			: !scenario.pty && !(scenario.mode === "tui" && scenario.hasUI) && scenario.tty ? 1 : 0;
		expect(result.stdout.split("\x07").length - 1).toBe(bells);
		expect(result.stdout.replaceAll("\x07", "")).toBe('{"type":"response","success":true}\n');
	});
}
