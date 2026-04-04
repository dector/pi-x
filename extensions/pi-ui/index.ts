import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, Loader, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const PATCH_FLAG = "__pi_ui_working_loader_patch_v6";
const WORKING_INSTANCE_FLAG = "__pi_ui_working_loader_instance";
const GLOBAL_MIN_TRACK_LENGTH_KEY = "__pi_ui_working_min_track_length";
const GLOBAL_HUE_STEP_KEY = "__pi_ui_working_hue_step_deg";
const GLOBAL_BELL_ENABLED_KEY = "__pi_ui_bell_enabled";
const GLOBAL_BELL_DEBOUNCE_MS_KEY = "__pi_ui_bell_debounce_ms";
const GLOBAL_BELL_LAST_RING_MS_KEY = "__pi_ui_bell_last_ring_ms";
const UI_INPUT_PATCH_FLAG = "__pi_ui_bell_ui_input_patch_v1";
const FRAME_TOKEN_PREFIX = "__pi_ui_frame_step:";
const SAFE_MODE_TOGGLE_READER_EVENT = "safe-mode:toggle-reader";
const SAFE_MODE_TOGGLE_OUTER_EVENT = "safe-mode:toggle-outer";
const SAFE_MODE_SET_YOLO_PLUS_EVENT = "safe-mode:set-yolo-plus";

const RESET_FG = "\x1b[39m";
const BELL_CHAR = "\x07";
const ESC = "\u001b";

// Thick pipe phases inside a single terminal cell: left, center, right.
const PIPE_PHASE_CHARS = ["▌", "┃", "▐"] as const;

const DEFAULT_MIN_TRACK_LENGTH = 15;
const MIN_TRACK_LENGTH = 15;
const MAX_TRACK_LENGTH = 400;

// Faster defaults
const DEFAULT_INTERVAL_MS = 16;
const DEFAULT_HUE_STEP_DEG = 8;
const DEFAULT_BELL_ENABLED = true;
const DEFAULT_BELL_DEBOUNCE_MS = 250;
const MIN_BELL_DEBOUNCE_MS = 0;
const MAX_BELL_DEBOUNCE_MS = 5_000;

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

function parseBooleanEnv(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (!value) return fallback;
	const raw = value.trim().toLowerCase();
	if (raw.length === 0) return fallback;
	if (["1", "true", "yes", "on", "y"].includes(raw)) return true;
	if (["0", "false", "no", "off", "n"].includes(raw)) return false;
	return fallback;
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
	return clamp(value, 0.2, 60);
}

function setGlobalBellEnabled(enabled: boolean): void {
	(globalThis as Record<string, unknown>)[GLOBAL_BELL_ENABLED_KEY] = enabled;
}

function getGlobalBellEnabled(): boolean {
	const value = (globalThis as Record<string, unknown>)[GLOBAL_BELL_ENABLED_KEY];
	return typeof value === "boolean" ? value : DEFAULT_BELL_ENABLED;
}

function setGlobalBellDebounceMs(debounceMs: number): void {
	(globalThis as Record<string, unknown>)[GLOBAL_BELL_DEBOUNCE_MS_KEY] = debounceMs;
}

function getGlobalBellDebounceMs(): number {
	const value = (globalThis as Record<string, unknown>)[GLOBAL_BELL_DEBOUNCE_MS_KEY];
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BELL_DEBOUNCE_MS;
	return clamp(Math.floor(value), MIN_BELL_DEBOUNCE_MS, MAX_BELL_DEBOUNCE_MS);
}

function getGlobalLastBellRingMs(): number {
	const value = (globalThis as Record<string, unknown>)[GLOBAL_BELL_LAST_RING_MS_KEY];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function setGlobalLastBellRingMs(ms: number): void {
	(globalThis as Record<string, unknown>)[GLOBAL_BELL_LAST_RING_MS_KEY] = ms;
}

function ringBell(force = false): void {
	if (!getGlobalBellEnabled()) return;
	if (!process.stdout.isTTY) return;

	const now = Date.now();
	if (!force) {
		const elapsed = now - getGlobalLastBellRingMs();
		if (elapsed >= 0 && elapsed < getGlobalBellDebounceMs()) return;
	}

	setGlobalLastBellRingMs(now);
	process.stdout.write(BELL_CHAR);
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

function resolveTrackLength(width: number, _minimumLength: number): number {
	if (width <= 0) return 0;
	return width;
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

function smoothPipeColor(step: number): string {
	const hue = step * getGlobalHueStep();
	const { r, g, b } = hsvToRgb(hue, 0.85, 1);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function phasedPositionForStep(step: number, length: number, phaseCount: number): { position: number; phase: number } {
	if (length <= 1) return { position: 0, phase: Math.floor(phaseCount / 2) };

	const safePhaseCount = Math.max(1, phaseCount);
	const travelUnits = (length - 1) * safePhaseCount;
	if (travelUnits <= 0) return { position: 0, phase: Math.floor(safePhaseCount / 2) };

	const cycle = travelUnits * 2;
	const raw = step % cycle;
	const unit = raw <= travelUnits ? raw : cycle - raw;

	const position = Math.max(0, Math.min(length - 1, Math.floor(unit / safePhaseCount)));
	const phase = unit % safePhaseCount;
	return { position, phase };
}

function frameForStep(step: number, length: number): string {
	const { position, phase } = phasedPositionForStep(step, length, PIPE_PHASE_CHARS.length);
	const marker = PIPE_PHASE_CHARS[phase] ?? PIPE_PHASE_CHARS[1];
	const color = smoothPipeColor(step);
	const left = " ".repeat(position);
	const right = " ".repeat(Math.max(0, length - position - 1));
	return `${left}${color}${marker}${RESET_FG}${right}`;
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

type BellPatchableUIContext = ExtensionContext["ui"] & {
	[UI_INPUT_PATCH_FLAG]?: boolean;
};

function patchUiInputBell(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const ui = ctx.ui as BellPatchableUIContext;
	if (ui[UI_INPUT_PATCH_FLAG]) return;

	const wrapPromptMethod = (methodName: "select" | "confirm" | "input" | "editor" | "custom") => {
		const original = ui[methodName];
		ui[methodName] = (async (...args: unknown[]) => {
			ringBell();
			return await (original as (...innerArgs: unknown[]) => Promise<unknown>).apply(ui, args);
		}) as BellPatchableUIContext[typeof methodName];
	};

	wrapPromptMethod("select");
	wrapPromptMethod("confirm");
	wrapPromptMethod("input");
	wrapPromptMethod("editor");
	wrapPromptMethod("custom");
	ui[UI_INPUT_PATCH_FLAG] = true;
}

function notifyInputExpected(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	patchUiInputBell(ctx);
	ringBell();
}

function notifyInputExpectedIfReady(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (!ctx.isIdle()) return;
	if (ctx.hasPendingMessages()) return;
	notifyInputExpected(ctx);
}

async function showHiDialog(
	ctx: ExtensionContext,
	handlers: { onToggleReader: () => void; onToggleOuter: () => void; onSetYoloPlus: () => void },
): Promise<void> {
	if (!ctx.hasUI) return;

	await ctx.ui.custom<void>(
		(tui, _theme, _kb, done) => {
			const { onToggleReader, onToggleOuter, onSetYoloPlus } = handlers;
			let selectedIndex = 0;
			type DialogState = { readerOn: boolean; outerOn: boolean; yoloPlusOn: boolean };
			type DialogAction = {
				hotkey: string;
				hotkeyAliases?: string[];
				label: string;
				risk?: boolean;
				isEnabled: (state: DialogState) => boolean;
				run: () => void;
			};
			const getSafeModeUiState = (): DialogState => {
				type MaybeSafeModeEntry = {
					type?: string;
					customType?: string;
					data?: { mode?: unknown; outerAccess?: unknown };
				};

				let mode = "smart";
				let outerAccess = false;
				for (const entry of ctx.sessionManager.getBranch() as MaybeSafeModeEntry[]) {
					if (entry.type !== "custom" || entry.customType !== "safe-mode") continue;
					const nextMode = entry.data?.mode;
					if (typeof nextMode === "string") mode = nextMode.trim().toLowerCase();
					const nextOuterAccess = entry.data?.outerAccess;
					if (typeof nextOuterAccess === "boolean") outerAccess = nextOuterAccess;
				}

				return {
					readerOn: mode === "reader",
					outerOn: mode !== "paranoid" && outerAccess,
					yoloPlusOn: mode === "yolo" && outerAccess,
				};
			};

			const actions: DialogAction[] = [
				{
					hotkey: "r",
					hotkeyAliases: ["R"],
					label: "Toggle reader mode",
					isEnabled: (state) => state.readerOn,
					run: onToggleReader,
				},
				{
					hotkey: "+",
					label: "Toggle outer mode",
					isEnabled: (state) => state.outerOn,
					run: onToggleOuter,
				},
				{
					hotkey: "!",
					label: "YOLO+ mode",
					risk: true,
					isEnabled: (state) => state.yoloPlusOn,
					run: onSetYoloPlus,
				},
			];
			const actionCount = actions.length;

			const executeAction = (index: number): void => {
				const action = actions[index];
				if (!action) return;
				action.run();
				done();
			};

			const matchActionIndexForInput = (data: string): number => {
				return actions.findIndex((action) => data === action.hotkey || action.hotkeyAliases?.includes(data));
			};

			return {
				render(width: number) {
					if (width <= 2) return [];
					const innerWidth = Math.max(1, width - 2);
					const state = getSafeModeUiState();
					const actionLine = (
						hotkey: string,
						label: string,
						enabled: boolean,
						isSelected: boolean,
						options?: { risk?: boolean },
					): string => {
						const badgeText = enabled ? "[ON]" : "[OFF]";
						const badgeColor = enabled
							? options?.risk
								? "\x1b[33m"
								: "\x1b[32m"
							: "\x1b[90m";
						const badge = `${badgeColor}${badgeText}${RESET_FG}`;
						const prefix = isSelected ? "› " : "  ";
						const left = `${prefix}[${hotkey}] ${label}`;
						const availableLeft = Math.max(1, innerWidth - visibleWidth(badgeText) - 1);
						const clippedLeft =
							visibleWidth(left) > availableLeft ? truncateToWidth(left, availableLeft, "") : left;
						const gap = Math.max(1, innerWidth - visibleWidth(clippedLeft) - visibleWidth(badgeText));
						return `${clippedLeft}${" ".repeat(gap)}${badge}`;
					};
					const actionLines = actions.map((action, index) =>
						actionLine(
							action.hotkey,
							action.label,
							action.isEnabled(state),
							selectedIndex === index,
							action.risk ? { risk: true } : undefined,
						),
					);
					return [
						`╔${"═".repeat(innerWidth)}╗`,
						`║${centerLine(innerWidth, "Ctrl+X Actions")}║`,
						`║${"─".repeat(innerWidth)}║`,
						...actionLines.map((line) => `║${line}║`),
						`║${"─".repeat(innerWidth)}║`,
						`║${centerLine(innerWidth, "↑/↓ move • Enter run • Esc close")}║`,
						`╚${"═".repeat(innerWidth)}╝`,
					];
				},
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, Key.escape) || data === ESC) {
						done();
						return;
					}
					if (matchesKey(data, Key.up) || data === "k" || data === "K") {
						selectedIndex = (selectedIndex - 1 + actionCount) % actionCount;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.down) || data === "j" || data === "J") {
						selectedIndex = (selectedIndex + 1) % actionCount;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
						executeAction(selectedIndex);
						return;
					}
					const actionIndex = matchActionIndexForInput(data);
					if (actionIndex >= 0) {
						executeAction(actionIndex);
					}
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "62%",
				minWidth: 40,
				maxHeight: "70%",
				margin: 1,
			},
		},
	);

}

export default function piUiExtension(pi: ExtensionAPI): void {
	patchLoaderWorkingSpinner();

	let minimumTrackLength = clamp(
		parseIntEnv("PI_UI_WORKING_LENGTH", DEFAULT_MIN_TRACK_LENGTH),
		MIN_TRACK_LENGTH,
		MAX_TRACK_LENGTH,
	);
	setGlobalMinTrackLength(minimumTrackLength);

	const intervalMs = Math.max(5, parseIntEnv("PI_UI_WORKING_INTERVAL_MS", DEFAULT_INTERVAL_MS));
	setGlobalHueStep(parseFloatEnv("PI_UI_WORKING_HUE_STEP_DEG", DEFAULT_HUE_STEP_DEG));

	let bellEnabled = parseBooleanEnv("PI_UI_BELL", DEFAULT_BELL_ENABLED);
	setGlobalBellEnabled(bellEnabled);
	setGlobalBellDebounceMs(
		clamp(
			parseIntEnv("PI_UI_BELL_DEBOUNCE_MS", DEFAULT_BELL_DEBOUNCE_MS),
			MIN_BELL_DEBOUNCE_MS,
			MAX_BELL_DEBOUNCE_MS,
		),
	);

	let frame = 0;
	let timer: NodeJS.Timeout | undefined;
	let activeContext: ExtensionContext | undefined;
	let pendingInteractiveInputSerial = 0;
	let agentRunning = false;

	const ensureUiBellPatched = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		patchUiInputBell(ctx);
	};

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

	pi.on("session_start", async (_event, ctx) => {
		ensureUiBellPatched(ctx);
		notifyInputExpectedIfReady(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		ensureUiBellPatched(ctx);
		notifyInputExpectedIfReady(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		ensureUiBellPatched(ctx);
		notifyInputExpectedIfReady(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		ensureUiBellPatched(ctx);
		notifyInputExpectedIfReady(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		ensureUiBellPatched(ctx);
		pendingInteractiveInputSerial = 0;
	});

	pi.on("input", async (event, ctx) => {
		ensureUiBellPatched(ctx);
		if (event.source !== "interactive") return;

		const serial = ++pendingInteractiveInputSerial;
		setTimeout(() => {
			if (pendingInteractiveInputSerial !== serial) return;
			if (agentRunning) return;
			notifyInputExpectedIfReady(ctx);
		}, 0);
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentRunning = true;
		pendingInteractiveInputSerial = 0;
		startAnimation(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentRunning = false;
		stopAnimation(ctx);
		notifyInputExpectedIfReady(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		pendingInteractiveInputSerial = 0;
		agentRunning = false;
		stopAnimation(ctx);
	});

	pi.registerCommand("pi-ui-working-length", {
		description: `Set minimum working indicator length (${MIN_TRACK_LENGTH}-${MAX_TRACK_LENGTH}) [full-width mode keeps using terminal width]`,
		handler: async (args, ctx) => {
			ensureUiBellPatched(ctx);
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				notify(
					ctx,
					`pi-ui minimum working length: ${minimumTrackLength} (full-width mode active: effective length = terminal width; env: PI_UI_WORKING_LENGTH)`,
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
			notify(ctx, `pi-ui minimum working length set to ${minimumTrackLength} (full-width mode active)`);
		},
	});

	pi.registerCommand("pi-ui-bell", {
		description: "Control bell notifications when pi waits for user input: /pi-ui-bell [on|off|toggle|status]",
		handler: async (args, ctx) => {
			ensureUiBellPatched(ctx);
			const trimmed = (args ?? "").trim().toLowerCase();

			if (!trimmed || trimmed === "status") {
				notify(
					ctx,
					`pi-ui bell: ${bellEnabled ? "on" : "off"} (env: PI_UI_BELL, debounce: ${getGlobalBellDebounceMs()}ms via PI_UI_BELL_DEBOUNCE_MS)`,
				);
				return;
			}

			if (trimmed === "on") {
				bellEnabled = true;
			} else if (trimmed === "off") {
				bellEnabled = false;
			} else if (trimmed === "toggle") {
				bellEnabled = !bellEnabled;
			} else {
				notify(ctx, "Usage: /pi-ui-bell [on|off|toggle|status]");
				return;
			}

			setGlobalBellEnabled(bellEnabled);
			notify(ctx, `pi-ui bell ${bellEnabled ? "enabled" : "disabled"}`);
			if (bellEnabled) ringBell(true);
		},
	});

	pi.registerShortcut(Key.ctrl("x"), {
		description: "Open pi-ui dialog",
		handler: async (ctx) => {
			ensureUiBellPatched(ctx);
			await showHiDialog(ctx, {
				onToggleReader: () => {
					pi.events.emit(SAFE_MODE_TOGGLE_READER_EVENT, { ctx });
				},
				onToggleOuter: () => {
					pi.events.emit(SAFE_MODE_TOGGLE_OUTER_EVENT, { ctx });
				},
				onSetYoloPlus: () => {
					pi.events.emit(SAFE_MODE_SET_YOLO_PLUS_EVENT, { ctx });
				},
			});
		},
	});
}
