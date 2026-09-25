import { shiftInputMouseColumns, shiftOutputColumns } from "./transform";

/** Smallest column count a TUI can be squeezed into. */
export const MIN_WIDTH = 20;

/** Upper bound, so a typo cannot ask for a 100k column layout. */
export const MAX_WIDTH = 2000;

export const DEFAULT_WIDTH = 100;

/**
 * Percent of the leftover space to move the column sideways.
 *
 * `-100` puts the left edge of the column at the left edge of the screen, `0`
 * centers it, `+100` puts its right edge at the right edge of the screen.
 */
export const DEFAULT_BIAS = 0;
export const MIN_BIAS = -100;
export const MAX_BIAS = 100;

/** Safety net for the two-step repaint if no frame reaches the terminal. */
const NUDGE_TIMEOUT_MS = 250;

/**
 * Shared across extension reloads: pi re-imports extension modules in the same
 * process, and a second patch of the same streams would shift output twice.
 */
const PATCH_KEY = Symbol.for("pi-x.narrow.patch");

export interface Geometry {
	/** Real terminal width in columns. */
	realWidth: number;
	/** Width pi is told to render at. */
	effectiveWidth: number;
	/** Cells of blank space kept on the left of the column. */
	margin: number;
	/** True when the rendered column is strictly narrower than the screen. */
	narrowed: boolean;
}

export interface OutputStreamLike {
	columns?: number;
	write(...args: unknown[]): unknown;
	emit?(event: string, ...args: unknown[]): unknown;
}

export interface InputStreamLike {
	emit(event: string, ...args: unknown[]): unknown;
}

export interface NarrowOptions {
	stdout?: OutputStreamLike;
	stdin?: InputStreamLike;
}

interface PatchState {
	installed: boolean;
	enabled: boolean;
	target: number;
	bias: number;
	realColumns: number;
	/** While true, pi is told the real width and no output is shifted. */
	suspended: boolean;
	/** True between the full-width repaint request and the frame landing. */
	nudgeArmed: boolean;
	nudgeTimer?: ReturnType<typeof setTimeout>;
	originalColumns?: PropertyDescriptor;
	originalWrite?: OutputStreamLike["write"];
	originalStdinEmit?: InputStreamLike["emit"];
}

export function clampWidth(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_WIDTH;
	return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(value)));
}

export function clampBias(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_BIAS;
	return Math.min(MAX_BIAS, Math.max(MIN_BIAS, Math.round(value)));
}

/**
 * Where the left edge of the column sits.
 *
 * Half of the leftover space centers it. The bias then slides it sideways by
 * that percentage of the leftover space: -100 is flush left, 0 is centered,
 * +100 is flush right. The result is clamped so the column always stays whole
 * on screen.
 */
export function resolveMargin(slack: number, biasPercent: number): number {
	if (slack <= 0) return 0;
	const shifted = Math.floor(slack / 2) + Math.round((slack * biasPercent) / 200);
	return Math.min(slack, Math.max(0, shifted));
}

/**
 * Resolve the layout for a screen of `realWidth` columns.
 *
 * A screen that is already narrower than the target is left completely alone:
 * no margin, and pi is told the real width, so its output is byte for byte what
 * it would have been without this extension.
 */
export function resolveGeometry(realWidth: number, enabled: boolean, target: number, biasPercent = DEFAULT_BIAS): Geometry {
	const safeReal = Number.isFinite(realWidth) && realWidth >= 1 ? Math.floor(realWidth) : 1;
	if (!enabled || target < 1) {
		return { realWidth: safeReal, effectiveWidth: safeReal, margin: 0, narrowed: false };
	}

	const effectiveWidth = Math.min(safeReal, clampWidth(target));
	const margin = resolveMargin(safeReal - effectiveWidth, clampBias(biasPercent));
	return { realWidth: safeReal, effectiveWidth, margin, narrowed: effectiveWidth < safeReal };
}

function readInitialColumns(stdout: OutputStreamLike, descriptor: PropertyDescriptor | undefined): number {
	const fromDescriptor = typeof descriptor?.get === "function" ? descriptor.get.call(stdout) : descriptor?.value;
	const candidate = typeof fromDescriptor === "number" ? fromDescriptor : stdout.columns;
	if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) return Math.floor(candidate);

	const fromEnv = Number.parseInt(process.env.COLUMNS ?? "", 10);
	return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 80;
}

function readPatch(stdout: OutputStreamLike): PatchState | undefined {
	return (stdout as unknown as Record<symbol, PatchState | undefined>)[PATCH_KEY];
}

/**
 * Constrains pi to a centered column of at most `target` columns.
 *
 * pi reads its render width from `process.stdout.columns` and nothing else, so
 * reporting a smaller number makes the whole interface wrap at that width. The
 * column is centered by shifting every column-addressing escape sequence in
 * pi's output to the right, and mouse reports back to the left.
 *
 * This is built on process-level plumbing rather than pi internals so it
 * survives TUI mode switches, `/clear`, and pi recreating its renderer.
 */
export class NarrowViewport {
	private readonly stdout: OutputStreamLike;
	private readonly stdin: InputStreamLike | undefined;
	private readonly state: PatchState;

	constructor(options: NarrowOptions = {}) {
		this.stdout = options.stdout ?? (process.stdout as unknown as OutputStreamLike);
		this.stdin = options.stdin ?? (process.stdin as unknown as InputStreamLike);
		this.state = readPatch(this.stdout) ?? {
			installed: false,
			enabled: false,
			target: DEFAULT_WIDTH,
			bias: DEFAULT_BIAS,
			realColumns: DEFAULT_WIDTH,
			suspended: false,
			nudgeArmed: false,
		};
	}

	get isInstalled(): boolean {
		return this.state.installed;
	}

	get isEnabled(): boolean {
		return this.state.enabled;
	}

	get targetWidth(): number {
		return this.state.target;
	}

	get bias(): number {
		return this.state.bias;
	}

	/** Geometry as pi currently sees it, including any repaint in flight. */
	geometry(): Geometry {
		const { realColumns, enabled, target, bias, suspended } = this.state;
		return resolveGeometry(realColumns, enabled && !suspended, target, bias);
	}

	/** Geometry the configuration asks for, ignoring repaint bookkeeping. */
	desiredGeometry(): Geometry {
		return resolveGeometry(this.state.realColumns, this.state.enabled, this.state.target, this.state.bias);
	}

	/**
	 * Wrap the stdio streams. Installing changes no behavior on its own: the
	 * reported width only differs from the real width once narrow mode is on.
	 */
	install(): void {
		if (this.state.installed) return;

		const stdout = this.stdout;
		const stdin = this.stdin;
		const originalWrite = stdout.write;
		const originalStdinEmit = stdin?.emit;
		if (typeof originalWrite !== "function") return;

		const state = this.state;
		state.originalColumns = Object.getOwnPropertyDescriptor(stdout, "columns");
		state.originalWrite = originalWrite;
		state.originalStdinEmit = originalStdinEmit;
		state.realColumns = readInitialColumns(stdout, state.originalColumns);
		state.installed = true;

		Object.defineProperty(stdout, "columns", {
			configurable: true,
			enumerable: true,
			get: () => this.geometry().effectiveWidth,
			set: (value: unknown) => this.absorbRealColumns(value),
		});

		stdout.write = (...args: unknown[]) => {
			const margin = this.geometry().margin;
			if (margin > 0 && typeof args[0] === "string") {
				args[0] = shiftOutputColumns(args[0], margin);
			}

			const written = originalWrite.apply(stdout, args as Parameters<typeof originalWrite>);
			this.finishNudge();
			return written;
		};

		if (stdin && typeof originalStdinEmit === "function") {
			stdin.emit = (event: string, ...args: unknown[]) => {
				const margin = this.geometry().margin;
				if (event === "data" && margin > 0 && typeof args[0] === "string") {
					args[0] = shiftInputMouseColumns(args[0], margin);
				}
				return originalStdinEmit.apply(stdin, [event, ...args] as Parameters<typeof originalStdinEmit>);
			};
		}

		(stdout as unknown as Record<symbol, PatchState>)[PATCH_KEY] = state;
	}

	/** Put the stdio streams back exactly as they were. */
	restore(): void {
		const state = this.state;
		if (state.nudgeTimer) {
			clearTimeout(state.nudgeTimer);
			state.nudgeTimer = undefined;
		}
		state.nudgeArmed = false;
		state.suspended = false;

		if (!state.installed) return;

		if (state.originalColumns) {
			Object.defineProperty(this.stdout, "columns", state.originalColumns);
		} else {
			delete (this.stdout as { columns?: number }).columns;
		}
		if (state.originalWrite) this.stdout.write = state.originalWrite;
		if (this.stdin && state.originalStdinEmit) this.stdin.emit = state.originalStdinEmit;
		delete (this.stdout as unknown as Record<symbol, PatchState | undefined>)[PATCH_KEY];

		state.installed = false;
		state.originalColumns = undefined;
		state.originalWrite = undefined;
		state.originalStdinEmit = undefined;
	}

	/**
	 * Apply a new configuration. Returns true when the rendered geometry moved,
	 * which is also when pi needs to be asked to repaint.
	 */
	configure(next: { enabled: boolean; target: number; bias?: number }): boolean {
		if (!this.state.installed) this.install();

		const before = this.desiredGeometry();
		this.state.enabled = next.enabled;
		this.state.target = clampWidth(next.target);
		this.state.bias = next.bias === undefined ? this.state.bias : clampBias(next.bias);
		const after = this.desiredGeometry();

		const widthMoved = before.effectiveWidth !== after.effectiveWidth;
		const marginMoved = before.margin !== after.margin;
		if (!widthMoved && !marginMoved) return false;

		// A width change alone makes pi repaint everything. A margin change on
		// its own does not, because pi only knows the width it renders at.
		if (widthMoved) this.emitResize();
		else this.nudgeRedraw();
		return true;
	}

	/** Node assigns the real size on stdout whenever the terminal is resized. */
	private absorbRealColumns(value: unknown): void {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return;
		const next = Math.floor(value);
		if (next === this.state.realColumns) return;

		const before = this.desiredGeometry();
		this.state.realColumns = next;
		const after = this.desiredGeometry();
		if (before.effectiveWidth !== after.effectiveWidth) this.emitResize();
		else if (before.margin !== after.margin) this.nudgeRedraw();
	}

	private emitResize(): void {
		try {
			this.stdout.emit?.("resize");
		} catch {
			// A terminal that cannot be written to is not worth crashing over.
		}
	}

	/**
	 * Repaint at full width first, then repaint narrow. pi rewrites changed rows
	 * only, so a margin that moved without a width change needs two passes: the
	 * first changes the width pi sees, the second lands the new offset.
	 */
	private nudgeRedraw(): void {
		const state = this.state;
		if (state.nudgeTimer) clearTimeout(state.nudgeTimer);
		state.suspended = true;
		state.nudgeArmed = true;
		this.emitResize();

		const timer = setTimeout(() => {
			state.nudgeTimer = undefined;
			state.suspended = false;
			state.nudgeArmed = false;
			this.emitResize();
		}, NUDGE_TIMEOUT_MS);
		timer.unref?.();
		state.nudgeTimer = timer;
	}

	/** Called after every write, so the second repaint can start off-tick. */
	private finishNudge(): void {
		const state = this.state;
		if (!state.nudgeArmed) return;
		state.nudgeArmed = false;
		state.suspended = false;
		if (state.nudgeTimer) {
			clearTimeout(state.nudgeTimer);
			state.nudgeTimer = undefined;
		}
		process.nextTick(() => this.emitResize());
	}

	describe(): string {
		const geometry = this.desiredGeometry();
		if (!this.state.enabled) {
			return `narrow: off (full width, ${geometry.realWidth} columns)`;
		}
		if (!geometry.narrowed) {
			return `narrow: on at ${this.state.target} columns, but the screen is only ${geometry.realWidth} wide (no margin)`;
		}

		const where =
			this.state.bias === 0 ? "centered" : `${this.state.bias < 0 ? "left" : "right"}-biased ${Math.abs(this.state.bias)}%`;
		return `narrow: ${geometry.effectiveWidth} columns in ${geometry.realWidth}, ${geometry.margin} column left margin (${where})`;
	}
}
