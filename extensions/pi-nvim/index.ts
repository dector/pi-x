import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const SOCKETS_DIR = "/tmp/pi-nvim-sockets";
const LATEST_LINK = "/tmp/pi-nvim-latest.sock";
const PROTOCOL_VERSION = 1;

function cwdHash(cwd: string): string {
	return crypto.createHash("md5").update(cwd).digest("hex").slice(0, 12);
}

function getSocketPath(cwd: string): string {
	return path.join(SOCKETS_DIR, `${cwdHash(cwd)}-${process.pid}.sock`);
}

function safeUnlink(filePath: string | null | undefined): void {
	if (!filePath) return;
	try {
		fs.unlinkSync(filePath);
	} catch {
		// ignore
	}
}

function safeMkdir(dirPath: string): void {
	try {
		fs.mkdirSync(dirPath, { recursive: true });
	} catch {
		// ignore
	}
}

function pruneStaleDiscoveryArtifacts(): void {
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(SOCKETS_DIR);
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".sock.info")) continue;

		const infoPath = path.join(SOCKETS_DIR, entry);
		const sockPath = infoPath.slice(0, -".info".length);

		if (!fs.existsSync(sockPath)) {
			safeUnlink(infoPath);
		}
	}

	try {
		const latestTarget = fs.readlinkSync(LATEST_LINK);
		if (!fs.existsSync(latestTarget)) {
			safeUnlink(LATEST_LINK);
		}
	} catch {
		// ignore
	}
}

export default function piNvimExtension(pi: ExtensionAPI): void {
	let server: net.Server | null = null;
	let socketPath: string | null = null;

	const respond = (conn: net.Socket, payload: Record<string, unknown>): void => {
		try {
			conn.write(`${JSON.stringify(payload)}\n`);
		} catch {
			// ignore
		}
	};

	const cleanup = (): void => {
		if (server) {
			try {
				server.close();
			} catch {
				// ignore
			}
			server = null;
		}

		if (socketPath) {
			safeUnlink(socketPath);
			safeUnlink(`${socketPath}.info`);
		}

		try {
			const target = fs.readlinkSync(LATEST_LINK);
			if (socketPath && target === socketPath) {
				safeUnlink(LATEST_LINK);
			}
		} catch {
			// ignore
		}

		socketPath = null;
	};

	const handleMessage = (line: string, conn: net.Socket): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			respond(conn, { ok: false, error: `Parse error: ${message}` });
			return;
		}

		if (!parsed || typeof parsed !== "object") {
			respond(conn, { ok: false, error: "Invalid payload: expected JSON object" });
			return;
		}

		const msg = parsed as { type?: unknown; message?: unknown };

		if (msg.type === "ping") {
			respond(conn, { ok: true, type: "pong" });
			return;
		}

		if (msg.type === "prompt") {
			if (typeof msg.message !== "string") {
				respond(conn, { ok: false, error: "Invalid prompt payload: 'message' must be a string" });
				return;
			}

			pi.sendUserMessage(msg.message);
			respond(conn, { ok: true });
			return;
		}

		respond(conn, {
			ok: false,
			error: `Unknown command type: ${typeof msg.type === "string" ? msg.type : "(non-string)"}`,
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		cleanup();
		safeMkdir(SOCKETS_DIR);
		pruneStaleDiscoveryArtifacts();

		const cwd = ctx.cwd;
		socketPath = getSocketPath(cwd);
		safeUnlink(socketPath);

		server = net.createServer((conn) => {
			let buffer = "";

			conn.on("data", (chunk) => {
				buffer += chunk.toString();

				let newlineIndex = buffer.indexOf("\n");
				while (newlineIndex >= 0) {
					const line = buffer.slice(0, newlineIndex).trim();
					buffer = buffer.slice(newlineIndex + 1);
					if (line.length > 0) handleMessage(line, conn);
					newlineIndex = buffer.indexOf("\n");
				}
			});

			conn.on("error", () => {
				// ignore socket-level errors
			});
		});

		server.on("error", (error) => {
			ctx.ui.notify(`pi-nvim error: ${error.message}`, "error");
		});

		server.listen(socketPath, () => {
			safeUnlink(LATEST_LINK);
			try {
				fs.symlinkSync(socketPath!, LATEST_LINK);
			} catch {
				// ignore
			}

			try {
				fs.writeFileSync(
					`${socketPath}.info`,
					JSON.stringify({
						protocolVersion: PROTOCOL_VERSION,
						cwd,
						pid: process.pid,
						startedAt: new Date().toISOString(),
						socketPath,
					}),
				);
			} catch {
				// ignore
			}
		});
	});

	pi.on("session_shutdown", async () => {
		cleanup();
	});

	process.on("exit", cleanup);

	pi.registerCommand("pi-nvim-info", {
		description: "Show pi-nvim socket path",
		handler: async (_args, ctx) => {
			if (socketPath) {
				ctx.ui.notify(`Socket: ${socketPath}`, "info");
				return;
			}
			ctx.ui.notify("pi-nvim not active", "warning");
		},
	});
}
