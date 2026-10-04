import type { NeoBarRewireSetPayload } from "./contract.ts";

/** How long a rewire-target preview stays visible before the persistent state returns. */
export const REWIRE_PREVIEW_MS = 1500;

/** Injectable timer hooks so the preview lifecycle is testable without real waits. */
export interface RewirePreviewTimer {
	set: (handler: () => void, ms: number) => unknown;
	clear: (handle: unknown) => void;
}

export interface RewirePreviewOptions {
	/** Called once the preview expires; use it to request a render. */
	onExpire: () => void;
	/** Override for tests. Defaults to the real `setTimeout`/`clearTimeout`. */
	durationMs?: number;
	/** Override for tests. Defaults to the real `setTimeout`/`clearTimeout`. */
	timer?: RewirePreviewTimer;
}

const defaultTimer: RewirePreviewTimer = {
	set: (handler, ms) => setTimeout(handler, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Owns the short-lived rewire-target preview.
 *
 * The preview is deliberately separate from the persistent enabled state. It is
 * only cleared by its own timeout, an explicit `cancel()`, or a new `show()`; a
 * render or model-refresh request must never touch it. The extension calls
 * `cancel()` on real rewire state updates and session start/tree/shutdown.
 */
export class RewirePreview {
	private target: NeoBarRewireSetPayload | undefined;
	private handle: unknown;
	private readonly durationMs: number;
	private readonly timer: RewirePreviewTimer;
	private readonly onExpire: () => void;

	constructor(options: RewirePreviewOptions) {
		this.durationMs = options.durationMs ?? REWIRE_PREVIEW_MS;
		this.timer = options.timer ?? defaultTimer;
		this.onExpire = options.onExpire;
	}

	/** The target currently previewed, if any. */
	get current(): NeoBarRewireSetPayload | undefined {
		return this.target;
	}

	/** Show or replace the preview and restart the one-shot timeout. */
	show(target: NeoBarRewireSetPayload): void {
		this.cancelTimer();
		this.target = { ...target };
		this.handle = this.timer.set(() => {
			this.handle = undefined;
			this.target = undefined;
			this.onExpire();
		}, this.durationMs);
	}

	/** Drop the preview and its pending timeout without firing `onExpire`. */
	cancel(): void {
		this.cancelTimer();
		this.target = undefined;
	}

	private cancelTimer(): void {
		if (this.handle !== undefined) {
			this.timer.clear(this.handle);
			this.handle = undefined;
		}
	}
}

export interface RewireDisplay {
	target: NeoBarRewireSetPayload;
	/** Theme color token: previews are muted gray, the persistent indicator is red. */
	colorToken: "muted" | "error";
}

/**
 * Pick what the rewire location should render. A live preview always wins over
 * the persistent enabled target, and the persistent target is only visible when
 * rewiring is enabled (its own set/clear channel controls that).
 */
export function resolveRewireDisplay(
	persistent: NeoBarRewireSetPayload | undefined,
	preview: NeoBarRewireSetPayload | undefined,
): RewireDisplay | undefined {
	if (preview) return { target: preview, colorToken: "muted" };
	if (persistent) return { target: persistent, colorToken: "error" };
	return undefined;
}
