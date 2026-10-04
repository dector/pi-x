import { describe, expect, test } from "bun:test";
import { BoundedLineParser, MAX_LINE_LENGTH, MAX_PENDING_LENGTH } from "./output.ts";

function harness() {
	const parser = new BoundedLineParser();
	const lines: string[] = [];
	return { parser, lines, feed: (chunk: Buffer | string) => parser.feed(chunk, (line) => lines.push(line)), flush: () => parser.flush((line) => lines.push(line)) };
}

describe("bounded partial output", () => {
	test("bounds newline-free chunks and emits exactly one truncated line at delimiter", () => {
		const { parser, lines, feed, flush } = harness();
		for (let i = 0; i < 100; i++) {
			feed("x".repeat(100_000));
			expect(parser.pendingLength).toBeLessThanOrEqual(MAX_PENDING_LENGTH);
		}
		expect(lines).toEqual([]);
		feed("\nnext\n");
		expect(lines).toEqual([
			`${"x".repeat(MAX_LINE_LENGTH)}…(+${MAX_PENDING_LENGTH - MAX_LINE_LENGTH})…[truncated ${10_000_000 - MAX_PENDING_LENGTH} raw code units]`,
			"next",
		]);
		expect(parser.pendingLength).toBe(0);
		flush();
		expect(lines).toHaveLength(2);
	});

	test("bounds a single huge chunk with many lines without losing following output", () => {
		const { feed, lines, parser } = harness();
		feed("a".repeat(2_000_000) + "\r\n" + "small\n".repeat(1000) + "tail");
		expect(lines).toHaveLength(1001);
		expect(lines[0]).toContain("truncated");
		expect(lines.slice(1).every((line) => line === "small")).toBe(true);
		expect(parser.pendingLength).toBe(4);
	});

	test("preserves UTF-8 split at every byte boundary and flushes incomplete EOF", () => {
		const text = "héllo 日本語 🙂";
		const bytes = Buffer.from(text + "\n");
		for (let split = 0; split <= bytes.length; split++) {
			const { feed, flush, lines } = harness();
			feed(bytes.subarray(0, split));
			feed(bytes.subarray(split));
			flush();
			expect(lines).toEqual([text]);
		}
		const { feed, flush, lines } = harness();
		feed(Buffer.from([0xe2, 0x82]));
		flush();
		expect(lines).toEqual(["�"]);
	});

	test("keeps sources independent, strips ANSI, skips empty lines and handles CRLF splits", () => {
		const out = harness();
		const err = harness();
		out.feed(Buffer.from([0xc3]));
		err.feed("error\r");
		out.feed(Buffer.from([0xa9, 0x0d]));
		out.feed("\n\x1b[31mred\x1b[0m\n \t\nlast");
		err.feed("\nsecond\rthird");
		out.flush();
		err.flush();
		expect(out.lines).toEqual(["é", "red", "last"]);
		expect(err.lines).toEqual(["error", "second", "third"]);
	});

	test("EOF reports discarded whitespace and retains normal clean-line truncation", () => {
		const { feed, flush, lines } = harness();
		feed("a".repeat(MAX_LINE_LENGTH + 2) + "\n");
		feed(" ".repeat(MAX_PENDING_LENGTH + 3));
		flush();
		expect(lines).toEqual([`${"a".repeat(MAX_LINE_LENGTH)}…(+2)`, "…[truncated 3 raw code units]"]);
	});
});
