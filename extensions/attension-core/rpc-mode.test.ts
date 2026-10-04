import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// A child isolates stream spies and the clock from Bun's other test suites.
const script = `
import assert from "node:assert/strict";
import extension from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
const scenario = JSON.parse(process.env.BELL_SCENARIO);
Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: scenario.tty });
let now = 10000;
Date.now = () => now;
const writes = [], notices = [], handlers = new Map(), commands = new Map();
let fail = false;
process.stdout.write = (chunk) => {
  if (fail) throw Error("write failed");
  writes.push(chunk);
  return true;
};
const ctx = { mode: scenario.mode, hasUI: scenario.hasUI, ui: {
  notify: (message, type) => {
    notices.push({ message, type });
  },
} };
extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, command) => commands.set(name, command) });
assert.deepEqual(writes, []); // Factory never touches stdout.
const event = (name, context = ctx) => handlers.get(name)({}, context);
const command = () => commands.get("px:attension-core-test").handler("", ctx);
const canRing = scenario.mode === "tui" && scenario.hasUI === true && process.stdout.isTTY === true;
await event("session_start");
await event("agent_end");
await event("agent_end");
if (!canRing) {
  assert.deepEqual(writes, []);
  await command(); await command(); // force must not bypass mode gate
  assert.deepEqual(writes, []);
  assert.equal(notices.length, scenario.hasUI ? 2 : 0);
  if (scenario.hasUI) {
    assert.match(notices[0].message, /TUI terminal.*skipped/);
    assert.equal(notices[0].type, "warning");
  }
  // Non-TUI attempts must not consume the TUI cooldown.
  if (process.stdout.isTTY) {
    await event("agent_end", { ...ctx, mode: "tui", hasUI: true });
    assert.deepEqual(writes, ["\\x07"]);
  }
} else {
  assert.deepEqual(writes, ["\\x07"]);
  now += 999; await event("agent_end");
  assert.equal(writes.length, 1);
  now += 1; await event("agent_end");
  assert.equal(writes.length, 2);
  await command(); await command();
  assert.equal(writes.length, 4);
  assert.deepEqual(notices, Array(2).fill({ message: "attension-core: bell sent", type: "info" }));
  for (const reset of ["session_start", "session_tree", "session_shutdown"]) {
    await event(reset); await event("agent_end");
  }
  assert.equal(writes.length, 7);
  now += 1000;
  fail = true; await command(); await event("agent_end");
  assert.deepEqual(notices.at(-1), { message: "attension-core: failed to write bell", type: "warning" });
  fail = false; await event("agent_end"); // Failed writes do not consume cooldown.
  assert.equal(writes.length, 8);
}
`;

for (const scenario of [
	{ mode: "rpc", hasUI: true, tty: true },
	{ mode: "rpc", hasUI: true, tty: false },
	{ mode: "json", hasUI: false, tty: true },
	{ mode: "print", hasUI: false, tty: true },
	{ mode: "json", hasUI: true, tty: true },
	{ hasUI: true, tty: true },
	{ mode: "unknown", hasUI: true, tty: true },
	{ mode: "tui", hasUI: false, tty: true },
	{ mode: "tui", hasUI: true, tty: false },
	{ mode: "tui", hasUI: true, tty: true },
]) {
	test(`bell gate and behavior: ${JSON.stringify(scenario)}`, () => {
		const result = spawnSync(process.execPath, ["--eval", script], {
			env: { ...process.env, BELL_SCENARIO: JSON.stringify(scenario) },
			encoding: "utf8", timeout: 10_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
	});
}

// Real PTY, not merely an isTTY stub. This exercises the extension handlers
// with a protocol-shaped notify adapter, without loading unrelated extensions.
const ptyScript = `
import assert from "node:assert/strict";
import extension from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
assert.equal(process.stdout.isTTY, true);
assert.equal(process.stdin.isTTY, true);
const handlers = new Map(), commands = new Map();
const ctx = { mode: process.env.BELL_MODE, hasUI: true, ui: {
  notify: (message, notifyType) => process.stdout.write(JSON.stringify({ type: "extension_ui_request", method: "notify", message, notifyType }) + "\\n"),
} };
extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, command) => commands.set(name, command) });
await handlers.get("session_start")({}, ctx);
await handlers.get("agent_end")({}, ctx);
await commands.get("px:attension-core-test").handler("", ctx);
process.stdout.write('{"type":"response","success":true}\\n');
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
        try:
            chunk = os.read(master, 65536)
        except OSError as e:
            if e.errno == errno.EIO: break
            raise
        if not chunk: break
        output += chunk
finally:
    os.close(master)
_, err = p.communicate(timeout=5)
sys.stdout.buffer.write(output)
sys.stderr.buffer.write(err)
sys.exit(p.returncode)
`;
for (const mode of ["rpc", "tui"]) {
	test(`${mode} under real PTY: clean protocol vs terminal bells`, () => {
		const result = spawnSync("python3", ["-c", python, process.execPath, ptyScript], {
			env: { ...process.env, BELL_MODE: mode }, encoding: "utf8", timeout: 10_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		const output = result.stdout;
		expect(output.split("\x07").length - 1).toBe(mode === "rpc" ? 0 : 2);
		const records = output.replaceAll("\x07", "").trimEnd().split("\n").map((line) => JSON.parse(line));
		expect(records).toEqual([
			{ type: "extension_ui_request", method: "notify", message: mode === "rpc" ? "attension-core: bell needs a TUI terminal (skipped)" : "attension-core: bell sent", notifyType: mode === "rpc" ? "warning" : "info" },
			{ type: "response", success: true },
		]);
	});
}
