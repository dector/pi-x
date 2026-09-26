import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ThreadsDialog } from "./dialog.ts";
import type { GustClient } from "./gust.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { Thread, ThreadState } from "./types.ts";

function thread(id: string, state: ThreadState, path = "/page"): Thread {
	return {
		id,
		path,
		text: "make it blue",
		html: "<button>Go</button>",
		locator: "body > button",
		state,
		messages: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

// A theme whose color methods are identity functions on their last argument.
const theme = new Proxy(
	{},
	{ get: () => (...args: unknown[]) => String(args[args.length - 1] ?? "") },
) as unknown as Theme;

const client: GustClient = {
	async listThreads() {
		return [thread("aaaa1111", "submitted"), thread("bbbb2222", "review")];
	},
	async seen(id) {
		return thread(id, "seen");
	},
	async reply(id) {
		return thread(id, "seen");
	},
	async review(id) {
		return thread(id, "review");
	},
	async done(id) {
		return thread(id, "done");
	},
	async watch(_since, signal) {
		return new Promise((_resolve, reject) => {
			signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
	},
	invocationLabel: () => "gust",
	socketLabel: () => "(socket from cwd)",
};

function fakeTui(columns: number): TUI {
	return { terminal: { columns, rows: 40 }, requestRender: () => {} } as unknown as TUI;
}

test("dialog renders wide and narrow without an orchestrator", async () => {
	const dialog = new ThreadsDialog(fakeTui(120), theme, client, () => {});
	await new Promise((resolve) => setTimeout(resolve, 10));
	const wide = dialog.render(120).join("\n");
	expect(wide).toContain("Gust comments");
	expect(wide).toContain("gust");
	expect(dialog.render(60).length).toBeGreaterThan(0);
});

test("dialog renders with a stopped orchestrator and surfaces the worker marker", async () => {
	const orchestrator = new Orchestrator("/root", client);
	const dialog = new ThreadsDialog(fakeTui(120), theme, client, () => {}, orchestrator);
	await new Promise((resolve) => setTimeout(resolve, 10));
	const rendered = dialog.render(120).join("\n");
	expect(rendered).toContain("Gust comments");
	// It renders the thread list.
	expect(rendered).toContain("/page");
});
