import { expect, test } from "bun:test";
import * as statusRow from "./status-row.ts";
import {
	ACTIVE_SUBAGENT_REFRESH_INTERVAL_MS,
	ACTIVE_SUBAGENT_WIDGET_ID,
	ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH,
	ACTIVE_SUBAGENT_WIDGET_MAX_LINES,
	ActiveSubagentWidget,
	formatActiveSubagentWidget,
	type ActiveSubagentWidgetRun,
	type ActiveSubagentWidgetTimers,
} from "./status-row.ts";

const NOW = 1_700_000_000_000;

function makeRun(overrides: Partial<ActiveSubagentWidgetRun> = {}): ActiveSubagentWidgetRun {
	return {
		runId: "sa-abc123",
		agentName: "worker",
		task: "Implement validation",
		startedAt: NOW - 34_000,
		result: { state: "running" },
		...overrides,
	};
}

function codePointLength(text: string): number {
	return Array.from(text).length;
}

/** True when `text` contains a UTF-16 high surrogate not followed by a low one. */
function hasLoneSurrogate(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

/** In-memory interval scheduler so timer behavior is deterministic and leak-free. */
function makeFakeTimers() {
	let nextHandle = 1;
	const scheduled = new Map<number, { callback: () => void; delayMs: number }>();
	const setDelays: number[] = [];
	const cleared: number[] = [];
	const timers: ActiveSubagentWidgetTimers = {
		set: (callback, delayMs) => {
			const handle = nextHandle++;
			scheduled.set(handle, { callback, delayMs });
			setDelays.push(delayMs);
			return handle as unknown as ReturnType<typeof setInterval>;
		},
		clear: (handle) => {
			const id = handle as unknown as number;
			cleared.push(id);
			scheduled.delete(id);
		},
	};
	return {
		timers,
		setDelays,
		cleared,
		get active() {
			return scheduled.size;
		},
		tick() {
			for (const { callback } of [...scheduled.values()]) callback();
		},
	};
}

test("widget id is stable", () => {
	expect(ACTIVE_SUBAGENT_WIDGET_ID).toBe("px-subagents-active");
});

test("the retired status-bar row helpers are gone", () => {
	expect("formatSubagentStatusRow" in statusRow).toBe(false);
	expect("StatusBarPresence" in statusRow).toBe(false);
	expect("SUBAGENT_STATUS_ROW_ID" in statusRow).toBe(false);
});

test("no active runs returns undefined", () => {
	expect(formatActiveSubagentWidget([], NOW)).toBeUndefined();
});

test("completed runs are excluded and return undefined when none are active", () => {
	const completed = makeRun({ completedAt: NOW - 1000 });
	expect(formatActiveSubagentWidget([completed], NOW)).toBeUndefined();
});

test("one active run renders a header and a line with state, elapsed, and task", () => {
	const lines = formatActiveSubagentWidget([makeRun()], NOW);
	expect(lines).toBeDefined();
	expect(lines).toHaveLength(2);
	expect(lines?.[0]).toBe("Subagents (1 active)");
	expect(lines?.[1]).toContain("worker");
	expect(lines?.[1]).toContain("sa-abc123");
	expect(lines?.[1]).toContain("running");
	expect(lines?.[1]).toContain("34s");
	expect(lines?.[1]).toContain("Implement validation");
});

test("multiple active runs list every active run", () => {
	const lines = formatActiveSubagentWidget(
		[
			makeRun({ runId: "sa-one", agentName: "worker", task: "First task" }),
			makeRun({ runId: "sa-two", agentName: "researcher", task: "Second task", startedAt: NOW - 12_000, result: { state: "waiting-approval", pendingApproval: { method: "confirm" } } }),
		],
		NOW,
	);
	expect(lines?.[0]).toBe("Subagents (2 active)");
	expect(lines).toHaveLength(3);
	expect(lines?.[1]).toContain("worker");
	expect(lines?.[1]).toContain("First task");
	expect(lines?.[2]).toContain("researcher");
	expect(lines?.[2]).toContain("waiting approval");
	expect(lines?.[2]).toContain("12s");
	expect(lines?.[2]).toContain("Second task");
});

test("mixed completed and active runs count and render only the active one", () => {
	const completed = makeRun({
		runId: "sa-complete",
		agentName: "worker",
		task: "Finished task",
		startedAt: NOW - 90_000,
		completedAt: NOW - 1_000,
	});
	const active = makeRun({ runId: "sa-active", agentName: "researcher", task: "Live task" });
	const lines = formatActiveSubagentWidget([completed, active], NOW);
	expect(lines?.[0]).toBe("Subagents (1 active)");
	expect(lines).toHaveLength(2);
	expect(lines?.[1]).toContain("researcher");
	expect(lines?.[1]).toContain("Live task");
	expect(lines?.join("\n")).not.toContain("Finished task");
});

test("state maps to a distinct icon", () => {
	const running = formatActiveSubagentWidget([makeRun({ result: { state: "running" } })], NOW)?.[1];
	const starting = formatActiveSubagentWidget([makeRun({ result: { state: "starting" } })], NOW)?.[1];
	const waiting = formatActiveSubagentWidget(
		[makeRun({ result: { state: "waiting-approval", pendingApproval: { method: "confirm" } } })],
		NOW,
	)?.[1];
	expect(running?.startsWith("●")).toBe(true);
	expect(starting?.startsWith("○")).toBe(true);
	expect(waiting?.startsWith("◐")).toBe(true);
});

test("active tool is included when present", () => {
	const lines = formatActiveSubagentWidget([makeRun({ result: { state: "running", activeTool: "bash" } })], NOW);
	expect(lines?.[1]).toContain("bash");
});

test("long tasks are truncated with an ellipsis", () => {
	const task = "a".repeat(120);
	const lines = formatActiveSubagentWidget([makeRun({ task })], NOW);
	const line = lines?.[1] ?? "";
	expect(line).toContain("…");
	expect(line.length).toBeLessThan(task.length);
});

test("elapsed renders minutes once a run passes a minute", () => {
	const lines = formatActiveSubagentWidget([makeRun({ startedAt: NOW - 125_000 })], NOW);
	expect(lines?.[1]).toContain("2m 5s");
});

test("short run ids preserve the distinctive tail for same-prefix ids", () => {
	const first = "sa-abcdefghij-aaaaaaaa";
	const second = "sa-abcdefghij-bbbbbbbb";
	const firstLine = formatActiveSubagentWidget([makeRun({ runId: first })], NOW)?.[1] ?? "";
	const secondLine = formatActiveSubagentWidget([makeRun({ runId: second })], NOW)?.[1] ?? "";
	// A first-N-characters shortening would collapse both to the same text.
	expect(firstLine).not.toBe(secondLine);
	expect(firstLine).toContain("aaaaaaaa");
	expect(secondLine).toContain("bbbbbbbb");
});

test("long agent names and overall lines stay within the display budget", () => {
	const lines = formatActiveSubagentWidget(
		[
			makeRun({
				agentName: "agent-with-a-very-long-name-that-keeps-going",
				task: "task ".repeat(60),
				result: {
					state: "waiting-approval",
					pendingApproval: { method: "confirm" },
					activeTool: "some-extremely-long-tool-name-here",
				},
			}),
		],
		NOW,
	);
	const line = lines?.[1] ?? "";
	expect(codePointLength(line)).toBeLessThanOrEqual(ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH);
	expect(line).toContain("…");
});

test("truncation does not split surrogate pairs", () => {
	const lines = formatActiveSubagentWidget([makeRun({ task: "😀".repeat(80) })], NOW);
	const line = lines?.[1] ?? "";
	expect(line).toContain("…");
	expect(hasLoneSurrogate(line)).toBe(false);
});

test("widget content is truncated to the line limit with a hidden count", () => {
	const runs = Array.from({ length: 20 }, (_, index) =>
		makeRun({ runId: `sa-${index}`, agentName: `agent-${index}`, task: `task ${index}` }),
	);
	const lines = formatActiveSubagentWidget(runs, NOW);
	expect(lines).toHaveLength(ACTIVE_SUBAGENT_WIDGET_MAX_LINES);
	expect(lines?.[0]).toBe("Subagents (20 active)");
	expect(lines?.[lines.length - 1]).toBe("… 12 more");
});

test("widget content stays within the limit exactly at capacity", () => {
	const runs = Array.from({ length: 9 }, (_, index) => makeRun({ runId: `sa-${index}` }));
	const lines = formatActiveSubagentWidget(runs, NOW);
	expect(lines).toHaveLength(ACTIVE_SUBAGENT_WIDGET_MAX_LINES);
	expect(lines?.[lines.length - 1]).not.toContain("more");
});

function makePublished(options: {
	now?: () => number;
	listRuns?: () => readonly ActiveSubagentWidgetRun[];
	timers?: ActiveSubagentWidgetTimers;
} = {}) {
	const published: Array<string[] | undefined> = [];
	const fake = makeFakeTimers();
	const widget = new ActiveSubagentWidget({
		setWidget: (content) => published.push(content),
		now: options.now ?? (() => NOW),
		listRuns: options.listRuns,
		timers: options.timers ?? fake.timers,
	});
	return { widget, published, fake };
}

test("registry refresh publishes the formatted widget", () => {
	const { widget, published } = makePublished();
	widget.refresh([makeRun()]);
	expect(published).toHaveLength(1);
	expect(published[0]?.[0]).toBe("Subagents (1 active)");
});

test("registry refresh suppresses identical content", () => {
	const { widget, published } = makePublished();
	widget.refresh([makeRun()]);
	widget.refresh([makeRun()]);
	expect(published).toHaveLength(1);
});

test("registry refresh clears when the last run completes", () => {
	const { widget, published } = makePublished();
	widget.refresh([makeRun()]);
	widget.refresh([makeRun({ completedAt: NOW })]);
	expect(published).toHaveLength(2);
	expect(published[1]).toBeUndefined();
});

test("shutdown clears the widget", () => {
	const { widget, published } = makePublished();
	widget.refresh([makeRun()]);
	widget.clear();
	expect(published[published.length - 1]).toBeUndefined();
});

test("reset forces a republish on the next refresh", () => {
	const { widget, published } = makePublished();
	widget.refresh([makeRun()]);
	widget.clear();
	widget.reset();
	widget.refresh([makeRun()]);
	expect(published).toHaveLength(3);
	expect(published[2]?.[0]).toBe("Subagents (1 active)");
});

test("session_tree reset republishes an otherwise-identical active snapshot", () => {
	const { widget, published } = makePublished();
	widget.refresh([makeRun()]);
	widget.refresh([makeRun()]);
	expect(published).toHaveLength(1);
	// Mirrors the session_tree handler: reset dedup, then refresh the same set.
	widget.reset();
	widget.refresh([makeRun()]);
	expect(published).toHaveLength(2);
	expect(published[1]?.[0]).toBe("Subagents (1 active)");
});

test("active runs start exactly one bounded refresh timer", () => {
	const { widget, fake } = makePublished();
	widget.refresh([makeRun()]);
	expect(fake.active).toBe(1);
	expect(fake.setDelays).toEqual([ACTIVE_SUBAGENT_REFRESH_INTERVAL_MS]);
	// Repeated progress updates must not stack timers.
	widget.refresh([makeRun()]);
	expect(fake.active).toBe(1);
	expect(fake.setDelays).toHaveLength(1);
});

test("completing the last run stops the refresh timer", () => {
	const { widget, fake } = makePublished();
	widget.refresh([makeRun()]);
	widget.refresh([makeRun({ completedAt: NOW })]);
	expect(fake.active).toBe(0);
	expect(fake.cleared).toHaveLength(1);
});

test("clear and reset stop the refresh timer", () => {
	const cleared = makePublished();
	cleared.widget.refresh([makeRun()]);
	cleared.widget.clear();
	expect(cleared.fake.active).toBe(0);

	const reset = makePublished();
	reset.widget.refresh([makeRun()]);
	reset.widget.reset();
	expect(reset.fake.active).toBe(0);
});

test("a silent-period tick advances elapsed time without a registry update", () => {
	let now = NOW;
	const { widget, published, fake } = makePublished({ now: () => now });
	widget.refresh([makeRun({ startedAt: NOW - 1_000 })]);
	expect(published).toHaveLength(1);
	expect(published[0]?.[1]).toContain("1s");
	now = NOW + 4_000;
	fake.tick();
	expect(published).toHaveLength(2);
	expect(published[1]?.[1]).toContain("5s");
});

test("a tick re-reads runs from listRuns when provided", () => {
	let runs: ActiveSubagentWidgetRun[] = [makeRun({ result: { state: "running" } })];
	const { widget, published, fake } = makePublished({ listRuns: () => runs });
	widget.refresh(runs);
	runs = [makeRun({ result: { state: "paused" } })];
	fake.tick();
	expect(published[published.length - 1]?.[1]).toContain("paused");
});
