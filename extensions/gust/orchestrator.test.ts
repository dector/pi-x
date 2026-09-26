import { expect, test } from "bun:test";
import type { GustClient, WatchSnapshot } from "./gust.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { Thread, ThreadState } from "./types.ts";
import { buildWorkerPrompt, runWorker, sessionId } from "./worker.ts";

function thread(id: string, state: ThreadState, extra: Partial<Thread> = {}): Thread {
	return {
		id,
		path: "/page",
		text: "fix it",
		html: "<button>Go</button>",
		locator: "body > button",
		state,
		messages: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...extra,
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function blockingWatch(signal?: AbortSignal): Promise<WatchSnapshot> {
	return new Promise((_resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

test("dispatches one worker for a submitted thread", async () => {
	const events: string[] = [];
	let watchCalls = 0;
	const client: GustClient = {
		async listThreads() {
			return [];
		},
		async seen(id) {
			events.push(`seen:${id}`);
			return thread(id, "seen");
		},
		async reply() {
			throw new Error("not used");
		},
		async review() {
			throw new Error("not used");
		},
		async done() {
			throw new Error("not used");
		},
		async watch(_since, signal) {
			watchCalls += 1;
			if (watchCalls === 1) return { cursor: 10, comments: [thread("t1", "submitted")] };
			if (watchCalls === 2) return { cursor: 20, comments: [thread("t1", "review")] };
			return blockingWatch(signal);
		},
		invocationLabel: () => "gust",
		socketLabel: () => "(socket from cwd)",
	};

	const dispatched: string[] = [];
	const orchestrator = new Orchestrator(
		"/root",
		client,
		async (options) => {
			dispatched.push(options.thread.id);
			return { code: 0 };
		},
	);

	orchestrator.start();
	await waitFor(() => orchestrator.status().processed === 1);
	await orchestrator.stop();

	expect(dispatched).toEqual(["t1"]);
	expect(events).toEqual(["seen:t1"]);
	expect(orchestrator.status().running).toBe(false);
});

test("recovers seen threads on the first snapshot only", async () => {
	const dispatched: string[] = [];
	let watchCalls = 0;
	const client: GustClient = {
		async listThreads() {
			return [];
		},
		async seen(id) {
			return thread(id, "seen");
		},
		async reply() {
			throw new Error("not used");
		},
		async review() {
			throw new Error("not used");
		},
		async done() {
			throw new Error("not used");
		},
		async watch(_since, signal) {
			watchCalls += 1;
			if (watchCalls === 1) return { cursor: 10, comments: [thread("old", "seen")] };
			return blockingWatch(signal);
		},
		invocationLabel: () => "gust",
		socketLabel: () => "(socket from cwd)",
	};

	const orchestrator = new Orchestrator(
		"/root",
		client,
		async (options) => {
			dispatched.push(options.thread.id);
			return { code: 0 };
		},
	);
	orchestrator.start();
	await waitFor(() => orchestrator.status().processed === 1);
	await orchestrator.stop();

	expect(dispatched).toEqual(["old"]);
});

test("runWorker sends an RPC prompt and waits for agent_settled", async () => {
	const { writeFileSync, rmSync } = await import("node:fs");
	const original = process.argv[1];
	const fakePi = `/tmp/gust-fake-rpc-${process.pid}.mjs`;
	const promptFile = `${fakePi}.prompt`;
	writeFileSync(
		fakePi,
		`import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let record; try { record = JSON.parse(line); } catch { return; }
  if (record.type === "prompt") {
    writeFileSync(${JSON.stringify(promptFile)}, record.message);
    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`,
	);
	process.argv[1] = fakePi;
	try {
		const controller = new AbortController();
		const result = await runWorker({
			thread: thread("abc", "submitted"),
			root: "/tmp",
			invocationHint: "gust",
			socketHint: "(socket from cwd)",
			signal: controller.signal,
		});
		expect(result.code).toBe(0);
		expect(await Bun.file(promptFile).text()).toContain("abc");
	} finally {
		process.argv[1] = original;
		rmSync(fakePi, { force: true });
		rmSync(promptFile, { force: true });
	}
});

test("session ids are stable per root and thread", () => {
	const a = sessionId("/repo/one", "abc");
	expect(a).toBe(sessionId("/repo/one", "abc"));
	expect(a).not.toBe(sessionId("/repo/one", "def"));
	expect(a).not.toBe(sessionId("/repo/two", "abc"));
	expect(a).toMatch(/^gust-[0-9a-f]+-abc$/);
});

test("worker prompt carries the thread and the review command", () => {
	const prompt = buildWorkerPrompt(thread("abc", "submitted"), "go tool gust", "(socket from cwd)");
	expect(prompt).toContain("abc");
	expect(prompt).toContain("go tool gust ctl comments review abc");
	expect(prompt).toContain("Never call go tool gust ctl comments done");
});

test("runWorker resumes a deterministic session", async () => {
	const { writeFileSync, rmSync } = await import("node:fs");
	const original = process.argv[1];
	// A fake entry script that records the args it was launched with.
	const fakePi = `/tmp/gust-fake-pi-${process.pid}.mjs`;
	const argsFile = `${fakePi}.args`;
	writeFileSync(
		fakePi,
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join("\\n"));\n`,
	);
	process.argv[1] = fakePi;
	try {
		const controller = new AbortController();
		const result = await runWorker({
			thread: thread("abc", "submitted"),
			root: "/tmp",
			invocationHint: "gust",
			socketHint: "(socket from cwd)",
			signal: controller.signal,
		});
		expect(result.code).toBe(0);
		const argv = await Bun.file(argsFile).text();
		const commands = argv.split("\n").filter(Boolean);
		expect(commands).toContain("--mode");
		expect(commands).toContain("rpc");
		expect(commands).toContain("--no-extensions");
		expect(commands).toContain("--session-id");
		expect(commands).toContain(sessionId("/tmp", "abc"));
	} finally {
		process.argv[1] = original;
		rmSync(fakePi, { force: true });
		rmSync(argsFile, { force: true });
	}
});
