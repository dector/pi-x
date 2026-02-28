import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import type { ThinkingMode } from "./state";

interface ThinkingPickerOptions {
	availableModes: ThinkingMode[];
	getCurrentMode: () => ThinkingMode;
	getFavorites: () => ThinkingMode[];
	onSelect: (mode: ThinkingMode) => void;
	onToggleFavorite: (mode: ThinkingMode) => void;
}

interface PickerView {
	container: Container;
	list: SelectList;
	items: SelectItem[];
}

function modeLabel(mode: ThinkingMode, favoriteSet: Set<ThinkingMode>): string {
	return `${favoriteSet.has(mode) ? "★" : " "} ${mode}`;
}

function modeDescription(mode: ThinkingMode, currentMode: ThinkingMode, favoriteSet: Set<ThinkingMode>): string | undefined {
	const tags: string[] = [];
	if (mode === currentMode) tags.push("current");
	if (favoriteSet.has(mode)) tags.push("favorite");
	return tags.length > 0 ? tags.join(" • ") : undefined;
}

export async function showThinkingPicker(ctx: ExtensionContext, options: ThinkingPickerOptions): Promise<ThinkingMode | null> {
	if (!ctx.hasUI) return null;
	if (options.availableModes.length === 0) return null;

	const result = await ctx.ui.custom<ThinkingMode | null>((tui, theme, _kb, done) => {
		let selectedValue = options.getCurrentMode();
		if (!options.availableModes.includes(selectedValue)) {
			selectedValue = options.availableModes[0]!;
		}

		const createView = (): PickerView => {
			const currentMode = options.getCurrentMode();
			const favoriteSet = new Set(options.getFavorites());
			const items: SelectItem[] = options.availableModes.map((mode) => ({
				value: mode,
				label: modeLabel(mode, favoriteSet),
				description: modeDescription(mode, currentMode, favoriteSet),
			}));

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Switch Thinking Mode"))));

			const list = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			const selectedIndex = items.findIndex((item) => item.value === selectedValue);
			list.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);

			list.onSelectionChange = (item) => {
				selectedValue = item.value as ThinkingMode;
			};
			list.onSelect = (item) => {
				const mode = item.value as ThinkingMode;
				options.onSelect(mode);
				done(mode);
			};
			list.onCancel = () => done(null);

			container.addChild(list);
			container.addChild(
				new Text(theme.fg("dim", "↑↓/j k navigate • enter select • space favorite • esc cancel")),
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return { container, list, items };
		};

		let view = createView();

		const moveSelection = (delta: number) => {
			if (view.items.length === 0) return;
			const currentIndex = Math.max(0, view.items.findIndex((item) => item.value === selectedValue));
			const nextIndex = Math.max(0, Math.min(view.items.length - 1, currentIndex + delta));
			view.list.setSelectedIndex(nextIndex);
			selectedValue = view.items[nextIndex]!.value as ThinkingMode;
			tui.requestRender();
		};

		return {
			render(width: number) {
				return view.container.render(width);
			},
			invalidate() {
				view.container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.space) || data === " ") {
					const selected = view.list.getSelectedItem();
					if (!selected) return;
					const mode = selected.value as ThinkingMode;
					options.onToggleFavorite(mode);
					selectedValue = mode;
					view = createView();
					tui.requestRender();
					return;
				}

				if (matchesKey(data, "j") || data === "j") {
					moveSelection(1);
					return;
				}
				if (matchesKey(data, "k") || data === "k") {
					moveSelection(-1);
					return;
				}

				view.list.handleInput(data);
				const selected = view.list.getSelectedItem();
				if (selected) selectedValue = selected.value as ThinkingMode;
				tui.requestRender();
			},
		};
	});

	return result ?? null;
}
