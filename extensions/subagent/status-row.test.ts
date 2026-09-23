import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MANAGER_ICONS } from "./manager-icons.ts";
import * as statusRow from "./status-row.ts";
import {
	ACTIVE_SUBAGENT_REFRESH_INTERVAL_MS,
	ACTIVE_SUBAGENT_WIDGET_ID,
	ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH,
	ACTIVE_SUBAGENT_WIDGET_MAX_LINES,
	ActiveSubagentWidget,
	formatActiveSubagentWidget,
	renderActiveSubagentWidgetContent,
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

test("one active run renders identity, runtime, and task lines", () => {
	const lines = formatActiveSubagentWidget([makeRun()], NOW);
	expect(lines).toBeDefined();
	expect(lines).toHaveLength(4);
	expect(lines?.[0]).toBe("󰚩  Subagents (1 active)");
	expect(lines?.[1]).toBe(` ${MANAGER_ICONS.running} [sa-abc123] · worker`);
	expect(lines?.[2]).toBe(" │ running 34s");
	expect(lines?.[3]).toBe(" │ Implement validation");
});

test("multiple active runs list every active run", () => {
	const lines = formatActiveSubagentWidget(
		[
			makeRun({ runId: "sa-one", agentName: "worker", task: "First task" }),
			makeRun({ runId: "sa-two", agentName: "researcher", task: "Second task", startedAt: NOW - 12_000, result: { state: "waiting-approval", pendingApproval: { method: "confirm" } } }),
		],
		NOW,
	);
	expect(lines?.[0]).toBe("󰚩  Subagents (2 active)");
	expect(lines).toHaveLength(7);
	expect(lines?.[1]).toContain("worker");
	expect(lines?.[2]).toContain("running");
	expect(lines?.[3]).toContain("First task");
	expect(lines?.[4]).toContain("researcher");
	expect(lines?.[5]).toContain("waiting approval");
	expect(lines?.[5]).toContain("12s");
	expect(lines?.[6]).toContain("Second task");
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
	expect(lines?.[0]).toBe("󰚩  Subagents (1 active)");
	expect(lines).toHaveLength(4);
	expect(lines?.[1]).toContain("researcher");
	expect(lines?.[3]).toContain("Live task");
	expect(lines?.join("\n")).not.toContain("Finished task");
});

test("settled siblings stay visible with outcome counts until their dispatch finishes", () => {
	const dispatchId = "dispatch-one";
	const lines = formatActiveSubagentWidget([
		makeRun({ runId: "sa-live", dispatchId }),
		makeRun({ runId: "sa-ok", dispatchId, completedAt: NOW - 3_000, result: { state: "settled", exitCode: 0 } }),
		makeRun({ runId: "sa-failed", dispatchId, completedAt: NOW - 2_000, result: { state: "failed", exitCode: 1 } }),
		makeRun({
			runId: "sa-canceled",
			dispatchId,
			completedAt: NOW - 1_000,
			result: { state: "failed", exitCode: 1, stopReason: "aborted" },
		}),
	], NOW);
	expect(lines?.[0]).toBe("󰚩  Subagents (1 active, 1 finished, 1 failed, 1 canceled)");
	expect(lines?.join("\n")).toContain(`${MANAGER_ICONS.finished} [sa-ok]`);
	expect(lines?.[lines.length - 1]).toBe("… 2 more");
});

test("settled runs disappear when the last run in their dispatch finishes", () => {
	const runs = [
		makeRun({ runId: "sa-one", dispatchId: "dispatch-one", completedAt: NOW - 2_000 }),
		makeRun({ runId: "sa-two", dispatchId: "dispatch-one", completedAt: NOW - 1_000 }),
	];
	expect(formatActiveSubagentWidget(runs, NOW)).toBeUndefined();
});

test("state maps to a distinct icon", () => {
	const running = formatActiveSubagentWidget([makeRun({ result: { state: "running" } })], NOW)?.[1];
	const starting = formatActiveSubagentWidget([makeRun({ result: { state: "starting" } })], NOW)?.[1];
	const waiting = formatActiveSubagentWidget(
		[makeRun({ result: { state: "waiting-approval", pendingApproval: { method: "confirm" } } })],
		NOW,
	)?.[1];
	expect(running).toStartWith(` ${MANAGER_ICONS.running} `);
	expect(starting).toStartWith(` ${MANAGER_ICONS.running} `);
	expect(waiting).toStartWith(` ${MANAGER_ICONS.blocked} `);
});

test("model and effort are on the identity line while usage stays on the activity line", () => {
	const lines = formatActiveSubagentWidget(
		[makeRun({ result: {
			state: "running",
			model: "opencode-go/deepseek-v4.1-flash",
			thinkingLevel: "minimal",
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.0266, contextTokens: 10_000, turns: 31 },
		} })],
		NOW,
		{ contextWindowForModel: () => 100_000 },
	);
	expect(lines?.[1]).toContain("worker · opencode-go/deepseek-v4.1-flash (minimal)");
	expect(lines?.[2]).toContain("running 34s, 31 turns");
	expect(lines?.[2]).toContain("· ctx:10% $0.0266");
});

test("long task descriptions stay on one truncated line", () => {
	const task = "a".repeat(240);
	const lines = formatActiveSubagentWidget([makeRun({ task })], NOW);
	expect(lines).toHaveLength(4);
	expect(lines?.[3]).toContain("…");
});

test("the task line includes its border in the line budget", () => {
	const lines = formatActiveSubagentWidget([
		makeRun({ runId: "readable-run-id-with-a-long-tag", task: "task ".repeat(80) }),
	], NOW);
	const taskLine = lines?.[3] ?? "";
	expect(codePointLength(taskLine)).toBeLessThanOrEqual(ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH);
	expect(taskLine).toContain("…");
});

test("width-aware rendering gives wrapped tasks a continuation border", () => {
	const logical = formatActiveSubagentWidget([
		makeRun({
			task: "Fix the two remaining critical Stage 4 reachability issues and amend 52e2f5fa preserving subject/sc…",
		}),
	], NOW) ?? [];
	const rendered = renderActiveSubagentWidgetContent(logical, 76);
	expect(rendered[3]?.trimEnd()).toBe("  │ Fix the two remaining critical Stage 4 reachability issues and amend");
	expect(rendered[4]?.trimEnd()).toBe("  | 52e2f5fa preserving subject/sc…");
	for (const line of rendered) expect(visibleWidth(line)).toBe(76);
});

test("width-aware rendering caps lines after wrapping", () => {
	const logical = formatActiveSubagentWidget([
		makeRun({ task: "word ".repeat(20) }),
		makeRun({ runId: "sa-two", task: "word ".repeat(20) }),
		makeRun({ runId: "sa-three", task: "word ".repeat(20) }),
	], NOW) ?? [];
	const rendered = renderActiveSubagentWidgetContent(logical, 24);
	expect(rendered).toHaveLength(ACTIVE_SUBAGENT_WIDGET_MAX_LINES);
	expect(rendered[rendered.length - 1]).toContain("… widget truncated");
	for (const line of rendered) expect(visibleWidth(line)).toBe(24);
});

test("effort is shown on the identity line before a model is known", () => {
	const lines = formatActiveSubagentWidget([
		makeRun({ result: { state: "starting", thinkingLevel: "minimal" } }),
	], NOW);
	expect(lines?.[1]).toContain("worker · minimal");
	expect(lines?.[2]).toContain("starting");
});

test("elapsed renders minutes once a run passes a minute", () => {
	const lines = formatActiveSubagentWidget([makeRun({ startedAt: NOW - 125_000 })], NOW);
	expect(lines?.[2]).toContain("2m 5s");
});

test("readable run ids are shown on the identity line", () => {
	const line = formatActiveSubagentWidget([makeRun({ runId: "red-panda" })], NOW)?.[1] ?? "";
	expect(line).toStartWith(` ${MANAGER_ICONS.running} [red-panda] · `);
});

test("widget uses theme roles for hierarchy and run state", () => {
	const wrap = (name: string) => (text: string) => `<${name}>${text}</${name}>`;
	const lines = formatActiveSubagentWidget([makeRun({ runId: "red-panda" })], NOW, {
		styles: {
			bold: wrap("b"),
			italic: wrap("i"),
			accent: wrap("accent"),
			muted: wrap("muted"),
			dim: wrap("dim"),
			success: wrap("success"),
			warning: wrap("warning"),
			error: wrap("error"),
		},
	});
	expect(lines?.[0]).toBe("<accent><b>󰚩  Subagents (1 active)</b></accent>");
	expect(lines?.[1]).toBe(` <success>${MANAGER_ICONS.running}</success> <dim>[red-panda]</dim><dim> · </dim><muted>worker</muted>`);
	expect(lines?.[2]).toBe("<dim> │ running 34s</dim>");
	expect(lines?.[3]).toBe("<dim> │ Implement validation</dim>");
});

test("state icons use their corresponding theme colors", () => {
	const wrap = (name: string) => (text: string) => `<${name}>${text}</${name}>`;
	const styles = {
		bold: wrap("b"),
		italic: wrap("i"),
		accent: wrap("accent"),
		muted: wrap("muted"),
		dim: wrap("dim"),
		success: wrap("success"),
		warning: wrap("warning"),
		error: wrap("error"),
	};
	const identityFor = (state: ActiveSubagentWidgetRun["result"]["state"], pendingApproval = false) =>
		formatActiveSubagentWidget([
			makeRun({ result: { state, pendingApproval: pendingApproval ? { method: "confirm" } : undefined } }),
		], NOW, { styles })?.[1] ?? "";

	expect(identityFor("running")).toContain(`<success>${MANAGER_ICONS.running}</success>`);
	expect(identityFor("waiting-approval", true)).toContain(`<error>${MANAGER_ICONS.blocked}</error>`);
	expect(identityFor("failed")).toContain(`<error>${MANAGER_ICONS.failed}</error>`);
	expect(identityFor("starting")).toContain(`<muted>${MANAGER_ICONS.running}</muted>`);

	const terminalIdentity = (result: ActiveSubagentWidgetRun["result"]) => {
		const dispatchId = "dispatch-colors";
		return formatActiveSubagentWidget([
			makeRun({ runId: "live", dispatchId }),
			makeRun({ runId: "done", dispatchId, completedAt: NOW - 1, result }),
		], NOW, { styles })?.[4] ?? "";
	};
	expect(terminalIdentity({ exitCode: 0 })).toContain(`<success>${MANAGER_ICONS.finished}</success>`);
	expect(terminalIdentity({ exitCode: 1 })).toContain(`<error>${MANAGER_ICONS.failed}</error>`);
	expect(terminalIdentity({ exitCode: 1, stopReason: "aborted" })).toContain(`<warning>${MANAGER_ICONS.canceled}</warning>`);
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
				},
			}),
		],
		NOW,
	);
	const metadata = lines?.[1] ?? "";
	const task = lines?.[3] ?? "";
	expect(codePointLength(metadata)).toBeLessThanOrEqual(ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH);
	expect(codePointLength(task)).toBeLessThanOrEqual(ACTIVE_SUBAGENT_WIDGET_MAX_LINE_LENGTH);
	expect(metadata + task).toContain("…");
});

test("task truncation does not split surrogate pairs", () => {
	const line = formatActiveSubagentWidget([makeRun({ task: "😀".repeat(240) })], NOW)?.[3] ?? "";
	expect(line).toContain("…");
	expect(hasLoneSurrogate(line)).toBe(false);
});

test("widget content is truncated to the line limit with a hidden count", () => {
	const runs = Array.from({ length: 20 }, (_, index) =>
		makeRun({ runId: `sa-${index}`, agentName: `agent-${index}`, task: `task ${index}` }),
	);
	const lines = formatActiveSubagentWidget(runs, NOW);
	expect(lines).toHaveLength(8);
	expect(lines?.[0]).toBe("󰚩  Subagents (20 active)");
	expect(lines?.[lines.length - 1]).toBe("… 18 more");
});

test("widget content stays within the limit exactly at capacity", () => {
	const runs = Array.from({ length: 3 }, (_, index) => makeRun({ runId: `sa-${index}` }));
	const lines = formatActiveSubagentWidget(runs, NOW);
	expect(lines).toHaveLength(ACTIVE_SUBAGENT_WIDGET_MAX_LINES);
	expect(lines?.[lines.length - 1]).not.toContain("more");
});

function makePublished(options: {
	now?: () => number;
	listRuns?: () => readonly ActiveSubagentWidgetRun[];
	timers?: ActiveSubagentWidgetTimers;
	/** Start expanded instead of the production collapsed default. */
	expanded?: boolean;
} = {}) {
	const published: Array<string[] | undefined> = [];
	const fake = makeFakeTimers();
	const widget = new ActiveSubagentWidget({
		setWidget: (content) => published.push(content),
		now: options.now ?? (() => NOW),
		listRuns: options.listRuns,
		timers: options.timers ?? fake.timers,
	});
	if (options.expanded) {
		widget.setCollapsed(false);
		// Drop the expansion publish (with no runs yet) so assertions start clean.
		published.length = 0;
	}
	return { widget, published, fake };
}

test("defaults to a one-line collapsed summary on the first active run", () => {
	const { widget, published } = makePublished();
	widget.refresh([makeRun()]);
	expect(widget.isCollapsed).toBe(true);
	expect(published).toHaveLength(1);
	expect(published[0]).toHaveLength(1);
	expect(published[0]?.[0]).toContain("Subagents (1 active)");
	expect(published[0]?.[0]).toContain(statusRow.ACTIVE_SUBAGENT_COLLAPSED_ICON);
});

test("registry refresh publishes the formatted widget when expanded", () => {
	const { widget, published } = makePublished({ expanded: true });
	widget.refresh([makeRun()]);
	expect(published).toHaveLength(1);
	expect(published[0]?.[0]).toBe("󰚩  Subagents (1 active)");
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

test("formatCollapsedActiveSubagentWidget returns one line or undefined", () => {
	expect(statusRow.formatCollapsedActiveSubagentWidget([], NOW)).toBeUndefined();
	const lines = statusRow.formatCollapsedActiveSubagentWidget([makeRun()], NOW);
	expect(lines).toHaveLength(1);
	expect(lines?.[0]).toContain("Subagents (1 active)");
	expect(lines?.[0]).toContain(statusRow.ACTIVE_SUBAGENT_COLLAPSED_ICON);
});

test("collapsed mode publishes a single summary line", () => {
	const { widget, published } = makePublished({ expanded: true });
	widget.refresh([makeRun()]);
	widget.setCollapsed(true);
	const last = published[published.length - 1];
	expect(last).toHaveLength(1);
	expect(last?.[0]).toContain("Subagents (1 active)");
	expect(last?.[0]).toContain(statusRow.ACTIVE_SUBAGENT_COLLAPSED_ICON);
});

test("toggleCollapsed flips the state and republishes", () => {
	const { widget, published } = makePublished({ expanded: true });
	widget.refresh([makeRun()]);
	expect(widget.isCollapsed).toBe(false);
	expect(widget.toggleCollapsed()).toBe(true);
	expect(widget.isCollapsed).toBe(true);
	const collapsedCount = published.length;
	expect(widget.toggleCollapsed()).toBe(false);
	expect(widget.isCollapsed).toBe(false);
	expect(published.length).toBeGreaterThan(collapsedCount);
	expect(published[published.length - 1]?.[0]).toBe("󰚩  Subagents (1 active)");
});

test("collapsed mode clears when the last run completes", () => {
	const { widget, published } = makePublished();
	widget.setCollapsed(true);
	widget.refresh([makeRun()]);
	widget.refresh([makeRun({ completedAt: NOW })]);
	expect(published[published.length - 1]).toBeUndefined();
});

test("reset forces a republish on the next refresh", () => {
	const { widget, published } = makePublished({ expanded: true });
	widget.refresh([makeRun()]);
	widget.clear();
	widget.reset();
	widget.refresh([makeRun()]);
	expect(published).toHaveLength(3);
	expect(published[2]?.[0]).toBe("󰚩  Subagents (1 active)");
});

test("session_tree reset republishes an otherwise-identical active snapshot", () => {
	const { widget, published } = makePublished({ expanded: true });
	widget.refresh([makeRun()]);
	widget.refresh([makeRun()]);
	expect(published).toHaveLength(1);
	// Mirrors the session_tree handler: reset dedup, then refresh the same set.
	widget.reset();
	widget.refresh([makeRun()]);
	expect(published).toHaveLength(2);
	expect(published[1]?.[0]).toBe("󰚩  Subagents (1 active)");
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
	const { widget, published, fake } = makePublished({ now: () => now, expanded: true });
	widget.refresh([makeRun({ startedAt: NOW - 1_000 })]);
	expect(published).toHaveLength(1);
	expect(published[0]?.[2]).toContain("1s");
	now = NOW + 4_000;
	fake.tick();
	expect(published).toHaveLength(2);
	expect(published[1]?.[2]).toContain("5s");
});

test("a tick re-reads runs from listRuns when provided", () => {
	let runs: ActiveSubagentWidgetRun[] = [makeRun({ result: { state: "running" } })];
	const { widget, published, fake } = makePublished({ listRuns: () => runs, expanded: true });
	widget.refresh(runs);
	runs = [makeRun({ result: { state: "paused" } })];
	fake.tick();
	expect(published[published.length - 1]?.[2]).toContain("paused");
});
