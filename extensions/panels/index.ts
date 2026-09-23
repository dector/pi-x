/**
 * Panel coordinator.
 *
 * Owns the single `Alt+P` (forward) / `Alt+Shift+P` (reverse) shortcut pair and
 * the one above-editor widget that renders every panel. Panels keep their own
 * rendering and simply react to `px:panels:active`; they publish formatted lines
 * on `px:panels:content` instead of touching `ctx.ui.setWidget`. See
 * `contract.ts` for the protocol, `coordinator.ts` for the pure selection rules,
 * and `widget.ts` for the shared widget.
 *
 * Reload safety: `pi.events` lives on the host's shared bus and is not cleared
 * on `/reload`, so this extension keeps every subscription handle and drops
 * them on `session_shutdown` (which fires before the reload). State stays in the
 * closure; no `globalThis` singleton is used, so a reload cannot accumulate
 * coordinators or leak stale listeners.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	PANELS_ACTIVE_EVENT,
	PANELS_CONTENT_EVENT,
	PANELS_REGISTER_EVENT,
	PANELS_SYNC_EVENT,
	PANELS_VISIBILITY_EVENT,
	parsePanelContent,
	parsePanelRegistration,
	parsePanelVisibility,
} from "./contract.ts";
import { PanelCoordinator } from "./coordinator.ts";
import { PanelsWidget } from "./widget.ts";

export default function (pi: ExtensionAPI) {
	// Content may be published during a panel's `session_start` before this
	// extension's own `session_start` handler runs. The coordinator caches it,
	// and `PanelsWidget` mounts as soon as a context exists.
	let sessionContext: ExtensionContext | undefined;

	const coordinator = new PanelCoordinator({
		onActive: (activeId) => {
			pi.events.emit(PANELS_ACTIVE_EVENT, { activeId });
		},
		onContent: () => {
			widget.refresh(sessionContext);
		},
	});

	const widget = new PanelsWidget(coordinator);

	// Every handler is unsubscribed on session_shutdown so `/reload` cannot
	// leave an old coordinator answering on the shared bus.
	const unsubscribers: Array<() => void> = [];
	const subscribe = (channel: string, handler: (payload: unknown) => void): void => {
		unsubscribers.push(pi.events.on(channel, handler));
	};

	subscribe(PANELS_REGISTER_EVENT, (payload) => {
		const registration = parsePanelRegistration(payload);
		if (registration) coordinator.register(registration);
	});

	subscribe(PANELS_VISIBILITY_EVENT, (payload) => {
		const visibility = parsePanelVisibility(payload);
		if (visibility) coordinator.setVisibility(visibility.id, visibility.visible);
	});

	subscribe(PANELS_CONTENT_EVENT, (payload) => {
		const content = parsePanelContent(payload);
		if (content) coordinator.setContent(content);
	});

	subscribe(PANELS_SYNC_EVENT, () => {
		coordinator.sync();
	});

	const notifyActive = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const active = coordinator.active;
		const label = active ? coordinator.list().find((panel) => panel.id === active)?.label : undefined;
		ctx.ui.notify(active && label ? `${label} panel` : "Panels collapsed", "info");
	};

	// The coordinator is the only owner of the panel shortcuts. Panels must not
	// register them. `Alt+Shift+P` walks the same cycle in reverse.
	pi.registerShortcut(Key.alt("p"), {
		description: "Cycle visible panels",
		handler: (ctx) => {
			coordinator.cycle();
			notifyActive(ctx);
		},
	});

	pi.registerShortcut(Key.altShift("p"), {
		description: "Cycle visible panels (reverse)",
		handler: (ctx) => {
			coordinator.cycleBackward();
			notifyActive(ctx);
		},
	});

	const startSession = (ctx: ExtensionContext): void => {
		sessionContext = ctx;
		// Content that arrived before this handler is already cached; this mounts
		// the widget and draws it.
		widget.refresh(ctx);
	};

	pi.on("session_start", async (_event, ctx) => startSession(ctx));
	pi.on("session_tree", async (_event, ctx) => startSession(ctx));

	pi.on("session_shutdown", () => {
		for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
		widget.clear(sessionContext);
		coordinator.clear();
		sessionContext = undefined;
	});
}
