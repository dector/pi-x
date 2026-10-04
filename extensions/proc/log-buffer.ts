export type StreamKind = "out" | "err";
export interface LogLine {
	source: StreamKind;
	text: string;
}

/** A growable circular queue. Eviction clears the slot and never moves lines. */
export class LogRing {
	private slots: Array<LogLine | undefined> = new Array(16);
	private head = 0;
	private count = 0;

	get length(): number { return this.count; }
	get capacity(): number { return this.slots.length; }

	get(index: number): LogLine | undefined {
		if (index < 0 || index >= this.count) return undefined;
		return this.slots[(this.head + index) % this.slots.length];
	}

	push(line: LogLine): void {
		if (this.count === this.slots.length) this.resize(this.slots.length * 2);
		this.slots[(this.head + this.count) % this.slots.length] = line;
		this.count++;
	}

	// Keep this queue API compatible with data handlers surviving /reload.
	shift(): LogLine | undefined {
		if (this.count === 0) return undefined;
		const line = this.slots[this.head];
		this.slots[this.head] = undefined;
		this.head = (this.head + 1) % this.slots.length;
		this.count--;
		if (this.slots.length > 16 && this.count <= this.slots.length / 4) {
			this.resize(Math.max(16, this.slots.length / 2));
		}
		return line;
	}

	slice(start = 0, end = this.count): LogLine[] {
		const normalize = (index: number) => Math.min(this.count, Math.max(0, index < 0 ? this.count + index : index));
		const out: LogLine[] = [];
		for (let index = normalize(start); index < normalize(end); index++) out.push(this.get(index)!);
		return out;
	}

	private resize(capacity: number): void {
		const next: Array<LogLine | undefined> = new Array(capacity);
		for (let index = 0; index < this.count; index++) next[index] = this.get(index);
		this.slots = next;
		this.head = 0;
	}

	static from(lines: LogLine[]): LogRing {
		const ring = new LogRing();
		for (const line of lines) ring.push(line);
		return ring;
	}
}

export interface LogRecord {
	name: string;
	state: string;
	pid?: number;
	lines: LogRing;
	/** Absolute line number of the first retained line. */
	baseLine: number;
	/** Existing accounting: UTF-16 text length plus four per line. */
	bytes: number;
	cursors: Map<string, number>;
}

export function appendLogLine(record: LogRecord, line: LogLine, limits: { logLines: number; logBytes: number }): void {
	record.lines.push(line);
	record.bytes += line.text.length + 4;
	while (record.lines.length > limits.logLines || record.bytes > limits.logBytes) {
		const removed = record.lines.shift();
		if (!removed) break;
		record.bytes -= removed.text.length + 4;
		record.baseLine++;
	}
}

export interface LogQuery {
	from?: string;
	lines?: number;
	filter?: StreamKind;
	reader: string;
	wait?: number;
}

export function parseFrom(value: string | undefined): { kind: "last" | "start" | "line"; line?: number } {
	if (!value || value === "last") return { kind: "last" };
	if (value === "start") return { kind: "start" };
	const parsed = Number(value);
	if (Number.isFinite(parsed) && parsed >= 0) return { kind: "line", line: Math.floor(parsed) };
	throw new Error(`proc: invalid from="${value}" (expected "last", "start", or a line number).`);
}

export function readLogs(record: LogRecord, query: LogQuery): string {
	const from = parseFrom(query.from);
	const cursor = record.cursors.get(query.reader) ?? 0;
	let start: number;
	let dropped = 0;
	if (from.kind === "start") start = record.baseLine;
	else if (from.kind === "line") {
		start = Math.max(from.line ?? 0, record.baseLine);
		dropped = Math.max(0, record.baseLine - (from.line ?? 0));
	} else {
		start = Math.max(cursor, record.baseLine);
		dropped = Math.max(0, record.baseLine - cursor);
	}

	const requestedLimit = Math.max(1, Math.min(Math.floor(query.lines ?? 200), 2000));
	// Match Array.slice(0, NaN) in the previous implementation.
	const limit = Number.isNaN(requestedLimit) ? 0 : requestedLimit;
	const selected: { abs: number; line: LogLine }[] = [];
	let more = false;
	for (let index = Math.max(0, start - record.baseLine); index < record.lines.length; index++) {
		const line = record.lines.get(index)!;
		if (query.filter && line.source !== query.filter) continue;
		if (selected.length >= limit) { more = true; break; }
		selected.push({ abs: record.baseLine + index, line });
	}
	if (from.kind !== "line") {
		const next = selected.length > 0 ? selected[selected.length - 1].abs + 1 : start;
		record.cursors.set(query.reader, next);
	}
	const header = [
		`proc=${record.name}`, `state=${record.state}`, `pid=${record.pid ?? "-"}`,
		`cursor=${record.cursors.get(query.reader) ?? 0}`, `dropped=${dropped}`, `more=${more}`,
	].join(" ");
	if (selected.length === 0) return `${header}\n(no new output)`;
	return [header, ...selected.map(({ line }) => `${line.source}: ${line.text}`)].join("\n");
}
