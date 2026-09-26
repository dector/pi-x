import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatCollapsedProcessesWidget,
	formatProcessesWidget,
	hasVisibleProcessEntries,
	PROCESSES_COLLAPSED_ICON,
	PROCESSES_DEFAULT_EXITED_RETENTION_MS,
	PROCESSES_WIDGET_ICON,
	PROCESSES_WIDGET_ID,
	PROCESSES_WIDGET_MAX_LINES,
	PROCESS_STATUS_ICONS,
	processStateTone,
	renderProcessesWidgetContent,
	ProcessesWidget,
	sortProcessEntries,
	type ProcessesWidgetEntry,
	type ProcessesWidgetStyles,
	type ProcessesWidgetTimers,
	visibleProcessEntries,
} from "./processes-widget.ts";

const NOW = 1_700_000_000_000;

function makeEntry(overrides: Partial<ProcessesWidgetEntry> = {}): ProcessesWidgetEntry {
	return {
		name: "vite",
		state: "running",
		pid: 1234,
		startedAt: NOW - 34_000,
		unread: 0,
		...overrides,
	};
}

function codePointLength(text: string): number {
	return Array.from(text).length;
}

/** In-memory interval scheduler so timer behavior is deterministic and leak-free. */
function makeFakeTimers() {
	let nextHandle = 1;
	const scheduled = new Map<number, { callback: () => void; delayMs: number }>();
	const setDelays: number[] = [];
	const cleared: number[] = [];
	const timers: ProcessesWidgetTimers = {
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
	expect(PROCESSES_WIDGET_ID).toBe("px-processes-active");
});

test("no entries returns undefined", () => {
	expect(formatProcessesWidget([], NOW)).toBeUndefined();
	expect(formatCollapsedProcessesWidget([], NOW)).toBeUndefined();
});

test("only expired exited entries return undefined", () => {
	const expired = makeEntry({
		state: "exited",
		endedAt: NOW - PROCESSES_DEFAULT_EXITED_RETENTION_MS - 1,
		exitCode: 0,
	});
	expect(formatProcessesWidget([expired], NOW)).toBeUndefined();
});

test("exited entries stay until the retention window closes", () => {
	const edge = makeEntry({
		state: "exited",
		endedAt: NOW - PROCESSES_DEFAULT_EXITED_RETENTION_MS,
		exitCode: 0,
	});
	const justExpired = makeEntry({
		name: "npm",
		state: "exited",
		endedAt: NOW - PROCESSES_DEFAULT_EXITED_RETENTION_MS - 1,
		exitCode: 0,
	});
	expect(hasVisibleProcessEntries([edge, justExpired], NOW)).toBe(true);
	expect(visibleProcessEntries([edge, justExpired], NOW)).toHaveLength(1);
	expect(visibleProcessEntries([edge, justExpired], NOW)[0]?.name).toBe("vite");
});

test("running and stopping sort before exited, then by time", () => {
	const exitedOld = makeEntry({ name: "old", state: "exited", startedAt: NOW - 100_000, endedAt: NOW - 9_000 });
	const exitedNew = makeEntry({ name: "new", state: "exited", startedAt: NOW - 50_000, endedAt: NOW - 1_000 });
	const runningLate = makeEntry({ name: "late", state: "running", startedAt: NOW - 1_000 });
	const runningEarly = makeEntry({ name: "early", state: "running", startedAt: NOW - 9_000 });
	const stopping = makeEntry({ name: "stopping", state: "stopping", startedAt: NOW - 2_000 });
	const ordered = [...visibleProcessEntries([exitedOld, exitedNew, runningLate, runningEarly, stopping], NOW)];
	expect(ordered.map((entry) => entry.name)).toEqual(["early", "stopping", "late", "new", "old"]);
});

test("sortProcessEntries is stable for equal timestamps", () => {
	const first = makeEntry({ name: "a", startedAt: NOW });
	const second = makeEntry({ name: "b", startedAt: NOW });
	expect([second, first].sort(sortProcessEntries).map((entry) => entry.name)).toEqual(["b", "a"]);
});

test("state tone matches the retired neo-bar colors", () => {
	expect(processStateTone(makeEntry({ state: "running" }))).toBe("success");
	expect(processStateTone(makeEntry({ state: "stopping" }))).toBe("warning");
	expect(processStateTone(makeEntry({ state: "exited", exitCode: 0 }))).toBe("muted");
	expect(processStateTone(makeEntry({ state: "exited", exitCode: 1 }))).toBe("error");
	expect(processStateTone(makeEntry({ state: "exited", exitCode: 0, exitSignal: "SIGKILL" }))).toBe("error");
});

test("expanded widget renders a header and one line per process", () => {
	const lines = formatProcessesWidget([
		makeEntry({ name: "vite", state: "running", pid: 1234, startedAt: NOW - 12_000 }),
		makeEntry({ name: "npm", state: "exited", pid: 1222, startedAt: NOW - 30_000, endedAt: NOW - 8_000, exitCode: 0 }),
	], NOW);
	expect(lines).toBeDefined();
	expect(lines?.[0]).toBe(`${PROCESSES_WIDGET_ICON}  Processes (1 running, 1 exited)`);
	expect(lines?.[1]).toContain("vite");
	expect(lines?.[1]).toContain("pid 1234");
	expect(lines?.[1]).toContain("running");
	expect(lines?.[1]).toContain("12s");
	expect(lines?.[2]).toContain("npm");
	expect(lines?.[2]).toContain("exited");
	expect(lines?.[2]).toContain("code 0");
});

test("unread count is shown as a detail", () => {
	const lines = formatProcessesWidget([makeEntry({ unread: 7 })], NOW);
	expect(lines?.[1]).toContain("+7");
});

test("signal exits render the signal detail", () => {
	const lines = formatProcessesWidget([makeEntry({ state: "exited", endedAt: NOW - 1_000, exitSignal: "SIGKILL" })], NOW);
	expect(lines?.[1]).toContain("signal SIGKILL");
});

test("expanded widget never exceeds the line limit and reports overflow", () => {
	const entries = Array.from({ length: 20 }, (_, index) =>
		makeEntry({ name: `proc-${index}`, pid: 1000 + index, startedAt: NOW - index * 1_000 }),
	);
	const lines = formatProcessesWidget(entries, NOW);
	expect(lines).toHaveLength(PROCESSES_WIDGET_MAX_LINES);
	expect(lines?.[lines.length - 1]).toBe("… 12 more");
});

test("expanded widget fits exactly at capacity without an overflow line", () => {
	const entries = Array.from({ length: 9 }, (_, index) =>
		makeEntry({ name: `proc-${index}`, pid: 1000 + index, startedAt: NOW - index * 1_000 }),
	);
	const lines = formatProcessesWidget(entries, NOW);
	expect(lines).toHaveLength(PROCESSES_WIDGET_MAX_LINES);
	expect(lines?.[lines.length - 1]).not.toContain("more");
});

test("collapsed widget is a single header line with the expand icon", () => {
	const lines = formatCollapsedProcessesWidget([makeEntry()], NOW);
	expect(lines).toHaveLength(1);
	expect(lines?.[0]).toContain(`${PROCESSES_WIDGET_ICON}  Processes (1 running)`);
	expect(lines?.[0]).toContain(PROCESSES_COLLAPSED_ICON);
});

test("long names are truncated without splitting surrogate pairs", () => {
	const lines = formatProcessesWidget([makeEntry({ name: "😀".repeat(40) })], NOW);
	const line = lines?.[1] ?? "";
	expect(codePointLength(line)).toBeLessThan(120);
	expect(line).toContain("…");
});

test("widget uses theme roles and matching status icons", () => {
	const wrap = (name: string) => (text: string) => `<${name}>${text}</${name}>`;
	const styles: ProcessesWidgetStyles = {
		bold: wrap("b"),
		dim: wrap("dim"),
		muted: wrap("muted"),
		accent: wrap("accent"),
		success: wrap("success"),
		warning: wrap("warning"),
		error: wrap("error"),
	};
	const running = formatProcessesWidget([makeEntry({ state: "running" })], NOW, { styles });
	expect(running?.[0]).toBe(`<accent><b>${PROCESSES_WIDGET_ICON}  Processes (1 running)</b></accent>`);
	expect(running?.[1]).toContain(`<success>${PROCESS_STATUS_ICONS.running}</success>`);

	const stopping = formatProcessesWidget([makeEntry({ state: "stopping" })], NOW, { styles });
	expect(stopping?.[1]).toContain(`<warning>${PROCESS_STATUS_ICONS.stopping}</warning>`);

	const exitedOk = formatProcessesWidget([makeEntry({ state: "exited", endedAt: NOW - 1_000, exitCode: 0 })], NOW, { styles });
	expect(exitedOk?.[1]).toContain(`<muted>${PROCESS_STATUS_ICONS.exitedOk}</muted>`);

	const exitedBad = formatProcessesWidget([makeEntry({ state: "exited", endedAt: NOW - 1_000, exitCode: 1 })], NOW, { styles });
	expect(exitedBad?.[1]).toContain(`<error>${PROCESS_STATUS_ICONS.exitedError}</error>`);
});

test("renderer aligns Processes with Subagents and fits terminal width", () => {
	const [line] = renderProcessesWidgetContent([`${PROCESSES_WIDGET_ICON}  Processes`], 40);
	expect(line?.startsWith(` ${PROCESSES_WIDGET_ICON}  Processes`)).toBe(true);
	expect(visibleWidth(line ?? "")).toBe(40);
	expect(renderProcessesWidgetContent(["long title"], 5)[0]?.replace(/\u001b\[[0-9;]*m/g, "")).toBe(" lo… ");
});

function makePublished(options: {
	now?: () => number;
	listEntries?: () => readonly ProcessesWidgetEntry[];
	timers?: ProcessesWidgetTimers;
} = {}) {
	const published: Array<string[] | undefined> = [];
	const fake = makeFakeTimers();
	const widget = new ProcessesWidget({
		setWidget: (content) => published.push(content),
		now: options.now ?? (() => NOW),
		listEntries: options.listEntries,
		timers: options.timers ?? fake.timers,
	});
	return { widget, published, fake };
}

test("widget starts collapsed and setActive expands it", () => {
	const { widget, published } = makePublished();
	widget.refresh([makeEntry()]);
	expect(widget.isCollapsed).toBe(true);
	expect(published[0]).toHaveLength(1);

	widget.setActive(true);
	expect(widget.isCollapsed).toBe(false);
	expect(published[published.length - 1]?.length).toBeGreaterThan(1);

	widget.setActive(false);
	expect(widget.isCollapsed).toBe(true);
	expect(published[published.length - 1]).toHaveLength(1);
});

test("refresh suppresses identical content", () => {
	const { widget, published } = makePublished();
	widget.refresh([makeEntry()]);
	widget.refresh([makeEntry()]);
	expect(published).toHaveLength(1);
});

test("refresh clears the widget when the last process expires", () => {
	const { widget, published } = makePublished();
	widget.refresh([makeEntry()]);
	widget.refresh([makeEntry({ state: "exited", endedAt: NOW - PROCESSES_DEFAULT_EXITED_RETENTION_MS - 1, exitCode: 0 })]);
	expect(published[published.length - 1]).toBeUndefined();
});

test("reset restores the collapsed default and forces a republish", () => {
	const { widget, published } = makePublished();
	widget.setActive(true);
	widget.refresh([makeEntry()]);
	expect(widget.isCollapsed).toBe(false);

	widget.reset();
	expect(widget.isCollapsed).toBe(true);
	widget.refresh([makeEntry()]);
	expect(widget.isCollapsed).toBe(true);
	expect(published[published.length - 1]).toHaveLength(1);
});

test("shutdown clears the widget", () => {
	const { widget, published } = makePublished();
	widget.refresh([makeEntry()]);
	widget.clear();
	expect(published[published.length - 1]).toBeUndefined();
});

test("running processes start exactly one bounded refresh timer while expanded", () => {
	const { widget, fake } = makePublished();
	widget.setActive(true);
	widget.refresh([makeEntry({ state: "running" })]);
	expect(fake.active).toBe(1);
	expect(fake.setDelays[0]).toBe(1000);
	widget.refresh([makeEntry({ state: "running" })]);
	expect(fake.active).toBe(1);
});

test("the collapsed widget does not run a refresh timer", () => {
	const { widget, fake } = makePublished();
	widget.refresh([makeEntry({ state: "running" })]);
	expect(fake.active).toBe(0);
});

test("collapsing stops the refresh timer and expanding restarts it", () => {
	const { widget, fake } = makePublished();
	widget.setActive(true);
	widget.refresh([makeEntry({ state: "running" })]);
	expect(fake.active).toBe(1);
	widget.setActive(false);
	expect(fake.active).toBe(0);
	widget.setActive(true);
	expect(fake.active).toBe(1);
});

test("the refresh timer stops when the last process exits", () => {
	const { widget, fake } = makePublished();
	widget.setActive(true);
	widget.refresh([makeEntry({ state: "running" })]);
	expect(fake.active).toBe(1);
	widget.refresh([makeEntry({ state: "exited", endedAt: NOW - 1_000, exitCode: 0 })]);
	expect(fake.active).toBe(0);
});

test("clear and reset stop the refresh timer", () => {
	const { widget, fake } = makePublished();
	widget.setActive(true);
	widget.refresh([makeEntry({ state: "running" })]);
	widget.clear();
	expect(fake.active).toBe(0);

	widget.setActive(true);
	widget.refresh([makeEntry({ state: "running" })]);
	widget.reset();
	expect(fake.active).toBe(0);
});

test("a silent-period tick re-reads entries and advances elapsed time", () => {
	let current = [makeEntry({ startedAt: NOW - 10_000 })];
	const { widget, published, fake } = makePublished({
		now: () => NOW,
		listEntries: () => current,
	});
	widget.setActive(true);
	widget.refresh(current);
	const before = published.length;
	current = [makeEntry({ startedAt: NOW - 40_000 })];
	fake.tick();
	expect(published.length).toBeGreaterThan(before);
	expect(published[published.length - 1]?.[1]).toContain("40s");
});
