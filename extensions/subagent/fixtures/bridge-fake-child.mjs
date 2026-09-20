/**
 * Fake `pi --mode rpc` child used by the Herdr bridge tests.
 *
 * Modes:
 *   normal    - responds to ping/prompt (default)
 *   unicode   - writes JSONL split across chunk boundaries with multibyte text
 *   oversize  - emits a message larger than the configured frame bound
 *   stderr    - writes to stderr and exits non-zero
 *   exit      - exits immediately on prompt before responding
 *   silent    - reads commands but never responds
 *   hang      - ignores stdin close and SIGTERM, stays alive
 */

import { writeFileSync } from "node:fs";
import readline from "node:readline";

const mode = process.argv[2] ?? "normal";
const pidFile = process.env.FAKE_CHILD_PID_FILE;
if (pidFile) {
	try {
		writeFileSync(pidFile, String(process.pid));
	} catch {
		// Ignore.
	}
}

const RAW_SENTINEL = "BRIDGE_RAW_SENTINEL_9f3a";
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function writeSplitThen(value, then) {
	const buffer = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	const marker = Buffer.from("😀");
	const markerIndex = buffer.indexOf(marker);
	const cut =
		markerIndex >= 0 && markerIndex + 1 < buffer.length
			? markerIndex + 1
			: Math.max(1, Math.floor(buffer.length / 2));
	process.stdout.write(buffer.subarray(0, cut));
	setTimeout(() => {
		process.stdout.write(buffer.subarray(cut));
		then?.();
	}, 15);
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}
	if (command.type === "ping") {
		if (mode === "silent") return;
		output({ id: command.id, type: "response", command: "ping", success: true, data: command.value, _raw: RAW_SENTINEL });
		return;
	}
	if (command.type === "prompt") {
		if (mode === "silent") return;
		if (mode === "unicode") {
			writeSplitThen({ id: command.id, type: "response", command: "prompt", success: true, data: "😀 café ✓" }, () => {
				output({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "héllo 😀 wörld" }] },
					_raw: RAW_SENTINEL,
				});
				output({ type: "agent_end", willRetry: false, messages: [] });
			});
			return;
		}
		if (mode === "oversize") {
			output({ id: command.id, type: "response", command: "prompt", success: true });
			output({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "X".repeat(200_000) }] },
				_raw: RAW_SENTINEL,
			});
			return;
		}
		if (mode === "stderr") {
			process.stderr.write("child stderr line\n");
			setTimeout(() => process.exit(3), 10);
			return;
		}
		if (mode === "exit") {
			process.exit(2);
		}
		output({ id: command.id, type: "response", command: "prompt", success: true });
		output({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
			_raw: RAW_SENTINEL,
		});
		output({ type: "agent_end", willRetry: false, messages: [] });
		return;
	}
	if (command.type === "abort") {
		output({ id: command.id, type: "response", command: "abort", success: true });
	}
});

rl.on("close", () => {
	if (mode === "hang") return;
	process.exit(0);
});

if (mode === "hang") {
	process.on("SIGTERM", () => {});
	process.on("SIGINT", () => {});
	setInterval(() => {}, 1_000);
}
