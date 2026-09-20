import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createJsonlDecoder, createRpcProtocol, spawnRpcChild } from "./rpc-client.ts";

describe("JSONL decoder", () => {
	test("preserves UTF-8 boundaries, strips CR, and flushes a final line", () => {
		const lines: string[] = [];
		const decoder = createJsonlDecoder((line) => lines.push(line));
		const encoded = Buffer.from('{"text":"😀"}\r\nlast');
		decoder.push(encoded.subarray(0, 11));
		decoder.push(encoded.subarray(11, 14));
		decoder.push(encoded.subarray(14));
		decoder.flush();
		expect(lines).toEqual(['{"text":"😀"}', "last"]);
	});

	test("drops an oversize complete line and keeps later lines", () => {
		const lines: string[] = [];
		const oversize: number[] = [];
		const decoder = createJsonlDecoder((line) => lines.push(line), {
			maxBytes: 16,
			onOversize: (bytes) => oversize.push(bytes),
		});
		decoder.push(`${'x'.repeat(100)}\nok\n`);
		decoder.flush();
		expect(lines).toEqual(["ok"]);
		expect(oversize).toEqual([100]);
	});

	test("drops a split oversize line and resumes at the next newline", () => {
		const lines: string[] = [];
		const decoder = createJsonlDecoder((line) => lines.push(line), { maxBytes: 8, onOversize: () => {} });
		decoder.push("0123456789");
		decoder.push("abcdefghij");
		decoder.push("\nnext\n");
		decoder.flush();
		expect(lines).toEqual(["next"]);
	});
});

describe("RPC protocol", () => {
	test("correlates responses, surfaces unmatched responses, and times out", async () => {
		const sent: string[] = [];
		const unmatched: unknown[] = [];
		const protocol = createRpcProtocol({
			events: {
				onStreamEvent: () => {},
				onExtensionUiRequest: () => {},
				onResponse: (response) => unmatched.push(response),
			},
			send: (command) => sent.push(JSON.stringify(command)),
		});
		const response = protocol.request({ id: "a", type: "ping" }, 1000);
		expect(sent).toEqual([JSON.stringify({ id: "a", type: "ping" })]);
		protocol.handleLine(JSON.stringify({ id: "a", type: "response", command: "ping", success: true, data: 7 }));
		await expect(response).resolves.toMatchObject({ success: true, data: 7 });
		protocol.handleLine(JSON.stringify({ id: "other", type: "response", command: "ping", success: true }));
		expect(unmatched).toHaveLength(1);
		await expect(protocol.request({ id: "timeout", type: "prompt" }, 20)).rejects.toThrow(/timed out/);
	});

	test("rejects duplicate request ids and missing ids", async () => {
		const protocol = createRpcProtocol({
			events: { onStreamEvent: () => {}, onExtensionUiRequest: () => {} },
			send: () => {},
		});
		void protocol.request({ id: "dup", type: "ping" }, 1000);
		await expect(protocol.request({ id: "dup", type: "ping" }, 1000)).rejects.toThrow(/Duplicate/);
		await expect(protocol.request({ type: "ping" }, 1000)).rejects.toThrow(/requires an id/);
	});
});

describe("RPC child", () => {
	test("correlates requests and terminates cleanly", async () => {
		const events: unknown[] = [];
		const child = spawnRpcChild({
			command: process.execPath,
			args: [join(import.meta.dir, "fixtures/fake-rpc-child.mjs")],
			cwd: import.meta.dir,
			events: {
				onStreamEvent: (event) => events.push(event),
				onExtensionUiRequest: () => {},
			},
		});
		const [first, second] = await Promise.all([
			child.request({ id: "one", type: "ping", value: 1 }, 1000),
			child.request({ id: "two", type: "ping", value: 2 }, 1000),
		]);
		expect(first.success && first.data).toBe(1);
		expect(second.success && second.data).toBe(2);
		await child.terminate({ graceMs: 50 });
		expect(child.exited).toBe(true);
	});

	test("rejects pending requests when the child exits", async () => {
		const child = spawnRpcChild({
			command: process.execPath,
			args: [join(import.meta.dir, "fixtures/fake-rpc-child.mjs"), "exit"],
			cwd: import.meta.dir,
			events: { onStreamEvent: () => {}, onExtensionUiRequest: () => {} },
		});
		await expect(child.request({ id: "prompt", type: "prompt", message: "x" }, 1000)).rejects.toThrow(
			"exited before responding",
		);
	});
});
