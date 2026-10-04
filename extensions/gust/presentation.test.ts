import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GustPresentation } from "./presentation.ts";

function destination() {
	const statuses: unknown[] = [];
	const widgets: unknown[] = [];
	const ui = {
		setStatus: (...args: unknown[]) => { statuses.push(args); },
		setWidget: (...args: unknown[]) => { widgets.push(args); },
	};
	return { ctx: { ui, hasUI: true } as unknown as ExtensionContext, statuses, widgets };
}

test("statuses publish initial clears, deduplicate per key/UI, and reset", () => {
	const cache = new GustPresentation();
	const a = destination();
	cache.setStatus(a.ctx, "gust", undefined);
	cache.setStatus({ ...a.ctx }, "gust", undefined);
	cache.setStatus(a.ctx, "gust", "running");
	cache.setStatus(a.ctx, "gust", "running");
	cache.setStatus(a.ctx, "gust-hold", "running");
	cache.setStatus(a.ctx, "gust", undefined);
	expect(a.statuses).toHaveLength(4);
	const b = destination();
	cache.setStatus(b.ctx, "gust", undefined);
	expect(b.statuses).toHaveLength(1);
	cache.reset();
	cache.setStatus(b.ctx, "gust", undefined);
	expect(b.statuses).toHaveLength(2);
});

test("widgets compare snapshots, placement and clears, not array or factory identity", () => {
	const cache = new GustPresentation();
	const a = destination();
	const lines = ["one", "two"];
	cache.setWidget(a.ctx, "gust", lines);
	cache.setWidget(a.ctx, "gust", ["one", "two"], { placement: "aboveEditor" });
	expect(a.widgets).toHaveLength(1);
	lines[0] = "changed";
	cache.setWidget(a.ctx, "gust", lines);
	cache.setWidget(a.ctx, "gust", lines, { placement: "belowEditor" });
	cache.setWidget(a.ctx, "gust", ["changed"]);
	const factory = () => ({ render: () => lines, invalidate() {} });
	cache.setWidget(a.ctx, "gust", factory);
	cache.setWidget(a.ctx, "gust", factory);
	cache.setWidget(a.ctx, "gust", ["changed"]);
	cache.setWidget(a.ctx, "gust", undefined);
	cache.setWidget(a.ctx, "gust", undefined);
	expect(a.widgets).toHaveLength(8);
	const b = destination();
	cache.setWidget(b.ctx, "gust", undefined);
	expect(b.widgets).toHaveLength(1);
	cache.reset();
	cache.setWidget(b.ctx, "gust", undefined);
	expect(b.widgets).toHaveLength(2);
});

test("failed publications are retried and guarded contexts are still read", () => {
	const cache = new GustPresentation();
	const a = destination();
	const setStatus = a.ctx.ui.setStatus;
	a.ctx.ui.setStatus = () => { throw new Error("gone"); };
	expect(() => cache.setStatus(a.ctx, "gust", "running")).toThrow("gone");
	a.ctx.ui.setStatus = setStatus;
	cache.setStatus(a.ctx, "gust", "running");
	expect(a.statuses).toHaveLength(1);
	cache.setWidget(a.ctx, "gust", ["running"]);
	const setWidget = a.ctx.ui.setWidget;
	a.ctx.ui.setWidget = () => { throw new Error("partial removal"); };
	expect(() => cache.setWidget(a.ctx, "gust", () => ({ render: () => [], invalidate() {} }))).toThrow();
	a.ctx.ui.setWidget = setWidget;
	cache.setWidget(a.ctx, "gust", ["running"]);
	expect(a.widgets).toHaveLength(2);
	const stale = { get ui() { throw new Error("stale"); } } as unknown as ExtensionContext;
	expect(() => cache.setStatus(stale, "gust", "running")).toThrow("stale");
});
