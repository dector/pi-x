import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, TUI, visibleWidth, type Component, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import { confirmApproval, createApprovalQueue, promptSteering } from "./approval-ui.ts";

function host(rows = 24, columns = 80) {
	let send = (_data: string) => {};
	const noop = () => {};
	const terminal: Terminal = {
		rows, columns, kittyProtocolActive: false,
		start: (onInput) => { send = onInput; }, stop: noop,
		drainInput: async () => {}, write: noop, moveBy: noop, hideCursor: noop,
		showCursor: noop, clearLine: noop, clearFromCursor: noop, clearScreen: noop,
		setTitle: noop, setProgress: noop,
	};
	const tui = new TUI(terminal);
	const notes = new Input();
	notes.setValue("unfinished notes");
	tui.addChild(notes);
	tui.setFocus(notes);
	tui.start();
	const components: Component[] = [];
	const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };
	const ctx = { hasUI: true, ui: {
		custom: (factory: Function, options: { overlay: boolean; overlayOptions: OverlayOptions }) => {
			expect(options.overlay).toBe(true);
			return new Promise((resolve) => {
				const component = factory(tui, theme, {}, (result: unknown) => { tui.hideOverlay(); resolve(result); });
				components.push(component);
				tui.showOverlay(component, options.overlayOptions);
			});
		},
		select: () => { throw new Error("select must not run in TUI"); },
		input: () => { throw new Error("input must not run in TUI"); },
	} } as unknown as ExtensionContext;
	return { ctx, tui, notes, components, send: (data: string) => send(data) };
}

for (const [key, decision] of [["Y", "approve-once"], ["y", "approve-once"], ["N", "deny"], ["A", "approve-all-session"], ["P", "approve-project"], ["\u001b", "steer"]]) {
	test(`approval shortcut ${JSON.stringify(key)} preserves underlying notes and focus`, async () => {
		const h = host();
		try {
			const result = confirmApproval(h.ctx, "Approve?", "request", { allowProjectApproval: true });
			expect(h.notes.focused).toBe(false);
			h.send(key!);
			expect(await result).toBe(decision);
			expect(h.tui.children).toEqual([h.notes]);
			expect(h.notes.getValue()).toBe("unfinished notes");
			expect(h.notes.focused).toBe(true);
			h.send("!");
			expect(h.notes.getValue()).toBe("!unfinished notes");
		} finally { h.tui.stop(); }
	});
}

test("navigation, investigation, disabled project key, and Enter stay in the focused overlay", async () => {
	const h = host();
	try {
		const investigation = { enabled: false };
		const result = confirmApproval(h.ctx, "Approve?", "request", { investigation });
		h.send("P");
		expect(h.tui.hasOverlay()).toBe(true);
		h.send("i");
		expect(investigation.enabled).toBe(true);
		expect(h.components).toHaveLength(1);
		h.send("I");
		expect(investigation.enabled).toBe(false);
		h.send("\u001b[B");
		h.send("\r");
		expect(await result).toBe("deny");
		expect(h.notes.getValue()).toBe("unfinished notes");
	} finally { h.tui.stop(); }
});

for (const [keys, expected] of [["j", "deny"], ["jk", "approve-once"], ["k", "steer"], ["kj", "approve-once"]]) {
	test(`j/k navigation ${keys} selects ${expected} without touching the draft`, async () => {
		const h = host();
		try {
			const result = confirmApproval(h.ctx, "Approve?", "request");
			for (const key of keys!) h.send(key);
			h.send("\r");
			expect(await result).toBe(expected);
			expect(h.notes.getValue()).toBe("unfinished notes");
			expect(h.notes.focused).toBe(true);
		} finally { h.tui.stop(); }
	});
}

test("long request is scrollable without cropping the approval choices", async () => {
	const h = host(24, 50);
	try {
		const result = confirmApproval(h.ctx, "Approve?", Array.from({ length: 100 }, (_, i) => `command line ${i}`).join("\n"), { allowProjectApproval: true, investigation: { enabled: false } });
		const first = h.components[0]!.render(45);
		expect(first.length).toBeLessThanOrEqual(Math.floor(24 * .9));
		expect(first[0]).toContain("╭━╾");
		expect(first.at(-1)).toContain("╰");
		expect(first[1]).toContain("┃");
		expect(first.join("\n")).toContain("[I]nvestigate");
		expect(first.join("\n")).toContain("[P]ermanently allow");
		h.send("\u001b[6~");
		expect(h.components[0]!.render(45).join("\n")).toContain("command line 5");
		h.send("N");
		await result;
	} finally { h.tui.stop(); }
});

for (const columns of [10, 20]) {
	test(`narrow terminal (${columns} columns) never renders over-width lines`, async () => {
		const h = host(24, columns);
		try {
			const width = Math.floor(columns * .9);
			const approval = confirmApproval(h.ctx, "Approve?", "long-command ".repeat(100), { allowProjectApproval: true, investigation: { enabled: false } });
			for (const line of h.components[0]!.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			h.send("\u001b[6~");
			for (const line of h.components[0]!.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			h.send("N");
			await approval;
			const steering = promptSteering(h.ctx);
			const lines = h.components[1]!.render(width);
			expect(lines).toHaveLength(4);
			expect(lines[0]).toContain("╭");
			expect(lines.at(-1)).toContain("╰");
			expect(lines.join("\n")).toContain(CURSOR_MARKER);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			h.send("\u001b");
			await steering;
		} finally { h.tui.stop(); }
	});
}

for (const rows of [6, 12, 14]) {
	test(`short terminal (${rows} rows) keeps request accessible with gap-free paging`, async () => {
		const h = host(rows, 50);
		try {
			const result = confirmApproval(h.ctx, "Approve?", Array.from({ length: 20 }, (_, i) => `request-${i}`).join("\n"), { allowProjectApproval: true, investigation: { enabled: false } });
			let previousLast = -1;
			for (let page = 0; page < 20; page++) {
				const lines = h.components[0]!.render(45);
				expect(lines.length).toBeLessThanOrEqual(Math.min(Math.floor(rows * .9), rows - 2));
				const seen = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/^┃|┃$/g, "").trim()).filter((line) => line.startsWith("request-")).map((line) => Number(line.slice(8)));
				expect(seen.length).toBeGreaterThan(0);
				expect(seen[0]!).toBeLessThanOrEqual(previousLast + 1);
				previousLast = seen.at(-1)!;
				if (previousLast === 19) break;
				h.send("\u001b[6~");
			}
			expect(previousLast).toBe(19);
			h.send("P");
			expect(await result).toBe("approve-project");
		} finally { h.tui.stop(); }
	});
}

test("queue holds ownership through steering, restores notes focus, and resumes next approval", async () => {
	const h = host();
	const queue = createApprovalQueue();
	try {
		const first = queue(async () => {
			expect(await confirmApproval(h.ctx, "Approve?", "first")).toBe("steer");
			return promptSteering(h.ctx);
		});
		const second = queue(() => confirmApproval(h.ctx, "Approve?", "second"));
		await Promise.resolve();
		h.send("\u001b");
		// Allow the custom/approval awaits to reach the steering factory.
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(h.components).toHaveLength(2);
		expect(h.components[1]!.render(70).join("\n")).toContain(CURSOR_MARKER);
		h.send("use read instead");
		h.send("\r");
		expect(await first).toBe("use read instead");
		for (let i = 0; i < 8; i++) await Promise.resolve();
		expect(h.components).toHaveLength(3);
		h.send("N");
		expect(await second).toBe("deny");
		expect(h.notes.getValue()).toBe("unfinished notes");
		expect(h.notes.focused).toBe(true);
	} finally { h.tui.stop(); }
});

test("steering cancellation restores the prior overlay and its focused input", async () => {
	const h = host();
	try {
		const menu = new Input();
		menu.setValue("menu draft");
		h.tui.showOverlay(menu);
		const result = promptSteering(h.ctx);
		h.send("\u001b");
		expect(await result).toBeUndefined();
		expect(menu.focused).toBe(true);
		expect(menu.getValue()).toBe("menu draft");
		expect(h.notes.getValue()).toBe("unfinished notes");
	} finally { h.tui.stop(); }
});

for (const custom of [undefined, async () => undefined]) {
	test(`RPC fallback with ${custom ? "no-op" : "absent"} custom uses host dialogs`, async () => {
		const investigation = { enabled: false };
		let calls = 0;
		const ctx = { hasUI: true, ui: {
			custom,
			select: async (_title: string, options: string[]) => {
				calls++;
				if (calls === 1) return options.at(-1);
				return "[P]ermanently allow";
			},
			input: async () => "safer approach",
		} } as unknown as ExtensionContext;
		expect(await confirmApproval(ctx, "Approve?", "request", { allowProjectApproval: true, investigation })).toBe("approve-project");
		expect(investigation.enabled).toBe(true);
		expect(await promptSteering(ctx)).toBe("safer approach");
	});
}

test("failed custom does not fall back, and a rejected sequence does not poison the queue", async () => {
	const queue = createApprovalQueue();
	const ctx = { ui: { custom: async () => { throw new Error("UI failed"); }, select: () => { throw new Error("unexpected fallback"); } } } as unknown as ExtensionContext;
	await expect(queue(() => confirmApproval(ctx, "Approve?", "request"))).rejects.toThrow("UI failed");
	expect(await queue(async () => "next")).toBe("next");
});
