import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { Orchestrator } from "./orchestrator.ts";
import { ActivityMonitor } from "./monitor.ts";
import type { ThreadActivity } from "./activity.ts";

const theme = new Proxy({}, { get: () => (...args: unknown[]) => String(args.at(-1) ?? "") }) as Theme;
function setup(rows = 10) {
	let renders = 0;
	let listener: (() => void) | undefined;
	let closed = false;
	const history: ThreadActivity = { state: "running", entries: [{ kind: "text", text: Array.from({ length: 30 }, (_, i) => `line ${String(i).padStart(2, "0")}`).join("\n") }] };
	const worker = {
		loadThreads: async () => {},
		monitorThreads: () => [{ id: "thread-a", text: "A very long starting message that should be truncated in narrow views" }, { id: "thread-b", text: "second request" }],
		activity: () => history,
		subscribe: (fn: () => void) => { listener = fn; return () => { listener = undefined; }; },
	} as unknown as Orchestrator;
	const tui = { terminal: { rows }, requestRender: () => { renders++; } } as unknown as TUI;
	const monitor = new ActivityMonitor(tui, theme, worker, () => { closed = true; });
	return { monitor, history, emit: () => listener?.(), renders: () => renders, closed: () => closed, subscribed: () => !!listener };
}

test("list truncates root messages; Enter and Esc navigate and unsubscribe", async () => {
	const s = setup();
	await s.monitor.load();
	const lines = s.monitor.render(40);
	expect(lines.join("\n")).toContain("A very");
	expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	s.monitor.handleInput("j");
	s.monitor.handleInput("\r");
	expect(s.monitor.render(100)[0]).toContain("thread-b");
	s.monitor.handleInput("\x1b");
	expect(s.monitor.render(100)[0]).toContain("threads");
	expect(s.closed()).toBe(false);
	s.monitor.handleInput("\x1b");
	expect(s.closed()).toBe(true);
	expect(s.subscribed()).toBe(false);
});

test("activity navigation follows tail only while at bottom", () => {
	const s = setup();
	s.monitor.handleInput("\r");
	expect(s.monitor.render(100)[1]).toBe("line 24");
	s.monitor.handleInput("k");
	expect(s.monitor.render(100)[1]).toBe("line 23");
	s.history.entries[0].text += "\nline 30";
	const before = s.renders();
	s.emit();
	expect(s.renders()).toBe(before + 1);
	expect(s.monitor.render(100)[1]).toBe("line 23");
	s.monitor.handleInput("K");
	expect(s.monitor.render(100)[1]).toBe("line 18");
	s.monitor.handleInput("J");
	expect(s.monitor.render(100)[1]).toBe("line 23");
	s.monitor.handleInput("g");
	s.monitor.handleInput("g");
	expect(s.monitor.render(100)[1]).toBe("line 00");
	s.monitor.handleInput("j");
	expect(s.monitor.render(100)[1]).toBe("line 01");
	s.monitor.handleInput("G");
	expect(s.monitor.render(100)[1]).toBe("line 25");
	s.history.entries[0].text += "\nline 31";
	expect(s.monitor.render(100)[1]).toBe("line 26");
	s.history.state = "stopped";
	expect(s.monitor.render(100)[0]).toContain("stopped");
});

test("kitty presses and repeats select threads, jump to start, and scroll", () => {
	const s = setup();
	s.monitor.handleInput("\x1b[106;1u"); // j press
	expect(s.monitor.render(100)[2]).toContain("› thread-b");
	s.monitor.handleInput("\x1b[107;1:2u"); // k repeat
	expect(s.monitor.render(100)[1]).toContain("› thread-a");
	s.monitor.handleInput("\r");
	expect(s.monitor.render(100)[1]).toBe("line 24");
	s.monitor.handleInput("\x1b[107;1u");
	expect(s.monitor.render(100)[1]).toBe("line 23");
	s.monitor.handleInput("\x1b[103;1u"); // g press
	s.monitor.handleInput("\x1b[103;1:2u"); // g repeat
	expect(s.monitor.render(100)[1]).toBe("line 00");
	s.monitor.handleInput("\x1b[106;1:2u");
	expect(s.monitor.render(100)[1]).toBe("line 01");
	s.monitor.handleInput("\x1b[107;1:2u");
	expect(s.monitor.render(100)[1]).toBe("line 00");
});

test("tool output cannot inject terminal controls", () => {
	const s = setup();
	s.history.entries = [{ kind: "result", text: "safe\x1b[2J\x1b]0;bad\x07text" }];
	s.monitor.handleInput("\r");
	expect(s.monitor.render(100).join("\n")).toContain("safetext");
});
