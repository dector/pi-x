import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Capture } from "./capture.ts";

export interface ProxyOptions {
	port: number;
	logDir: string;
	upstream?: string;
	logging?: boolean;
}

/** A local Codex relay. Capture parses a copy without changing forwarded bytes. */
export class TrafficProxy {
	private server: Server;
	private enabled: boolean;
	private logPath: string | undefined;
	private readonly upstream: URL;
	private readonly options: ProxyOptions;
	private readonly sockets = new Set<Socket>();

	constructor(options: ProxyOptions) {
		this.options = options;
		this.upstream = new URL(options.upstream ?? "https://chatgpt.com/backend-api");
		if (!["http:", "https:"].includes(this.upstream.protocol)) throw new Error("Upstream must be HTTP(S)");
		this.enabled = options.logging ?? false;
		if (this.enabled) this.logPath = this.newLogPath();
		this.server = createServer((req, res) => this.forward(req, res));
		this.server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
		this.server.on("connection", (socket) => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
		});
	}

	get logging(): boolean { return this.enabled; }
	set logging(value: boolean) {
		if (value === this.enabled) return;
		this.enabled = value;
		this.logPath = value ? this.newLogPath() : undefined;
	}

	private newLogPath(): string {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		return join(this.options.logDir, `${timestamp}-${randomUUID()}.jsonl`);
	}

	async start(): Promise<void> {
		if (this.server.listening) return;
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.options.port, "127.0.0.1", () => {
				this.server.off("error", reject);
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		if (!this.server.listening) return;
		this.server.closeAllConnections();
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private destination(req: IncomingMessage): URL {
		// Do not accept absolute URLs: this is a Codex relay, not an open proxy.
		const path = req.url ?? "/";
		if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid proxy path");
		return new URL(path, `${this.upstream.origin}/`);
	}

	private headers(req: IncomingMessage): string[] {
		const headers = [...req.rawHeaders];
		for (let i = 0; i < headers.length; i += 2) {
			if (headers[i].toLowerCase() === "host") headers[i + 1] = this.upstream.host;
		}
		return headers;
	}

	private capture(req: IncomingMessage, kind: "http" | "websocket"): Capture | undefined {
		if (!this.enabled) return undefined;
		try { return new Capture(this.logPath!, req, kind, this.upstream.origin); }
		catch (err) { console.error("log-proxy capture:", err); return undefined; }
	}

	private forward(req: IncomingMessage, res: ServerResponse): void {
		let target: URL;
		try { target = this.destination(req); }
		catch { res.writeHead(400).end(); return; }
		const capture = this.capture(req, "http");
		const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
			method: req.method, headers: this.headers(req),
		}, (reply) => {
			capture?.responseHeaders(reply);
			res.writeHead(reply.statusCode ?? 502, reply.rawHeaders);
			reply.on("data", (chunk: Buffer) => capture?.response(chunk));
			reply.pipe(res);
			reply.on("aborted", () => res.destroy());
		});
		req.on("data", (chunk: Buffer) => capture?.request(chunk));
		req.on("end", () => capture?.requestEnd());
		req.pipe(upstream);
		upstream.on("error", (err) => {
			capture?.error(err);
			if (!res.headersSent) {
				capture?.localResponse(502, "Codex proxy upstream error");
				res.writeHead(502).end("Codex proxy upstream error");
			}
			else res.destroy(err);
		});
		res.on("close", () => { upstream.destroy(); capture?.finish(); });
	}

	private upgrade(req: IncomingMessage, client: Socket, head: Buffer): void {
		let target: URL;
		try { target = this.destination(req); }
		catch { client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
		const capture = this.capture(req, "websocket");
		const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
			method: req.method, headers: this.headers(req),
		});
		let peer: Socket | undefined;
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			capture?.finish();
		};
		upstream.on("upgrade", (reply, serverSocket, serverHead) => {
			peer = serverSocket;
			capture?.responseHeaders(reply);
			const status = `HTTP/${reply.httpVersion} ${reply.statusCode} ${reply.statusMessage}\r\n`;
			const headers = reply.rawHeaders.map((value, i) => `${value}${i % 2 ? "\r\n" : ": "}`).join("");
			client.write(`${status}${headers}\r\n`);
			if (head.length) { capture?.ws("request", head); serverSocket.write(head); }
			if (serverHead.length) { capture?.ws("response", serverHead); client.write(serverHead); }
			client.on("data", (chunk) => capture?.ws("request", chunk));
			serverSocket.on("data", (chunk) => capture?.ws("response", chunk));
			client.pipe(serverSocket);
			serverSocket.pipe(client);
			serverSocket.on("close", () => { client.destroy(); finish(); });
			serverSocket.on("error", () => { client.destroy(); finish(); });
		});
		upstream.on("response", (reply) => {
			capture?.responseHeaders(reply);
			client.write(`HTTP/${reply.httpVersion} ${reply.statusCode} ${reply.statusMessage}\r\n`);
			for (let i = 0; i < reply.rawHeaders.length; i += 2)
				client.write(`${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}\r\n`);
			client.write("\r\n");
			reply.on("data", (chunk: Buffer) => capture?.response(chunk));
			reply.pipe(client);
			reply.on("end", finish);
		});
		upstream.on("error", (err) => {
			capture?.error(err);
			if (!client.destroyed) {
				capture?.localResponse(502, "");
				client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			}
			finish();
		});
		client.on("close", () => { upstream.destroy(); peer?.destroy(); finish(); });
		upstream.end();
	}
}
