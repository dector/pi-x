import { describe, expect, test } from "bun:test";
import { appendLogLine, LogRing, parseFrom, readLogs, type LogLine, type LogQuery, type LogRecord } from "./log-buffer.ts";
import { BoundedLineParser, MAX_PENDING_LENGTH } from "./output.ts";

function record(): LogRecord {
	return { name: "test", state: "running", pid: 42, lines: new LogRing(), baseLine: 0, bytes: 0, cursors: new Map() };
}

// Previous array implementation, kept independent to compare full cursor/filter output.
function referenceRead(r: Omit<LogRecord, "lines"> & { lines: LogLine[] }, query: LogQuery): string {
	const from = parseFrom(query.from);
	const cursor = r.cursors.get(query.reader) ?? 0;
	const requested = from.kind === "start" ? r.baseLine : from.kind === "line" ? from.line ?? 0 : cursor;
	const start = Math.max(requested, r.baseLine);
	const dropped = Math.max(0, r.baseLine - requested);
	const candidates = r.lines.map((line, index) => ({ abs: r.baseLine + index, line }))
		.filter(({ abs, line }) => abs >= start && (!query.filter || line.source === query.filter));
	const selected = candidates.slice(0, Math.max(1, Math.min(Math.floor(query.lines ?? 200), 2000)));
	if (from.kind !== "line") r.cursors.set(query.reader, selected.length ? selected[selected.length - 1].abs + 1 : start);
	const header = `proc=${r.name} state=${r.state} pid=${r.pid ?? "-"} cursor=${r.cursors.get(query.reader) ?? 0} dropped=${dropped} more=${candidates.length > selected.length}`;
	return selected.length ? [header, ...selected.map(({ line }) => `${line.source}: ${line.text}`)].join("\n") : `${header}\n(no new output)`;
}

describe("process log ring", () => {
	test("wraps repeatedly, preserves absolute numbering, and bounds slot storage", () => {
		const r = record();
		for (let i = 0; i < 100_000; i++) appendLogLine(r, { source: i % 2 ? "err" : "out", text: String(i) }, { logLines: 20, logBytes: 1000 });
		expect(r.lines.length).toBe(20);
		expect(r.lines.capacity).toBeLessThanOrEqual(64);
		expect(r.baseLine).toBe(99_980);
		expect(r.baseLine + r.lines.length).toBe(100_000);
		expect(r.lines.get(0)?.text).toBe("99980");
		expect(r.lines.get(19)?.text).toBe("99999");
		expect(r.lines.get(20)).toBeUndefined();
		expect(r.lines.get(-1)).toBeUndefined();
		expect(r.lines.slice(-3).map((line) => line.text)).toEqual(["99997", "99998", "99999"]);
		expect(r.lines.slice(2, 4).map((line) => line.text)).toEqual(["99982", "99983"]);
	});

	test("byte pressure evicts multiple lines and an oversized line leaves an empty ring", () => {
		const r = record();
		for (let i = 0; i < 4; i++) appendLogLine(r, { source: "out", text: "abc" }, { logLines: 100, logBytes: 28 });
		appendLogLine(r, { source: "err", text: "abcdefghij" }, { logLines: 100, logBytes: 28 });
		expect(r.baseLine).toBe(2);
		expect(r.bytes).toBe(28);
		expect(r.lines.length).toBe(3);
		appendLogLine(r, { source: "out", text: "x".repeat(100) }, { logLines: 100, logBytes: 28 });
		expect(r.baseLine).toBe(6);
		expect(r.lines.length).toBe(0);
		expect(r.bytes).toBe(0);
		expect(readLogs(r, { reader: "agent" })).toContain("cursor=6 dropped=6 more=false\n(no new output)");
	});

	test("migration and surviving array-style handlers preserve data, then release slots", () => {
		const original = Array.from({ length: 1000 }, (_, i): LogLine => ({ source: "out", text: String(i) }));
		const ring = LogRing.from(original);
		expect(ring.slice()).toEqual(original);
		for (let i = 0; i < original.length; i++) expect(ring.shift()).toEqual(original[i]);
		expect(ring.shift()).toBeUndefined();
		expect(ring.capacity).toBe(16);
		// Every evicted text reference must be gone, not just hidden behind head.
		expect((ring as any).slots.every((slot: unknown) => slot === undefined)).toBe(true);
		ring.push({ source: "err", text: "new" });
		expect(ring.get(0)?.text).toBe("new");
	});

	test("all cursor/filter modes match the old array implementation over wraparound and changing limits", () => {
		const r = record();
		const reference = { ...record(), lines: [] as LogLine[], cursors: new Map<string, number>() };
		for (let i = 0; i < 1500; i++) {
			const limits = { logLines: i < 500 ? 30 : i < 1000 ? 7 : 65, logBytes: i % 5 === 0 ? 100 : 500 };
			const line: LogLine = { source: i % 3 ? "out" : "err", text: `line ${i}` };
			appendLogLine(r, line, limits);
			reference.lines.push(line);
			reference.bytes += line.text.length + 4;
			while (reference.lines.length > limits.logLines || reference.bytes > limits.logBytes) {
				reference.bytes -= reference.lines.shift()!.text.length + 4;
				reference.baseLine++;
			}
			const query: LogQuery = {
				reader: i % 2 ? "agent" : "user",
				from: [undefined, "last", "start", "0", String(i - 1), String(i + 50)][i % 6],
				filter: [undefined, "out", "err"][i % 3] as LogQuery["filter"], lines: i % 4 + 1,
			};
			expect(readLogs(r, query)).toBe(referenceRead(reference, query));
			expect(r.bytes).toBe(reference.bytes);
			expect([...r.cursors]).toEqual([...reference.cursors]);
			expect(r.lines.slice()).toEqual(reference.lines);
		}
	});

	test("filtered cursors advance only through selected source lines; numeric access is read-only", () => {
		const r = record();
		for (const source of ["out", "err", "out", "err"] as const) appendLogLine(r, { source, text: source }, { logLines: 10, logBytes: 100 });
		expect(readLogs(r, { reader: "agent", filter: "out", lines: 1 })).toContain("cursor=1 dropped=0 more=true");
		expect(readLogs(r, { reader: "agent", filter: "out" })).toContain("cursor=3 dropped=0 more=false");
		expect(readLogs(r, { reader: "agent", filter: "out" })).toContain("cursor=3 dropped=0 more=false\n(no new output)");
		expect(readLogs(r, { reader: "agent", from: "0", filter: "err" })).toContain("cursor=3");
		expect(readLogs(r, { reader: "user" })).toContain("cursor=4");
		expect(r.cursors.get("agent")).toBe(3);
	});

	test("partial parser emits single source-tagged lines without cursor changes before delimiter", () => {
		const r = record();
		const out = new BoundedLineParser();
		const err = new BoundedLineParser();
		const emit = (source: "out" | "err") => (text: string) => appendLogLine(r, { source, text }, { logLines: 5, logBytes: 100_000 });
		out.feed("x".repeat(MAX_PENDING_LENGTH * 3), emit("out"));
		expect(r.lines.length).toBe(0);
		expect(r.baseLine).toBe(0);
		err.feed("error\n", emit("err"));
		out.flush(emit("out"));
		expect(r.lines.length).toBe(2);
		expect(readLogs(r, { reader: "agent" })).toContain("cursor=2");
		expect(r.lines.get(0)?.source).toBe("err");
		expect(r.lines.get(1)?.text).toContain("truncated");
	});
});
