import { describe, expect, test } from "bun:test";
import { FocusModeViewport, resolveGeometry, resolveMargin } from "./viewport";

const ESC = "\u001B";

class FakeStdout {
	columns?: number;
	written: string[] = [];
	resizes = 0;

	write(chunk: unknown): boolean {
		if (typeof chunk === "string") this.written.push(chunk);
		return true;
	}

	emit(event: string, ..._args: unknown[]): boolean {
		if (event === "resize") this.resizes += 1;
		return true;
	}
}

class FakeStdin {
	seen: unknown[] = [];

	emit(event: string, ...args: unknown[]): boolean {
		if (event === "data") this.seen.push(args[0]);
		return true;
	}
}

function setup(columns: number) {
	const stdout = new FakeStdout();
	stdout.columns = columns;
	const stdin = new FakeStdin();
	const viewport = new FocusModeViewport({ stdout, stdin });
	viewport.install();
	return { stdout, stdin, viewport };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("resolveMargin", () => {
	test("centers without a bias", () => {
		expect(resolveMargin(80, 0)).toBe(40);
		expect(resolveMargin(81, 0)).toBe(40);
	});

	test("bias -100 is flush against the left edge", () => {
		expect(resolveMargin(80, -100)).toBe(0);
		expect(resolveMargin(81, -100)).toBe(0);
	});

	test("bias 100 is flush against the right edge", () => {
		expect(resolveMargin(80, 100)).toBe(80);
		expect(resolveMargin(81, 100)).toBe(81);
	});

	test("halfway biases sit a quarter of the slack from an edge", () => {
		expect(resolveMargin(100, -50)).toBe(25);
		expect(resolveMargin(100, 50)).toBe(75);
		expect(resolveMargin(80, -50)).toBe(20);
		expect(resolveMargin(80, 50)).toBe(60);
	});

	test("a quarter bias moves an eighth of the slack", () => {
		expect(resolveMargin(80, -25)).toBe(30);
		expect(resolveMargin(80, 25)).toBe(50);
	});

	test("the column is monotonic in the bias", () => {
		const margins = [-100, -75, -50, -25, 0, 25, 50, 75, 100].map((bias) => resolveMargin(100, bias));
		expect(margins).toEqual([...margins].sort((a, b) => a - b));
		expect(margins[0]).toBe(0);
		expect(margins.at(-1)).toBe(100);
	});

	test("clamps instead of pushing the column off screen", () => {
		expect(resolveMargin(80, -400)).toBe(0);
		expect(resolveMargin(80, 400)).toBe(80);
		expect(resolveMargin(0, -50)).toBe(0);
	});
});

describe("resolveGeometry", () => {
	test("is a pass-through when disabled", () => {
		expect(resolveGeometry(240, false, 100)).toEqual({ realWidth: 240, effectiveWidth: 240, margin: 0, narrowed: false });
	});

	test("centers the reading column", () => {
		expect(resolveGeometry(240, true, 100)).toEqual({ realWidth: 240, effectiveWidth: 100, margin: 70, narrowed: true });
	});

	test("rounds the margin down so the extra cell lands on the right", () => {
		expect(resolveGeometry(201, true, 100)).toEqual({ realWidth: 201, effectiveWidth: 100, margin: 50, narrowed: true });
	});

	test("never adds a margin to a screen that already fits", () => {
		expect(resolveGeometry(80, true, 100)).toEqual({ realWidth: 80, effectiveWidth: 80, margin: 0, narrowed: false });
		expect(resolveGeometry(100, true, 100)).toEqual({ realWidth: 100, effectiveWidth: 100, margin: 0, narrowed: false });
	});

	test("a one column slack counts as narrowed even with a zero margin", () => {
		expect(resolveGeometry(101, true, 100)).toEqual({ realWidth: 101, effectiveWidth: 100, margin: 0, narrowed: true });
	});
});

describe("FocusModeViewport", () => {
	test("reports the real width until it is configured", () => {
		const { stdout, viewport } = setup(240);
		expect(stdout.columns).toBe(240);
		expect(viewport.isEnabled).toBe(false);
	});

	test("reports the narrow width and shifts output once configured", () => {
		const { stdout, viewport } = setup(240);
		expect(viewport.configure({ enabled: true, target: 120 })).toBe(true);
		expect(stdout.columns).toBe(120);

		// A cursor move already lands in the right column, so only the line
		// start sequences need padding.
		stdout.write(`${ESC}[1;1Hhello`);
		expect(stdout.written.at(-1)).toBe(`${ESC}[1;61Hhello`);
		stdout.write("\r\nworld");
		expect(stdout.written.at(-1)).toBe(`\r\n${" ".repeat(60)}world`);
		expect(stdout.resizes).toBe(1);
	});

	test("leaves a screen that already fits completely alone", () => {
		const { stdout, viewport } = setup(100);
		expect(viewport.configure({ enabled: true, target: 120 })).toBe(false);
		expect(stdout.columns).toBe(100);

		const frame = `${ESC}[1;1Hhello\r\nworld`;
		stdout.write(frame);
		expect(stdout.written.at(-1)).toBe(frame);
		expect(stdout.resizes).toBe(0);
	});

	test("is byte identical while disabled", () => {
		const { stdout, viewport } = setup(240);
		viewport.configure({ enabled: false, target: 120 });
		expect(stdout.columns).toBe(240);

		const frame = `${ESC}[1;1Hhello\r\nworld`;
		stdout.write(frame);
		expect(stdout.written.at(-1)).toBe(frame);
	});

	test("shifts mouse reports back to the rendered column", () => {
		const { stdout, stdin, viewport } = setup(240);
		viewport.configure({ enabled: true, target: 120 });

		stdin.emit("data", `${ESC}[<0;100;4M`);
		expect(stdin.seen.at(-1)).toBe(`${ESC}[<0;40;4M`);

		stdin.emit("data", "typed text");
		expect(stdin.seen.at(-1)).toBe("typed text");
	});

	test("follows a terminal resize that moves the margin", async () => {
		const { stdout, viewport } = setup(240);
		viewport.configure({ enabled: true, target: 120 });
		const resizesAfterEnable = stdout.resizes;

		// Node assigns the new size on stdout, then emits "resize". Only the
		// margin moved, so pi needs the two-pass repaint.
		stdout.columns = 300;
		expect(viewport.desiredGeometry().margin).toBe(90);
		expect(stdout.columns).toBe(300);
		expect(stdout.resizes).toBe(resizesAfterEnable + 1);

		// The full-width repaint lands, which arms the narrow one.
		stdout.write(`${ESC}[1;1Hx`);
		expect(stdout.written.at(-1)).toBe(`${ESC}[1;1Hx`);
		await flush();

		expect(stdout.columns).toBe(120);
		expect(viewport.desiredGeometry().margin).toBe(90);
		expect(stdout.resizes).toBe(resizesAfterEnable + 2);
	});

	test("repaints in one step when a resize also changes the width", () => {
		const { stdout, viewport } = setup(240);
		viewport.configure({ enabled: true, target: 120 });
		const resizesAfterEnable = stdout.resizes;

		stdout.columns = 100;
		expect(stdout.columns).toBe(100);
		expect(stdout.resizes).toBe(resizesAfterEnable + 1);
	});

	test("restore puts the streams back", () => {
		const { stdout, stdin, viewport } = setup(240);
		viewport.configure({ enabled: true, target: 120 });
		viewport.restore();

		expect(stdout.columns).toBe(240);
		expect(stdout.write).toBe(FakeStdout.prototype.write);
		expect(stdin.emit).toBe(FakeStdin.prototype.emit);
	});

	test("a reloaded extension shares the patch instead of stacking it", () => {
		const { stdout, viewport } = setup(240);
		viewport.configure({ enabled: true, target: 120 });

		const reloaded = new FocusModeViewport({ stdout, stdin: new FakeStdin() });
		reloaded.configure({ enabled: true, target: 120 });
		expect(stdout.columns).toBe(120);

		// Shifted once, not twice.
		stdout.write(`${ESC}[1;1Hx`);
		expect(stdout.written.at(-1)).toBe(`${ESC}[1;61Hx`);
	});

	test("moves the column sideways with a bias", async () => {
		const { stdout, viewport } = setup(240);
		// 240 wide, 100 column reading column: 140 cells of slack.
		viewport.configure({ enabled: true, target: 100, bias: -100 });
		expect(viewport.desiredGeometry().margin).toBe(0);
		expect(stdout.columns).toBe(100);

		const frame = "\r\nhello";
		stdout.write(frame);
		expect(stdout.written.at(-1)).toBe(frame);

		// A margin-only change repaints in two passes, so the first frame out
		// after the switch is the full-width one.
		viewport.configure({ enabled: true, target: 100, bias: 100 });
		expect(viewport.desiredGeometry().margin).toBe(140);
		stdout.write(frame);
		expect(stdout.written.at(-1)).toBe(frame);

		await flush();
		stdout.write(frame);
		expect(stdout.written.at(-1)).toBe(`\r\n${" ".repeat(140)}hello`);
	});

	test("keeps the bias when only the width changes", () => {
		const { viewport } = setup(240);
		viewport.configure({ enabled: true, target: 100, bias: -50 });
		viewport.configure({ enabled: true, target: 120 });
		expect(viewport.bias).toBe(-50);
		// 120 slack, biased -50: a quarter of it on the left.
		expect(viewport.desiredGeometry().margin).toBe(30);
	});

	test("describes the effective layout", () => {
		const { viewport } = setup(240);
		viewport.configure({ enabled: true, target: 120 });
		expect(viewport.describe()).toBe("focus: 120 columns in 240, 60 column left margin (centered)");

		viewport.configure({ enabled: true, target: 120, bias: -100 });
		expect(viewport.describe()).toBe("focus: 120 columns in 240, 0 column left margin (left-biased 100%)");

		const small = setup(100);
		small.viewport.configure({ enabled: true, target: 120 });
		expect(small.viewport.describe()).toContain("screen is only 100 wide");
	});
});
