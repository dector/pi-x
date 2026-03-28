import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Loader, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const PATCH_FLAG = "__pi_ui_working_loader_patch_v4";
const WORKING_INSTANCE_FLAG = "__pi_ui_working_loader_instance";
const GLOBAL_MIN_TRACK_LENGTH_KEY = "__pi_ui_working_min_track_length";
const GLOBAL_HUE_STEP_KEY = "__pi_ui_working_hue_step_deg";
const FRAME_TOKEN_PREFIX = "__pi_ui_frame_step:";

const RESET_FG = "\x1b[39m";
const BALL_CHAR = "·";

const DEFAULT_MIN_TRACK_LENGTH = 15;
const MIN_TRACK_LENGTH = 15;
const MAX_TRACK_LENGTH = 400;

const DEFAULT_INTERVAL_MS = 80;
const DEFAULT_HUE_STEP_DEG = 3;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function parseIntEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return parsed;
}

function parseFloatEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed)) return fallback;
	return parsed;
}

function parseTrackLength(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(parsed)) return undefined;
	if (parsed < MIN_TRACK_LENGTH || parsed > MAX_TRACK_LENGTH) return undefined;
	return parsed;
}

function setGlobalMinTrackLength(length: number): void {
	(globalThis as Record<string, unknown>)[GLOBAL_MIN_TRACK_LENGTH_KEY] = length;
}

function getGlobalMinTrackLength(): number {
	const value = (globalThis as Record<string, unknown>)[GLOBAL_MIN_TRACK_LENGTH_KEY];
	return typeof value === "number" && Number.isFinite(value)
		? clamp(Math.floor(value), MIN_TRACK_LENGTH, MAX_TRACK_LENGTH)
		: DEFAULT_MIN_TRACK_LENGTH;
}

function setGlobalHueStep(stepDeg: number): void {
	(globalThis as Record<string, unknown>)[GLOBAL_HUE_STEP_KEY] = stepDeg;
}

function getGlobalHueStep(): number {
	const value = (globalThis as Record<string, unknown>)[GLOBAL_HUE_STEP_KEY];
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_HUE_STEP_DEG;
	return clamp(value, 0.2, 30);
}

function encodeFrameStep(step: number): string {
	return `${FRAME_TOKEN_PREFIX}${step}`;
}

function decodeFrameStep(message: string): number | undefined {
	if (!message.startsWith(FRAME_TOKEN_PREFIX)) return undefined;
	const raw = message.slice(FRAME_TOKEN_PREFIX.length);
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.max(0, parsed);
}

function resolveTrackLength(width: number, minimumLength: number): number {
	if (width <= 0) return 0;
	if (width < minimumLength) return width;
	return Math.max(minimumLength, Math.floor(width / 3));
}

function positionForStep(step: number, length: number): number {
	if (length <= 1) return 0;
	const cycle = length * 2 - 2;
	const raw = step % cycle;
	return raw < length ? raw : cycle - raw;
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
	const hue = ((h % 360) + 360) % 360;
	const c = v * s;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = v - c;

	let rPrime = 0;
	let gPrime = 0;
	let bPrime = 0;

	if (hue < 60) {
		rPrime = c;
		gPrime = x;
	} else if (hue < 120) {
		rPrime = x;
		gPrime = c;
	} else if (hue < 180) {
		gPrime = c;
		bPrime = x;
	} else if (hue < 240) {
		gPrime = x;
		bPrime = c;
	} else if (hue < 300) {
		rPrime = x;
		bPrime = c;
	} else {
		rPrime = c;
		bPrime = x;
	}

	return {
		r: Math.round((rPrime + m) * 255),
		g: Math.round((gPrime + m) * 255),
		b: Math.round((bPrime + m) * 255),
	};
}

function smoothBallColor(step: number): string {
	const hue = step * getGlobalHueStep();
	const { r, g, b } = hsvToRgb(hue, 0.85, 1);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function frameForStep(step: number, length: number): string {
	const pos = positionForStep(step, length);
	const color = smoothBallColor(step);
	const left = " ".repeat(pos);
	const right = " ".repeat(Math.max(0, length - pos - 1));
	return `${left}${color}${BALL_CHAR}${RESET_FG}${right}`;
}

function centerLine(width: number, text: string): string {
	if (width <= 0) return "";
	const finalText = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	const textWidth = visibleWidth(finalText);
	const leftPad = Math.max(0, Math.floor((width - textWidth) / 2));
	const rightPad = Math.max(0, width - leftPad - textWidth);
	return `${" ".repeat(leftPad)}${finalText}${" ".repeat(rightPad)}`;
}

function patchLoaderWorkingSpinner(): void {
	const globalAny = globalThis as Record<string, unknown>;
	if (globalAny[PATCH_FLAG]) return;

	type LoaderPrivate = Loader & {
		start: (...args: unknown[]) => unknown;
		render: (width: number) => string[];
		updateDisplay?: (...args: unknown[]) => unknown;
		message?: string;
		frames?: string[];
		currentFrame?: number;
		paddingX?: number;
		setText: (text: string) => void;
		ui?: { requestRender?: () => void };
		[WORKING_INSTANCE_FLAG]?: boolean;
	};

	const loaderPrototype = Loader.prototype as unknown as LoaderPrivate;
	const originalStart = loaderPrototype.start;
	const originalRender = loaderPrototype.render;
	const originalUpdateDisplay = loaderPrototype.updateDisplay;

	loaderPrototype.start = function patchedStart(this: Loader, ...args: unknown[]) {
		const self = this as unknown as LoaderPrivate;
		const message = typeof self.message === "string" ? self.message : "";
		if (message.startsWith("Working...")) {
			self[WORKING_INSTANCE_FLAG] = true;
			self.frames = [""];
			self.currentFrame = 0;
			self.paddingX = 0;
		}
		return originalStart.apply(this, args as []);
	};

	loaderPrototype.render = function patchedRender(this: Loader, width: number) {
		const self = this as unknown as LoaderPrivate;
		if (self[WORKING_INSTANCE_FLAG]) {
			const message = typeof self.message === "string" ? self.message : "";
			const step = decodeFrameStep(message);

			const content =
				typeof step === "number"
					? frameForStep(step, resolveTrackLength(width, getGlobalMinTrackLength()))
					: message;

			return ["", centerLine(width, content)];
		}
		return originalRender.call(this, width);
	};

	if (typeof originalUpdateDisplay === "function") {
		loaderPrototype.updateDisplay = function patchedUpdateDisplay(this: Loader, ...args: unknown[]) {
			const self = this as unknown as LoaderPrivate;
			if (self[WORKING_INSTANCE_FLAG]) {
				const message = typeof self.message === "string" ? self.message : "";
				self.setText(message);
				self.ui?.requestRender?.();
				return;
			}
			return originalUpdateDisplay.apply(this, args as []);
		};
	}

	globalAny[PATCH_FLAG] = true;
}

function notify(ctx: ExtensionContext, message: string): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, "info");
}

export default function piUiExtension(pi: ExtensionAPI): void {
	patchLoaderWorkingSpinner();

	let minimumTrackLength = clamp(
		parseIntEnv("PI_UI_WORKING_LENGTH", DEFAULT_MIN_TRACK_LENGTH),
		MIN_TRACK_LENGTH,
		MAX_TRACK_LENGTH,
	);
	setGlobalMinTrackLength(minimumTrackLength);

	const intervalMs = Math.max(60, parseIntEnv("PI_UI_WORKING_INTERVAL_MS", DEFAULT_INTERVAL_MS));
	setGlobalHueStep(parseFloatEnv("PI_UI_WORKING_HUE_STEP_DEG", DEFAULT_HUE_STEP_DEG));

	let frame = 0;
	let timer: NodeJS.Timeout | undefined;
	let activeContext: ExtensionContext | undefined;

	const pushFrame = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage(encodeFrameStep(frame));
		frame += 1;
	};

	const stopAnimation = (ctx?: ExtensionContext) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		const target = ctx ?? activeContext;
		if (target?.hasUI) {
			target.ui.setWorkingMessage();
		}
		activeContext = undefined;
	};

	const startAnimation = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		stopAnimation(ctx);
		activeContext = ctx;
		frame = 0;
		pushFrame(ctx);
		timer = setInterval(() => {
			if (!activeContext?.hasUI) return;
			pushFrame(activeContext);
		}, intervalMs);
	};

	const restartIfActive = () => {
		if (!activeContext?.hasUI) return;
		startAnimation(activeContext);
	};

	pi.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	pi.registerCommand("pi-ui-working-length", {
		description: `Set minimum working indicator length (${MIN_TRACK_LENGTH}-${MAX_TRACK_LENGTH})`,
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				notify(
					ctx,
					`pi-ui minimum working length: ${minimumTrackLength} (effective length = max(width/3, minimum); env: PI_UI_WORKING_LENGTH)`,
				);
				return;
			}

			const next = parseTrackLength(trimmed);
			if (next === undefined) {
				notify(ctx, `Usage: /pi-ui-working-length <${MIN_TRACK_LENGTH}-${MAX_TRACK_LENGTH}>`);
				return;
			}

			minimumTrackLength = next;
			setGlobalMinTrackLength(minimumTrackLength);
			restartIfActive();
			notify(ctx, `pi-ui minimum working length set to ${minimumTrackLength}`);
		},
	});
}
