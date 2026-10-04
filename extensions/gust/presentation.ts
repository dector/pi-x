import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type UI = ExtensionContext["ui"];
type Widget = string[] | Parameters<UI["setWidget"]>[1];
type WidgetOptions = Parameters<UI["setWidget"]>[2];

/** Cache only successfully published, serializable payloads for the current UI.
 * Event contexts are ephemeral; their UI is the presentation destination.
 */
export class GustPresentation {
	private ui: UI | undefined;
	private statuses = new Map<string, string | undefined>();
	private widgets = new Map<string, { lines: string[] | undefined; placement: string }>();

	reset(): void {
		this.ui = undefined;
		this.statuses.clear();
		this.widgets.clear();
	}

	private destination(ctx: ExtensionContext): UI {
		const ui = ctx.ui; // Read the guarded getter even for unchanged payloads.
		if (ui !== this.ui) {
			this.reset();
			this.ui = ui;
		}
		return ui;
	}

	setStatus(ctx: ExtensionContext, key: string, text: string | undefined): void {
		const ui = this.destination(ctx);
		if (this.statuses.has(key) && this.statuses.get(key) === text) return;
		this.statuses.delete(key);
		ui.setStatus(key, text);
		this.statuses.set(key, text);
	}

	setWidget(ctx: ExtensionContext, key: string, content: Widget, options?: WidgetOptions): void {
		const ui = this.destination(ctx);
		// A factory can capture mutable state or require rebuilding for a theme.
		// Never infer unchanged rendered output from function identity.
		if (typeof content === "function") {
			this.widgets.delete(key);
			ui.setWidget(key, content, options);
			return;
		}
		const placement = options?.placement ?? "aboveEditor";
		const previous = this.widgets.get(key);
		if (previous?.placement === placement && (content === undefined
			? previous.lines === undefined
			: previous.lines !== undefined && content.length === previous.lines.length
				&& content.every((line, index) => line === previous.lines![index]))) return;
		// Snapshot before publishing: neither caller nor UI mutation may alter the cache.
		const lines = content?.slice();
		this.widgets.delete(key);
		ui.setWidget(key, content, options);
		this.widgets.set(key, { lines, placement });
	}
}
