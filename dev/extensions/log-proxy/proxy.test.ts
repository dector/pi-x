import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, deflateRawSync } from "node:zlib";
import { test } from "node:test";
import { readable, WebSocketDecoder } from "./capture.ts";
import { TrafficProxy } from "./proxy.ts";

async function port(server: ReturnType<typeof createServer>) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as { port: number }).port;
}

async function send(portNumber: number, body: string) {
	return new Promise<{ status: number; text: string }>((resolve, reject) => {
		const req = request(`http://127.0.0.1:${portNumber}/backend-api/codex/responses`, {
			method: "POST", headers: { "content-type": "application/json", "x-test": "secret" },
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString() }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

function lines(dir: string) {
	const files = readdirSync(dir);
	assert.equal(files.length, 1);
	assert.match(files[0], /\.jsonl$/);
	return readFileSync(join(dir, files[0]), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
}

test("HTTP/SSE passthrough: one timestamped JSONL per on/off capture period", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-proxy-"));
	const event = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":2}}}\n\n';
	const tail = "data: unfinished";
	const upstream = createServer((req, res) => {
		assert.equal(req.url, "/backend-api/codex/responses");
		assert.equal(req.headers["x-test"], "secret");
		assert.match(req.headers.host!, /^127\.0\.0\.1:/);
		res.writeHead(201, { "content-type": "text/event-stream", "x-response": "present" });
		res.write(event.slice(0, 7));
		res.write(event.slice(7));
		res.end(tail);
	});
	const upstreamPort = await port(upstream);
	const probe = createServer();
	const localPort = await port(probe);
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	const proxy = new TrafficProxy({ port: localPort, logDir: dir, upstream: `http://127.0.0.1:${upstreamPort}`, logging: false });
	try {
		await proxy.start();
		assert.deepEqual(await send(localPort, '{"prompt":"hello"}'), { status: 201, text: event + tail });
		assert.deepEqual(readdirSync(dir), []);
		proxy.logging = true;
		assert.deepEqual(await send(localPort, '{"prompt":"secret"}'), { status: 201, text: event + tail });
		const firstFile = readdirSync(dir)[0];
		assert.match(firstFile, /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f-]+\.jsonl$/);
		const entries = lines(dir);
		assert.deepEqual(entries.map((entry) => entry.type), ["request_headers", "request_body", "response_headers", "sse_event", "sse_event", "end"]);
		assert.ok(entries[0].headers.includes("secret"));
		assert.equal(entries[1].data, '{"prompt":"secret"}');
		assert.equal(entries[2].status, 201);
		assert.ok(entries[2].headers.includes("present"));
		assert.equal(entries[3].raw, event);
		assert.equal(entries[3].data.response.usage.input_tokens, 2);
		assert.equal(entries[4].raw, tail);
		assert.equal(entries[4].incomplete, true);
		assert.equal(entries.filter((entry) => entry.type === "sse_event").map((entry) => entry.raw).join(""), event + tail);
		assert.equal(new Set(entries.map((entry) => entry.requestId)).size, 1);
		await send(localPort, "another captured request");
		assert.equal(readdirSync(dir).length, 1);
		assert.equal(new Set(lines(dir).map((entry) => entry.requestId)).size, 2);
		proxy.logging = false;
		await send(localPort, "off");
		assert.equal(readdirSync(dir).length, 1);
		proxy.logging = true;
		await send(localPort, "new capture period");
		const files = readdirSync(dir);
		assert.equal(files.length, 2);
		assert.notEqual(files[0], files[1]);
		assert.ok(files.includes(firstFile));
		const firstContent = readFileSync(join(dir, firstFile), "utf8");
		assert.equal((firstContent.match(/request_headers/g) ?? []).length, 2);
		const newFile = files.find((file) => file !== firstFile)!;
		const nextEntries = readFileSync(join(dir, newFile), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
		assert.equal(nextEntries[0].type, "request_headers");
		assert.equal(nextEntries.find((entry) => entry.type === "request_body")!.data, "new capture period");
	} finally {
		await proxy.stop();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	}
});

test("in-flight request stays in its original file across off/on rotation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-rotation-"));
	let releaseFirst!: () => void;
	let firstStarted!: () => void;
	const started = new Promise<void>((resolve) => { firstStarted = resolve; });
	const upstream = createServer((req, res) => {
		if (req.headers["x-first"] === "1") {
			firstStarted();
			releaseFirst = () => res.end("old period response");
		} else res.end("new period response");
	});
	const upstreamPort = await port(upstream);
	const probe = createServer();
	const localPort = await port(probe);
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	const proxy = new TrafficProxy({ port: localPort, logDir: dir, upstream: `http://127.0.0.1:${upstreamPort}`, logging: true });
	try {
		await proxy.start();
		const pending = new Promise<void>((resolve, reject) => {
			const req = request(`http://127.0.0.1:${localPort}/backend-api/codex/responses`, {
				method: "POST", headers: { "x-first": "1" },
			}, (res) => { res.resume(); res.on("end", resolve); });
			req.on("error", reject);
			req.end("old period request");
		});
		await started;
		const original = readdirSync(dir)[0];
		proxy.logging = false;
		proxy.logging = true;
		await send(localPort, "new period request");
		releaseFirst();
		await pending;
		const names = readdirSync(dir);
		assert.equal(names.length, 2);
		const oldEntries = readFileSync(join(dir, original), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
		assert.equal(oldEntries.find((entry) => entry.type === "request_body")!.data, "old period request");
		assert.equal(oldEntries.find((entry) => entry.type === "response_body")!.data, "old period response");
		const next = names.find((name) => name !== original)!;
		assert.ok(readFileSync(join(dir, next), "utf8").includes("new period response"));
	} finally {
		await proxy.stop();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	}
});

test("WebSocket passthrough logs decoded messages with exact reconstructible frame headers", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-ws-"));
	const upstream = createServer();
	upstream.on("upgrade", (req, socket) => {
		const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
		const deflate = Boolean(req.headers["sec-websocket-extensions"]?.includes("permessage-deflate"));
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${deflate ? "Sec-WebSocket-Extensions: permessage-deflate\r\n" : ""}\r\n`);
		socket.on("data", (frame) => {
			if ((frame[0] & 0x0f) === 0x8) { socket.end(Buffer.from([0x88, 0x00])); return; }
			const compressed = deflate ? deflateRawSync(Buffer.from("hi"), { finishFlush: constants.Z_SYNC_FLUSH }).subarray(0, -4) : Buffer.from("hi");
			socket.write(Buffer.concat([Buffer.from([deflate ? 0xc1 : 0x81, compressed.length]), compressed]));
		});
	});
	const upstreamPort = await port(upstream);
	const probe = createServer();
	const localPort = await port(probe);
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	const proxy = new TrafficProxy({ port: localPort, logDir: dir, upstream: `http://127.0.0.1:${upstreamPort}`, logging: true });
	try {
		await proxy.start();
		const ws = new WebSocket(`ws://127.0.0.1:${localPort}/backend-api/codex/responses`);
		await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
		ws.send("request");
		const message = await new Promise<string>((resolve) => { ws.onmessage = (event) => resolve(String(event.data)); });
		assert.equal(message, "hi");
		ws.close();
		await new Promise<void>((resolve) => { ws.onclose = () => resolve(); });
		const entries = lines(dir);
		assert.equal(entries[1].status, 101);
		assert.ok(entries.some((entry) => entry.direction === "request" && entry.type === "ws_message" && entry.data === "request"));
		assert.ok(entries.some((entry) => entry.direction === "response" && entry.type === "ws_message" && entry.data === "hi"));
		assert.ok(entries.some((entry) => entry.type === "ws_control"));
		assert.ok(entries.find((entry) => entry.type === "ws_message").frames[0].header.startsWith("BASE64::"));
	} finally {
		await proxy.stop();
		await new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => resolve()); });
		rmSync(dir, { recursive: true, force: true });
	}
});

test("binary and split WebSocket messages have no dropped bytes", () => {
	const events: Record<string, unknown>[] = [];
	const decoder = new WebSocketDecoder((entry) => events.push(entry));
	// Two fragments of one UTF-8 character (the euro sign), with an interleaved ping.
	const bytes = Buffer.from([0x01, 0x01, 0xe2, 0x89, 0x00, 0x80, 0x02, 0x82, 0xac]);
	for (const byte of bytes) decoder.push(Buffer.from([byte]));
	decoder.push(Buffer.from([0x82, 0x02, 0xff])); // truncated binary frame
	decoder.finish();
	assert.deepEqual(events.map((event) => event.type), ["ws_frame", "ws_frame", "ws_control", "ws_frame", "ws_message", "unparsed_ws_bytes"]);
	assert.equal(events[4].data, "€");
	assert.deepEqual((events[4].frames as Array<{ bytes: number }>).map((frame) => frame.bytes), [1, 2]);
	assert.equal(events[5].data, "BASE64::ggL/");
	assert.equal(readable(Buffer.from([0xff, 0x00])), "BASE64::/wA=");
});

test("permessage-deflate WebSocket responses are readable without losing compressed frames", () => {
	const events: Record<string, unknown>[] = [];
	const decoder = new WebSocketDecoder((event) => events.push(event));
	decoder.setCompression(true);
	const first = Buffer.from('{"type":"response.output_text.delta","delta":"hello hello hello"}');
	const second = Buffer.from('{"type":"response.completed","response":{"usage":{"input_tokens":10}}}');
	for (const [index, body] of [first, second].entries()) {
		const compressed = deflateRawSync(body, {
			finishFlush: constants.Z_SYNC_FLUSH,
			...(index ? { dictionary: first } : {}),
		}).subarray(0, -4);
		const frame = Buffer.concat([Buffer.from([0xc1, compressed.length]), compressed]);
		decoder.push(frame.subarray(0, 3));
		decoder.push(frame.subarray(3));
	}
	assert.deepEqual(events.filter((event) => event.type === "ws_message").map((event) => event.data), [first.toString(), second.toString()]);
	assert.ok(events.filter((event) => event.type === "ws_message").every((event) => event.compressed === true));
	assert.equal(events.filter((event) => event.type === "ws_frame").length, 2);
});

test("invalid SSE bytes are base64 and CRLF events retain their original bytes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-invalid-"));
	const upstream = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a]));
		res.end("data: ok\r\n\r\n");
	});
	const upstreamPort = await port(upstream);
	const probe = createServer();
	const localPort = await port(probe);
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	const proxy = new TrafficProxy({ port: localPort, logDir: dir, upstream: `http://127.0.0.1:${upstreamPort}`, logging: true });
	try {
		await proxy.start();
		await send(localPort, "hello");
		const events = lines(dir).filter((entry) => entry.type === "sse_event");
		assert.equal(events[0].raw, "BASE64::" + Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a]).toString("base64"));
		assert.equal(events[1].raw, "data: ok\r\n\r\n");
	} finally {
		await proxy.stop();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	}
});
