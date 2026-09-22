import { describe, expect, test } from "bun:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ATTACH_POLL_INTERVAL_MS, AttachView, type AttachEditor, type AttachViewTimers } from "./attach-view.ts";
import type { SingleResult } from "./types.ts";

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const END = "\x1b[F";
const ENTER = "\r";
const CTRL_O = "\x0f";
const CTRL_U = "\x15";
const CTRL_D = "\x04";
const LOWER_G = "g";
const UPPER_G = "G";
const LOWER_J = "j";
const LOWER_K = "k";
const UPPER_J = "J";
const UPPER_K = "K";
const CTRL_ENTER = "\x1b[13;5u";
const PAUSE_KEY = "p";
const RESUME_KEY = "r";
const STOP_KEY = "a";
const IME_TEXT = "日本語のテキスト";

const passthroughTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		agentSource: "user",
		task: "Implement validation",
		exitCode: -1,
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "I will inspect." }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }] },
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false },
		] as never,
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		state: "running",
		toolRuns: [{ toolCallId: "t1", toolName: "read", args: { path: "a.ts" }, status: "completed" }],
		...overrides,
	};
}

function makeLongResult(): SingleResult {
	const text = Array.from({ length: 40 }, (_value, index) => `line ${index}`).join("\n");
	return makeResult({ messages: [{ role: "assistant", content: [{ type: "text", text }] }] as never });
}

interface FakeEditorHarness {
	editor: AttachEditor;
	inputs: string[];
	setText: (value: string) => void;
	submit: (value: string) => void;
}

/** Minimal stand-in for the real Editor: records input, tracks focus state. */
function makeFakeEditor(): FakeEditorHarness {
	let text = "";
	const inputs: string[] = [];
	const editor: AttachEditor = {
		focused: false,
		disableSubmit: false,
		onSubmit: undefined,
		render: (width: number) => [`[steer-editor ${width}]`],
		handleInput: (data: string) => {
			inputs.push(data);
		},
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
	};
	return {
		editor,
		inputs,
		setText: (value) => {
			text = value;
		},
		submit: (value) => {
			text = "";
			editor.onSubmit?.(value);
		},
	};
}

function makeFakeTimers() {
	const entries: Array<{ id: number; callback: () => void; delayMs: number; cleared: boolean }> = [];
	let nextId = 1;
	const timers: AttachViewTimers = {
		set: (callback, delayMs) => {
			const id = nextId++;
			entries.push({ id, callback, delayMs, cleared: false });
			return id as unknown as ReturnType<typeof setInterval>;
		},
		clear: (handle) => {
			const entry = entries.find((item) => item.id === (handle as unknown as number));
			if (entry) entry.cleared = true;
		},
	};
	return {
		timers,
		entries,
		fire: () => {
			for (const entry of entries) if (!entry.cleared) entry.callback();
		},
		activeCount: () => entries.filter((entry) => !entry.cleared).length,
	};
}

function makeWheel(wheelDelta: number): TuiMouseEvent {
	return { type: "wheel", button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 24, shift: false, alt: false, ctrl: false, wheelDelta };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeView(options: {
	result?: SingleResult;
	completedAt?: number;
	timers?: AttachViewTimers;
	rows?: number;
	done?: (result: null) => void;
	onRender?: () => void;
	editor?: AttachEditor;
	steer?: (runId: string, message: string) => Promise<void>;
	pause?: (runId: string) => Promise<void>;
	resume?: (runId: string) => Promise<void>;
	stop?: (runId: string) => Promise<void>;
	confirmStop?: (run: { runId: string; agentName: string }) => Promise<boolean>;
	forceReadOnly?: boolean;
	watchOnly?: boolean;
	bordered?: boolean;
	maxHeight?: number;
} = {}) {
	const result = options.result ?? makeResult();
	const startedAt = Date.now() - 42_000;
	const view = new AttachView({
		getResult: () => result,
		getRun: () => ({ runId: "sa-abc123", agentName: "worker", startedAt, completedAt: options.completedAt }),
		theme: passthroughTheme,
		requestRender: options.onRender ?? (() => {}),
		done: options.done ?? (() => {}),
		terminalRows: () => options.rows ?? 24,
		now: () => startedAt + 42_000,
		timers: options.timers,
		editor: options.editor,
		steer: options.steer,
		pause: options.pause,
		resume: options.resume,
		stop: options.stop,
		confirmStop: options.confirmStop,
		forceReadOnly: options.forceReadOnly,
		watchOnly: options.watchOnly,
		bordered: options.bordered,
		maxHeight: options.maxHeight,
	});
	return { view, result };
}

describe("AttachView", () => {
	test("renders a header, task, transcript, and follows the tail initially", () => {
		const { view } = makeView();
		const lines = view.render(100);
		expect(lines[0]).toContain("worker");
		expect(lines[0]).toContain("sa-abc123");
		expect(lines.join("\n")).toContain("Implement validation");
		expect(lines.join("\n")).toContain("assistant");
		expect(lines.join("\n")).toContain("read");
		expect(lines.join("\n")).toContain("Esc detach");
		expect(view.isFollowing).toBe(true);
	});

	test("watch mode stays live and enforces read-only observation", async () => {
		const fake = makeFakeEditor();
		let steers = 0;
		let controls = 0;
		const { view } = makeView({
			watchOnly: true,
			editor: fake.editor,
			steer: async () => { steers += 1; },
			pause: async () => { controls += 1; },
			resume: async () => { controls += 1; },
			stop: async () => { controls += 1; },
		});
		const text = view.render(100).join("\n");
		expect(view.isReadOnly).toBe(false);
		expect(view.hasControls).toBe(false);
		expect(text).toContain("watching live");
		expect(text).toContain("Esc close");
		expect(text).not.toContain("Enter steer");
		expect(text).not.toContain("p pause");
		expect(text).not.toContain("[steer-editor");
		view.handleInput(ENTER);
		view.handleInput("p");
		view.handleInput("r");
		view.handleInput("a");
		expect(view.inputMode).toBe("scroll");
		expect(controls).toBe(0);
		await view.submitSteer("do something else");
		expect(steers).toBe(0);
		expect(view.lastSteerStatus?.text).toContain("Watch mode");
	});

	test("settled watch mode keeps close wording", () => {
		const { view } = makeView({
			watchOnly: true,
			completedAt: Date.now(),
			result: makeResult({ exitCode: 0, state: "settled" }),
		});
		const text = view.render(100).join("\n");
		expect(text).toContain("Esc close");
		expect(text).toContain("settled · read-only");
		expect(text).not.toContain("Esc detach");
	});

	test("Escape detaches without touching the run", () => {
		let detached: null | undefined;
		const { view, result } = makeView({ done: (value) => (detached = value) });
		view.handleInput(ESC);
		expect(detached).toBeNull();
		// The run object is unchanged: detaching never stops the child.
		expect(result.state).toBe("running");
		expect(result.exitCode).toBe(-1);
	});

	test("only detaches once even if close is called repeatedly", () => {
		let calls = 0;
		const { view } = makeView({ done: () => (calls += 1) });
		view.close();
		view.close();
		view.handleInput(ESC);
		expect(calls).toBe(1);
	});

	test("scrolling up disables tail-follow and End resumes it", () => {
		const { view } = makeView({ rows: 12, result: makeLongResult() });
		view.render(60);
		view.handleInput(UP);
		expect(view.isFollowing).toBe(false);
		view.handleInput(END);
		expect(view.isFollowing).toBe(true);
	});

	test("PageUp disables tail-follow and PageDown keeps it bounded", () => {
		const { view } = makeView({ rows: 12, result: makeLongResult() });
		view.render(60);
		view.handleInput(PAGE_UP);
		expect(view.isFollowing).toBe(false);
		view.handleInput(DOWN);
		view.handleInput(PAGE_DOWN);
		expect(view.isFollowing).toBe(true);
	});

	test("polls for live updates and stops on dispose", () => {
		const fake = makeFakeTimers();
		let renders = 0;
		const { view } = makeView({ timers: fake.timers, onRender: () => (renders += 1) });
		expect(fake.entries[0]?.delayMs).toBe(ATTACH_POLL_INTERVAL_MS);
		fake.fire();
		expect(renders).toBe(1);
		view.dispose();
		fake.fire();
		expect(renders).toBe(1);
		expect(fake.activeCount()).toBe(0);
	});

	test("dispose is idempotent and close clears the timer", () => {
		const fake = makeFakeTimers();
		const { view } = makeView({ timers: fake.timers });
		view.dispose();
		view.dispose();
		expect(fake.activeCount()).toBe(0);
		const fake2 = makeFakeTimers();
		const { view: view2 } = makeView({ timers: fake2.timers });
		view2.close();
		expect(fake2.activeCount()).toBe(0);
	});

	test("Ctrl+O toggles expanded tool arguments and results", () => {
		const { view } = makeView({ rows: 40 });
		const collapsed = view.render(80).join("\n");
		expect(collapsed).not.toContain("result:");
		view.handleInput(CTRL_O);
		expect(view.isExpanded).toBe(true);
		const expanded = view.render(80).join("\n");
		expect(expanded).toContain("result:");
		expect(expanded).toContain("file contents");
	});

	test("never emits a line wider than the viewport", () => {
		for (const width of [20, 33, 60, 100]) {
			const { view } = makeView({ rows: 12 });
			for (const line of view.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("renders a completed run read-only", () => {
		const completedAt = Date.now() - 1000;
		const fake = makeFakeEditor();
		const { view } = makeView({
			result: makeResult({ exitCode: 0, state: "settled" }),
			completedAt,
			editor: fake.editor,
		});
		const text = view.render(60).join("\n");
		expect(text).toContain("settled");
		expect(text).toContain("read-only");
		// Read-only runs never advertise or render steering.
		expect(text).not.toContain("Enter steer");
		expect(text).not.toContain("[steer-editor");
		expect(fake.editor.disableSubmit).toBe(true);
	});

	test("propagates focus to the editor only while composing", () => {
		const fake = makeFakeEditor();
		const { view } = makeView({ editor: fake.editor });
		view.focused = true;
		expect(fake.editor.focused).toBe(false);
		view.handleInput(ENTER);
		expect(view.inputMode).toBe("compose");
		expect(fake.editor.focused).toBe(true);
		view.handleInput(ESC);
		expect(view.inputMode).toBe("scroll");
		expect(fake.editor.focused).toBe(false);
	});

	test("forwards raw input to the editor while composing", () => {
		const fake = makeFakeEditor();
		const { view } = makeView({ editor: fake.editor });
		view.handleInput(ENTER);
		view.handleInput(IME_TEXT);
		expect(fake.inputs).toEqual([IME_TEXT]);
	});

	test("restores editor focus when the TUI reclaims the overlay after an approval dialog", () => {
		// A focused visible overlay reclaims input after a temporary non-overlay
		// dialog closes (docs/tui.md "Overlay Focus"); the view only has to mirror
		// that focus change onto the embedded editor for IME positioning.
		const fake = makeFakeEditor();
		const { view } = makeView({ editor: fake.editor });
		view.focused = true;
		view.handleInput(ENTER);
		expect(fake.editor.focused).toBe(true);
		view.focused = false; // approval dialog takes focus
		expect(fake.editor.focused).toBe(false);
		view.focused = true; // overlay reclaims focus when the dialog closes
		expect(fake.editor.focused).toBe(true);
	});

	test("steer sends the correct run ID and message and shows success inline", async () => {
		const fake = makeFakeEditor();
		const calls: Array<{ runId: string; message: string }> = [];
		const { view } = makeView({
			editor: fake.editor,
			steer: (runId, message) => {
				calls.push({ runId, message });
				return Promise.resolve();
			},
		});
		view.handleInput(ENTER);
		fake.submit("focus on the failing tests");
		await flush();

		expect(calls).toEqual([{ runId: "sa-abc123", message: "focus on the failing tests" }]);
		expect(view.lastSteerStatus?.kind).toBe("success");
		expect(view.lastSteerStatus?.text).toContain("sa-abc123");
		const text = view.render(80).join("\n");
		expect(text).toContain("✓");
		expect(text).toContain("sa-abc123");
	});

	test("steer failure is shown inline and re-enables the editor", async () => {
		const fake = makeFakeEditor();
		const { view } = makeView({
			editor: fake.editor,
			steer: () => Promise.reject(new Error("child is gone")),
		});
		view.handleInput(ENTER);
		fake.submit("please continue");
		await flush();

		expect(view.lastSteerStatus?.kind).toBe("error");
		expect(view.lastSteerStatus?.text).toContain("child is gone");
		expect(fake.editor.disableSubmit).toBe(false);
		const text = view.render(80).join("\n");
		expect(text).toContain("✗");
		expect(text).toContain("child is gone");
	});

	test("Ctrl+Enter submits the current editor text", async () => {
		const fake = makeFakeEditor();
		const calls: string[] = [];
		const { view } = makeView({
			editor: fake.editor,
			steer: (_runId, message) => {
				calls.push(message);
				return Promise.resolve();
			},
		});
		view.handleInput(ENTER);
		fake.setText("use the new helper");
		view.handleInput(CTRL_ENTER);
		await flush();
		expect(calls).toEqual(["use the new helper"]);
		expect(fake.editor.getText?.()).toBe("");
	});

	test("completed runs ignore steering attempts", async () => {
		const fake = makeFakeEditor();
		let steered = 0;
		const { view } = makeView({
			result: makeResult({ exitCode: 0, state: "settled" }),
			completedAt: Date.now() - 1000,
			editor: fake.editor,
			steer: () => {
				steered += 1;
				return Promise.resolve();
			},
		});
		view.handleInput(ENTER);
		expect(view.inputMode).toBe("scroll");
		await view.submitSteer("too late");
		expect(steered).toBe(0);
		expect(view.lastSteerStatus?.kind).toBe("error");
		expect(fake.editor.disableSubmit).toBe(true);
	});

	test("p and r run the native pause/resume controls for the captured run", async () => {
		const calls: string[] = [];
		const { view } = makeView({
			pause: (runId) => {
				calls.push(`pause:${runId}`);
				return Promise.resolve();
			},
			resume: (runId) => {
				calls.push(`resume:${runId}`);
				return Promise.resolve();
			},
		});
		view.handleInput(PAUSE_KEY);
		await flush();
		expect(calls).toEqual(["pause:sa-abc123"]);
		expect(view.lastControlStatus?.kind).toBe("success");
		expect(view.lastControlStatus?.text).toContain("Paused");

		view.handleInput(RESUME_KEY);
		await flush();
		expect(calls).toEqual(["pause:sa-abc123", "resume:sa-abc123"]);
		expect(view.lastControlStatus?.text).toContain("Resumed");
	});

	test("a confirms then stops, and cancellation never calls stop", async () => {
		const stops: string[] = [];
		let confirmed = false;
		const { view } = makeView({
			stop: (runId) => {
				stops.push(runId);
				return Promise.resolve();
			},
			confirmStop: () => Promise.resolve(confirmed),
		});
		view.handleInput(STOP_KEY);
		await flush();
		expect(stops).toEqual([]);
		expect(view.lastControlStatus?.kind).toBe("info");
		expect(view.lastControlStatus?.text).toContain("cancelled");

		confirmed = true;
		view.handleInput(STOP_KEY);
		await flush();
		expect(stops).toEqual(["sa-abc123"]);
		expect(view.lastControlStatus?.kind).toBe("success");
		expect(view.lastControlStatus?.text).toContain("Stopped");
	});

	test("control failures are shown inline and re-enable the controls", async () => {
		const { view } = makeView({
			pause: () => Promise.reject(new Error("child is gone")),
		});
		view.handleInput(PAUSE_KEY);
		await flush();
		expect(view.lastControlStatus?.kind).toBe("error");
		expect(view.lastControlStatus?.text).toContain("child is gone");
		expect(view.isControlBusy).toBe(false);
	});

	test("a control in flight is not re-entered", async () => {
		let resolvePause: (() => void) | undefined;
		let pauses = 0;
		const { view } = makeView({
			pause: () => {
				pauses += 1;
				return new Promise<void>((resolve) => {
					resolvePause = resolve;
				});
			},
		});
		view.handleInput(PAUSE_KEY);
		expect(view.isControlBusy).toBe(true);
		view.handleInput(PAUSE_KEY);
		expect(pauses).toBe(1);
		resolvePause?.();
		await flush();
		expect(view.isControlBusy).toBe(false);
	});

	test("a run that settles mid-control reports a settled notice, not an error", async () => {
		let completedAt: number | undefined;
		const result = makeResult();
		const view = new AttachView({
			getResult: () => result,
			getRun: () => ({ runId: "sa-abc123", agentName: "worker", startedAt: Date.now() - 1000, completedAt }),
			theme: passthroughTheme,
			requestRender: () => {},
			done: () => {},
			pause: () => {
				completedAt = Date.now();
				result.state = "settled";
				result.exitCode = 0;
				return Promise.reject(new Error("Run is no longer active"));
			},
		});
		view.handleInput(PAUSE_KEY);
		await flush();
		expect(view.lastControlStatus?.kind).toBe("info");
		expect(view.lastControlStatus?.text).toContain("already settled");
		expect(view.isReadOnly).toBe(true);
	});

	test("settled runs ignore pause/resume/stop keys", async () => {
		const calls: string[] = [];
		const { view } = makeView({
			result: makeResult({ exitCode: 0, state: "settled" }),
			completedAt: Date.now() - 1000,
			pause: (runId) => {
				calls.push(`pause:${runId}`);
				return Promise.resolve();
			},
			resume: (runId) => {
				calls.push(`resume:${runId}`);
				return Promise.resolve();
			},
			stop: (runId) => {
				calls.push(`stop:${runId}`);
				return Promise.resolve();
			},
		});
		view.handleInput(PAUSE_KEY);
		view.handleInput(RESUME_KEY);
		view.handleInput(STOP_KEY);
		await flush();
		expect(calls).toEqual([]);
	});

	test("renders pending and resolved approval blocks", () => {
		const { result, view } = makeView();
		result.resolvedApprovals = [{ requestId: "r1", method: "confirm", title: "Write file?", state: "approved" }];
		result.pendingApproval = { requestId: "r2", method: "confirm", title: "Run command?" };
		const text = view.render(80).join("\n");
		expect(text).toContain("approval (approved): Write file?");
		expect(text).toContain("approval (pending): Run command?");
	});

	test("Ctrl+U and Ctrl+D scroll by half a page and resume at the bottom", () => {
		const { view } = makeView({ rows: 12, result: makeLongResult() });
		view.render(60);
		view.handleInput(CTRL_U);
		expect(view.isFollowing).toBe(false);
		view.handleInput(CTRL_D);
		expect(view.isFollowing).toBe(true);
	});

	test("g jumps to the top and G resumes tail-follow", () => {
		const { view } = makeView({ rows: 12, result: makeLongResult() });
		view.render(60);
		view.handleInput(LOWER_G);
		expect(view.isFollowing).toBe(false);
		view.handleInput(UPPER_G);
		expect(view.isFollowing).toBe(true);
	});

	test("j/k scroll one line and Shift+j/k scroll five", () => {
		const { view } = makeView({ rows: 14, result: makeLongResult() });
		const firstLineNumber = () => {
			const match = view.render(60).join("\n").match(/line (\d+)/);
			return match ? Number(match[1]) : -1;
		};
		const start = firstLineNumber();
		expect(start).toBeGreaterThanOrEqual(0);
		view.handleInput(LOWER_K);
		expect(view.isFollowing).toBe(false);
		expect(firstLineNumber()).toBe(start - 1);
		view.handleInput(UPPER_K);
		expect(firstLineNumber()).toBe(start - 6);
		view.handleInput(LOWER_J);
		expect(firstLineNumber()).toBe(start - 5);
		view.handleInput(UPPER_J);
		expect(firstLineNumber()).toBe(start);
	});

	test("bordered watch mode draws a rounded frame titled with the agent id", () => {
		const { view } = makeView({ watchOnly: true, bordered: true, rows: 16, result: makeLongResult() });
		const lines = view.render(60);
		// One terminal-background padding cell on every side of the frame.
		expect(lines[0]?.trim()).toBe("");
		expect(lines[lines.length - 1]?.trim()).toBe("");
		expect(lines[1]).toContain("╭");
		expect(lines[1]).toContain("sa-abc123");
		expect(lines[1]).toContain("╮");
		expect(lines[lines.length - 2]).toContain("╰");
		expect(lines[lines.length - 2]).toContain("╯");
		expect(lines[2]?.startsWith(" │")).toBe(true);
		expect(lines[2]?.endsWith("│ ")).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	test("bordered watch mode fits the host maxHeight so the bottom frame survives", () => {
		const maxHeight = 11;
		const { view } = makeView({ watchOnly: true, bordered: true, rows: 16, maxHeight, result: makeLongResult() });
		const lines = view.render(60);
		expect(lines.length).toBeLessThanOrEqual(maxHeight);
		// The truncated bottom of the frame is exactly the bug this guards against.
		expect(lines[lines.length - 1]?.trim()).toBe("");
		expect(lines[lines.length - 2]).toContain("╰");
		expect(lines[lines.length - 2]).toContain("╯");
	});

	test("bordered watch mode keeps the frame when maxHeight exceeds the terminal margin", () => {
		const { view } = makeView({ watchOnly: true, bordered: true, rows: 24, maxHeight: 100, result: makeLongResult() });
		const lines = view.render(60);
		expect(lines.length).toBeLessThanOrEqual(22);
		expect(lines[lines.length - 2]).toContain("╰");
	});

	test("bordered watch mode never overflows narrow widths", () => {
		for (const width of [1, 2, 3, 4, 8, 20]) {
			const { view } = makeView({ watchOnly: true, bordered: true, rows: 12, result: makeLongResult() });
			for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("the watch frame uses the purple thinkingHigh color", () => {
		const colors: string[] = [];
		const view = new AttachView({
			getResult: () => makeResult(),
			getRun: () => ({ runId: "ag_shy-lion", agentName: "worker", startedAt: 0 }),
			theme: {
				fg: (color, text) => {
					colors.push(color);
					return text;
				},
				bold: (text) => text,
			},
			requestRender: () => {},
			done: () => {},
			watchOnly: true,
			bordered: true,
			terminalRows: () => 16,
		});
		const lines = view.render(50);
		expect(lines[1]).toContain("ag_shy-lion");
		expect(colors).toContain("thinkingHigh");
	});

	test("mouse wheel scrolls the transcript and disables tail-follow", () => {
		const { view } = makeView({ rows: 12, result: makeLongResult() });
		view.render(60);
		expect(view.handleMouse?.(makeWheel(-1))).toEqual({ handled: true });
		expect(view.isFollowing).toBe(false);
		expect(view.handleMouse?.(makeWheel(100))).toEqual({ handled: true });
		expect(view.isFollowing).toBe(true);
		expect(view.handleMouse?.({ ...makeWheel(0), type: "move" })).toBeUndefined();
	});

	test("renders compact help on a narrow terminal and full help when wide", () => {
		const { view } = makeView({ rows: 12 });
		const narrow = view.render(24).join("\n");
		expect(narrow).toContain("Esc detach");
		expect(narrow).not.toContain("PgUp");
		const wide = view.render(80).join("\n");
		expect(wide).toContain("PgUp");
		expect(wide).toContain("Ctrl+O");
	});

	test("narrow terminals never overflow for live or read-only views", () => {
		for (const width of [1, 2, 6, 12, 24, 39]) {
			const live = makeView({ rows: 8, result: makeLongResult() }).view;
			for (const line of live.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const readOnly = makeView({ rows: 8, result: makeLongResult(), forceReadOnly: true }).view;
			for (const line of readOnly.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("forceReadOnly renders a recovered persisted transcript without controls", () => {
		const fake = makeFakeEditor();
		const result = makeResult({
			exitCode: undefined as never,
			state: undefined,
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "I will inspect." }] },
				{ role: "assistant", content: [{ type: "thinking", thinking: "Check callers." }] },
				{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }] },
				{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false },
			] as never,
		});
		const { view } = makeView({ result, editor: fake.editor, forceReadOnly: true });
		const text = view.render(80).join("\n");
		expect(text).toContain("read-only");
		expect(text).toContain("I will inspect.");
		expect(text).toContain("Check callers.");
		expect(text).not.toContain("[steer-editor");
		expect(fake.editor.disableSubmit).toBe(true);
		// Control keys are ignored and the view stays detachable.
		let detached: null | undefined;
		const detachedView = makeView({ result, forceReadOnly: true, done: (value) => (detached = value) }).view;
		detachedView.handleInput(PAUSE_KEY);
		detachedView.handleInput(ESC);
		expect(detached).toBeNull();
	});
});
