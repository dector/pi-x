import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { constants, inflateRawSync } from "node:zlib";
import type { IncomingMessage } from "node:http";

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Keep every byte: valid UTF-8 is text; invalid UTF-8 is explicitly base64. */
function decode(bytes: Buffer): { value: string; encoding: "utf8" | "base64" } {
	try { return { value: utf8.decode(bytes), encoding: "utf8" }; }
	catch { return { value: `BASE64::${bytes.toString("base64")}`, encoding: "base64" }; }
}

export function readable(bytes: Buffer): string { return decode(bytes).value; }

export class Capture {
	private fd: number;
	private readonly requestId = randomUUID();
	private closed = false;
	private requestChunks: Buffer[] = [];
	private responseChunks: Buffer[] = [];
	private sseBuffer = Buffer.alloc(0);
	private readonly incomingWs: WebSocketDecoder;
	private readonly outgoingWs: WebSocketDecoder;
	private responseIsSse = false;

	constructor(logPath: string, req: IncomingMessage, kind: "http" | "websocket", upstream: string) {
		mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
		this.fd = openSync(logPath, "a", 0o600);
		this.incomingWs = new WebSocketDecoder((entry) => this.line({ direction: "request", ...entry }));
		this.outgoingWs = new WebSocketDecoder((entry) => this.line({ direction: "response", ...entry }));
		this.line({ type: "request_headers", kind, method: req.method, url: req.url, headers: req.rawHeaders, upstream });
	}

	line(entry: Record<string, unknown>): void {
		if (this.closed) return;
		try { writeSync(this.fd, `${JSON.stringify({ requestId: this.requestId, timestamp: new Date().toISOString(), ...entry })}\n`); }
		catch (err) {
			console.error("log-proxy capture:", err);
			this.closed = true;
			try { closeSync(this.fd); } catch { /* already closed */ }
		}
	}

	responseHeaders(reply: IncomingMessage): void {
		this.responseIsSse = (reply.headers["content-type"] ?? "").toLowerCase().includes("text/event-stream");
		const extensions = String(reply.headers["sec-websocket-extensions"] ?? "").toLowerCase();
		if (extensions.includes("permessage-deflate")) {
			this.incomingWs.setCompression(!extensions.includes("client_no_context_takeover"));
			this.outgoingWs.setCompression(!extensions.includes("server_no_context_takeover"));
		}
		this.line({ type: "response_headers", status: reply.statusCode, headers: reply.rawHeaders });
	}

	request(chunk: Buffer): void { this.requestChunks.push(Buffer.from(chunk)); }

	requestEnd(): void {
		this.body("request_body", this.requestChunks);
		this.requestChunks = [];
	}

	response(chunk: Buffer): void {
		if (!this.responseIsSse) { this.responseChunks.push(Buffer.from(chunk)); return; }
		this.sseBuffer = Buffer.concat([this.sseBuffer, chunk]);
		while (true) {
			const lf = this.sseBuffer.indexOf("\n\n");
			const crlf = this.sseBuffer.indexOf("\r\n\r\n");
			if (lf === -1 && crlf === -1) break;
			const useCrlf = crlf !== -1 && (lf === -1 || crlf < lf);
			const index = useCrlf ? crlf : lf;
			const length = useCrlf ? 4 : 2;
			this.sseEvent(this.sseBuffer.subarray(0, index + length));
			this.sseBuffer = this.sseBuffer.subarray(index + length);
		}
	}

	private sseEvent(bytes: Buffer, incomplete = false): void {
		const { value: raw, encoding } = decode(bytes);
		const entry: Record<string, unknown> = { type: "sse_event", raw, encoding };
		if (incomplete) entry.incomplete = true;
		if (encoding === "utf8") {
			const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
			if (data) {
				try { entry.data = JSON.parse(data); }
				catch { entry.data = data; }
			}
		}
		this.line(entry);
	}

	private body(type: string, chunks: Buffer[]): void {
		if (!chunks.length) return;
		const { value: data, encoding } = decode(Buffer.concat(chunks));
		this.line({ type, data, encoding });
	}

	ws(direction: "request" | "response", chunk: Buffer): void {
		(direction === "request" ? this.incomingWs : this.outgoingWs).push(chunk);
	}

	error(error: unknown): void { this.line({ type: "error", message: String(error) }); }

	localResponse(status: number, body: string): void {
		this.line({ type: "response_headers", status, generatedByProxy: true });
		this.line({ type: "response_body", data: body, encoding: "utf8" });
	}

	finish(): void {
		if (this.closed) return;
		this.requestEnd();
		this.body("response_body", this.responseChunks);
		if (this.sseBuffer.length) this.sseEvent(this.sseBuffer, true);
		this.incomingWs.finish();
		this.outgoingWs.finish();
		this.line({ type: "end" });
		this.closed = true;
		try { closeSync(this.fd); }
		catch (err) { console.error("log-proxy capture close:", err); }
	}
}

/** Incremental RFC 6455 frame parser; only reads a copy. The relay never waits for this parser. */
export class WebSocketDecoder {
	private pending = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	private frames: Array<{ header: string; bytes: number; opcode: number; fin: boolean }> = [];
	private messageOpcode: number | undefined;
	private failed = false;
	private compressed = false;
	private contextTakeover = false;
	private messageCompressed = false;
	private dictionary = Buffer.alloc(0);
	private readonly emit: (entry: Record<string, unknown>) => void;

	constructor(emit: (entry: Record<string, unknown>) => void) { this.emit = emit; }

	setCompression(contextTakeover: boolean): void {
		this.compressed = true;
		this.contextTakeover = contextTakeover;
	}

	push(chunk: Buffer): void {
		if (this.failed) { this.emit({ type: "unparsed_ws_bytes", data: `BASE64::${chunk.toString("base64")}` }); return; }
		this.pending = Buffer.concat([this.pending, chunk]);
		while (this.pending.length >= 2) {
			const first = this.pending[0];
			const second = this.pending[1];
			const masked = (second & 0x80) !== 0;
			const lengthCode = second & 0x7f;
			const extra = lengthCode === 126 ? 2 : lengthCode === 127 ? 8 : 0;
			const headerLength = 2 + extra + (masked ? 4 : 0);
			if (this.pending.length < headerLength) return;
			const length = lengthCode === 126 ? this.pending.readUInt16BE(2)
				: lengthCode === 127 ? Number(this.pending.readBigUInt64BE(2)) : lengthCode;
			if (!Number.isSafeInteger(length)) {
				this.failed = true;
				this.emit({ type: "unparsed_ws_bytes", data: `BASE64::${this.pending.toString("base64")}`, reason: "frame too large" });
				this.pending = Buffer.alloc(0);
				return;
			}
			if (this.pending.length < headerLength + length) return;
			const header = this.pending.subarray(0, headerLength);
			const payload = Buffer.from(this.pending.subarray(headerLength, headerLength + length));
			this.pending = this.pending.subarray(headerLength + length);
			if (masked) {
				const mask = header.subarray(headerLength - 4);
				for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
			}
			const opcode = first & 0x0f;
			const fin = (first & 0x80) !== 0;
			// Binary headers (including mask key) plus decoded payload and frame lengths
			// allow exact frame reconstruction without logging unreadable masked payloads.
			const frame = { header: `BASE64::${header.toString("base64")}`, bytes: length, opcode, fin };
			if (opcode < 8 && opcode !== 0) {
				this.messageOpcode = opcode;
				this.messageCompressed = this.compressed && (first & 0x40) !== 0;
			}
			// Every frame appears in arrival order. The header contains the mask key,
			// so its exact wire bytes can be recovered from this decoded payload.
			const { value: data, encoding } = this.messageCompressed && opcode < 8
				? { value: `BASE64::${payload.toString("base64")}`, encoding: "base64" as const }
				: decode(payload);
			this.emit({ type: "ws_frame", frame, data, encoding });
			if (opcode >= 8) {
				this.emit({ type: "ws_control", frame, data, encoding });
				continue;
			}
			this.frames.push(frame);
			this.fragments.push(payload);
			if (fin) {
				let messageBytes = Buffer.concat(this.fragments);
				let decodeError: string | undefined;
				if (this.messageCompressed) {
					try {
						messageBytes = inflateRawSync(Buffer.concat([messageBytes, Buffer.from([0, 0, 255, 255])]), {
							finishFlush: constants.Z_SYNC_FLUSH,
							...(this.contextTakeover && this.dictionary.length ? { dictionary: this.dictionary } : {}),
						});
						if (this.contextTakeover) this.dictionary = Buffer.concat([this.dictionary, messageBytes]).subarray(-32768);
					} catch (err) { decodeError = String(err); }
				}
				const { value: message, encoding: messageEncoding } = decodeError
					? { value: `BASE64::${messageBytes.toString("base64")}`, encoding: "base64" as const }
					: decode(messageBytes);
				this.emit({ type: "ws_message", opcode: this.messageOpcode, frames: this.frames,
					compressed: this.messageCompressed, data: message, encoding: messageEncoding,
					...(decodeError ? { decodeError } : {}) });
				this.frames = [];
				this.fragments = [];
				this.messageOpcode = undefined;
				this.messageCompressed = false;
			}
		}
	}

	finish(): void {
		if (this.frames.length) {
			const { value: data, encoding } = decode(Buffer.concat(this.fragments));
			this.emit({ type: "ws_incomplete_message", frames: this.frames, data, encoding });
		}
		if (this.pending.length) this.emit({ type: "unparsed_ws_bytes", data: `BASE64::${this.pending.toString("base64")}` });
		this.pending = Buffer.alloc(0);
		this.frames = [];
		this.fragments = [];
	}
}
