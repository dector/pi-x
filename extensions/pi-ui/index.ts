import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Loader } from "@mariozechner/pi-tui";

const PATCH_FLAG = "__pi_ui_working_loader_patch_v2";
const WORKING_INSTANCE_FLAG = "__pi_ui_working_loader_instance";
const RESET_FG = "\x1b[39m";
const BALL_CHAR = "·";
const DEFAULT_TRACK_LENGTH = 5;
const MIN_TRACK_LENGTH = 2;
const MAX_TRACK_LENGTH = 40;
const DEFAULT_INTERVAL_MS = 160;

const BALL_COLORS = [
	"\x1b[38;5;196m", // red
	"\x1b[38;5;208m", // orange
	"\x1b[38;5;226m", // yellow
	"\x1b[38;5;46m", // green
	"\x1b[38;5;51m", // cyan
	"\x1b[38;5;27m", // blue
	"\x1b[38;5;201m", // magenta
] as const;

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

function parseTrackLength(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(parsed)) return undefined;
	if (parsed < MIN_TRACK_LENGTH || parsed > MAX_TRACK_LENGTH) return undefined;
	return parsed;
}

function patchLoaderWorkingSpinner(): void {
	const globalAny = globalThis as Record<string, unknown>;
	if (globalAny[PATCH_FLAG]) return;

	type LoaderPrivate = Loader & {
		start: (...args: unknown[]) => unknown;
		updateDisplay?: (...args: unknown[]) => unknown;
		message?: string;
		frames?: string[];
		currentFrame?: number;
		paddingX?: number;
		setText: (text: string) => void;
		messageColorFn?: (text: string) => string;
		ui?: { requestRender?: () => void };
		[WORKING_INSTANCE_FLAG]?: boolean;
	};

	const loaderPrototype = Loader.prototype as unknown as LoaderPrivate;
	const originalStart = loaderPrototype.start;
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

	if (typeof originalUpdateDisplay === "function") {
		loaderPrototype.updateDisplay = function patchedUpdateDisplay(this: Loader, ...args: unknown[]) {
			const self = this as unknown as LoaderPrivate;
			if (self[WORKING_INSTANCE_FLAG]) {
				const message = typeof self.message === "string" ? self.message : "";
				const colorize = typeof self.messageColorFn === "function" ? self.messageColorFn : (text: string) => text;
				self.setText(colorize(message));
				self.ui?.requestRender?.();
				return;
			}
			return originalUpdateDisplay.apply(this, args as []);
		};
	}

	globalAny[PATCH_FLAG] = true;
}

function positionForStep(step: number, length: number): number {
	if (length <= 1) return 0;
	const cycle = length * 2 - 2;
	const raw = step % cycle;
	return raw < length ? raw : cycle - raw;
}

function frameForStep(step: number, length: number): string {
	const pos = positionForStep(step, length);
	const color = BALL_COLORS[step % BALL_COLORS.length] ?? BALL_COLORS[0];
	const left = " ".repeat(pos);
	const right = " ".repeat(Math.max(0, length - pos - 1));
	return `[${left}${color}${BALL_CHAR}${RESET_FG}${right}]`;
}

function notify(ctx: ExtensionContext, message: string): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, "info");
}

export default function piUiExtension(pi: ExtensionAPI): void {
	patchLoaderWorkingSpinner();

	let trackLength = clamp(parseIntEnv("PI_UI_WORKING_LENGTH", DEFAULT_TRACK_LENGTH), MIN_TRACK_LENGTH, MAX_TRACK_LENGTH);
	const intervalMs = Math.max(60, parseIntEnv("PI_UI_WORKING_INTERVAL_MS", DEFAULT_INTERVAL_MS));

	let frame = 0;
	let timer: NodeJS.Timeout | undefined;
	let activeContext: ExtensionContext | undefined;

	const pushFrame = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage(frameForStep(frame, trackLength));
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
		description: `Set working indicator track length (${MIN_TRACK_LENGTH}-${MAX_TRACK_LENGTH})`,
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				notify(ctx, `pi-ui working length: ${trackLength} (env: PI_UI_WORKING_LENGTH)`);
				return;
			}

			const next = parseTrackLength(trimmed);
			if (next === undefined) {
				notify(ctx, `Usage: /pi-ui-working-length <${MIN_TRACK_LENGTH}-${MAX_TRACK_LENGTH}>`);
				return;
			}

			trackLength = clamp(next, MIN_TRACK_LENGTH, MAX_TRACK_LENGTH);
			restartIfActive();
			notify(ctx, `pi-ui working length set to ${trackLength}`);
		},
	});
}
