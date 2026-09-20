import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
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
const CTRL_ENTER = "\x1b[13;5u";
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
});
