import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createJsonlDecoder, spawnRpcChild } from "./rpc-client.ts";

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
