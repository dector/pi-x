import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorker } from "./worker.ts";
import type { Thread } from "./types.ts";

async function settledWorker(records: unknown[]) {
	const dir = mkdtempSync(join(tmpdir(), "gust-settled-"));
	const script = join(dir, "fake.mjs");
	const original = process.argv[1];
	writeFileSync(script, `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", () => {
 for (const record of ${JSON.stringify(records)}) process.stdout.write(JSON.stringify(record) + "\\n");
 process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});
`);
	process.argv[1] = script;
	try {
		return await runWorker({ thread, root: dir, invocationHint: "gust", socketHint: "", signal: new AbortController().signal });
	} finally {
		process.argv[1] = original;
		rmSync(dir, { recursive: true, force: true });
	}
}

for (const message of [
	{ role: "assistant", stopReason: "error", errorMessage: "API unavailable" },
	{ role: "assistant", stopReason: "error" },
	{ role: "assistant", stopReason: "aborted" },
	{ role: "assistant", stopReason: "stop", errorMessage: "API unavailable" },
]) {
	test(`final assistant failure survives settlement and exit 0: ${JSON.stringify(message)}`, async () => {
		const result = await settledWorker([{ type: "message_end", message }]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(message.errorMessage || `Assistant turn ${message.stopReason}`);
	});
}

test("successful final retry clears earlier assistant and tool failures", async () => {
	const result = await settledWorker([
		{ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "temporary API failure" } },
		{ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "recoverable" }] } },
		{ type: "message_end", message: { role: "toolResult", isError: true } },
		{ type: "message_end", message: { role: "assistant", stopReason: "stop" } },
	]);
	expect(result.code).toBe(0);
	expect(result.stderr).toBe("");
});

const thread: Thread = { id: "rejected", text: "fix", path: "/", html: "", locator: "", state: "submitted", messages: [], createdAt: "", updatedAt: "" };

test("a rejected RPC prompt reports its error and kills the child", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gust-rejected-"));
	const script = join(dir, "fake.mjs");
	const pidFile = join(dir, "pid");
	const original = process.argv[1];
	writeFileSync(script, `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
createInterface({ input: process.stdin }).on("line", line => {
 const record = JSON.parse(line);
 process.stdout.write(JSON.stringify({ type: "response", id: record.id, success: false, error: "prompt rejected" }) + "\\n");
});
setInterval(() => {}, 1000);
`);
	process.argv[1] = script;
	let pid: number | undefined;
	try {
		const activities: unknown[] = [];
		const result = await runWorker({ thread, root: dir, invocationHint: "gust", socketHint: "", signal: new AbortController().signal, onActivity: (entry) => activities.push(entry) });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("prompt rejected");
		expect(activities).toEqual([{ kind: "error", text: "prompt rejected" }]);
		pid = Number(await Bun.file(pidFile).text());
		let exited = false;
		for (let i = 0; i < 100; i++) {
			try { process.kill(pid, 0); } catch { exited = true; break; }
			await Bun.sleep(5);
		}
		expect(exited).toBe(true);
	} finally {
		process.argv[1] = original;
		if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
		rmSync(dir, { recursive: true, force: true });
	}
});
