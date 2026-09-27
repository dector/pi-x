import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { TrafficProxy } from "./proxy.ts";

/** Loaded only by ./pitest. Route Codex through this local proxy even while logging is off. */
export default function logProxy(pi: ExtensionAPI): void {
	const port = Number(process.env.LOG_PROXY_PORT ?? "17381");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid LOG_PROXY_PORT");
	const proxy = new TrafficProxy({
		port,
		logging: process.env.LOG_PROXY === "1",
		logDir: join(import.meta.dirname, "logs"),
	});

	// Override only the endpoint; keep Pi's built-in Codex models and OAuth.
	pi.registerProvider("openai-codex", { baseUrl: `http://127.0.0.1:${port}/backend-api` });
	pi.on("session_start", async (_event, ctx) => {
		try {
			await proxy.start();
			ctx.ui.notify(`Codex proxy listening on 127.0.0.1:${port} (logging ${proxy.logging ? "on" : "off"})`, "info");
		} catch (err) {
			ctx.ui.notify(`Codex proxy failed to start: ${String(err)}`, "error");
			throw err;
		}
	});
	pi.on("session_shutdown", async () => { await proxy.stop(); });
	pi.registerCommand("dev:log", {
		description: "Capture Codex proxy traffic: /dev:log on|off|status",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "off") proxy.logging = action === "on";
			else if (action !== "" && action !== "status") {
				ctx.ui.notify("Usage: /dev:log on|off|status", "warning");
				return;
			}
			ctx.ui.notify(`Codex traffic capture ${proxy.logging ? "on" : "off"}`, "info");
		},
	});
}
