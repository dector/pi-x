import { StringDecoder } from "node:string_decoder";

export const MAX_LINE_LENGTH = 4096;
/** Raw decoded UTF-16 code units retained per stream, including ANSI escapes. */
export const MAX_PENDING_LENGTH = 16_384;

function stripAnsi(text: string): string {
	return text
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[@-Z\\-_]/g, "");
}

function normalizeLine(raw: string): string | undefined {
	const clean = stripAnsi(raw);
	if (clean.trim().length === 0) return undefined;
	if (clean.length <= MAX_LINE_LENGTH) return clean;
	return `${clean.slice(0, MAX_LINE_LENGTH)}…(+${clean.length - MAX_LINE_LENGTH})`;
}

/**
 * Keep the first MAX_PENDING_LENGTH decoded code units of each logical line.
 * Discard the remainder until CR/LF or EOF, then emit one line with an explicit
 * raw truncation marker. No synthetic lines/cursor increments mid-line.
 * Each source owns a decoder so split UTF-8 sequences survive chunk boundaries.
 */
export class BoundedLineParser {
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";
	private dropped = 0;

	get pendingLength(): number {
		return this.pending.length;
	}

	feed(chunk: Buffer | string, emit: (line: string) => void): void {
		this.parse(typeof chunk === "string" ? chunk : this.decoder.write(chunk), emit);
	}

	flush(emit: (line: string) => void): void {
		this.parse(this.decoder.end(), emit);
		this.finish(emit);
	}

	private parse(text: string, emit: (line: string) => void): void {
		// Scan the chunk once without split() or concatenating it to pending.
		let start = 0;
		for (let index = 0; index < text.length; index++) {
			if (text[index] !== "\r" && text[index] !== "\n") continue;
			this.append(text, start, index);
			this.finish(emit);
			start = index + 1;
		}
		this.append(text, start, text.length);
	}

	private append(text: string, start: number, end: number): void {
		const retained = Math.min(end - start, MAX_PENDING_LENGTH - this.pending.length);
		if (retained > 0) this.pending += text.slice(start, start + retained);
		this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + end - start - retained);
	}

	private finish(emit: (line: string) => void): void {
		const line = normalizeLine(this.pending);
		if (this.dropped > 0) emit(`${line ?? ""}…[truncated ${this.dropped} raw code units]`);
		else if (line !== undefined) emit(line);
		this.pending = "";
		this.dropped = 0;
	}
}
