// `/px:net` selector UI.
//
// Renders the option rows built by `options.ts` with effective tokens/colors
// and (when active) the PARANOID override notice. Returns the chosen setting,
// or `null` on cancel. No state is changed here.

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { buildNetworkPolicyOptions, buildParanoidNotice } from "./options";
import type { NetworkPermissionState, NetworkPolicySetting } from "./contract";

export interface NetworkPolicyPickerOptions {
	state: NetworkPermissionState;
}

export async function showNetworkPolicyPicker(
	ctx: ExtensionContext,
	options: NetworkPolicyPickerOptions,
): Promise<NetworkPolicySetting | null> {
	if (!ctx.hasUI) return null;

	const result = await ctx.ui.custom<NetworkPolicySetting | null>((tui, theme, _kb, done) => {
		const createView = () => {
			const rows = buildNetworkPolicyOptions(options.state);
			const optionByValue = new Map(rows.map((option) => [option.setting as string, option]));
			const items: SelectItem[] = rows.map((option) => ({
				value: option.setting,
				// Plain label: SelectList measures/truncates this, while the layout
				// below applies the policy token color.
				label: option.setting === "auto" ? `${option.label} (${option.token})` : `${option.token} ${option.label}`,
				description: option.description,
			}));

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Network Permissions"))));

			for (const line of buildParanoidNotice(options.state) ?? []) {
				container.addChild(new Text(theme.fg("warning", line)));
			}

			const list = new SelectList(
				items,
				Math.min(items.length, 10),
				{
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
				{
					truncatePrimary: ({ item, isSelected }) => {
						const option = optionByValue.get(item.value);
						if (!option) return item.label;
						const token = theme.fg(option.color, option.token);
						const label =
							option.setting === "auto" ? `${option.label} (${token})` : `${token} ${option.label}`;
						// SelectList wraps the whole selected row in accent. Re-open accent
						// after the nested token color reset so the highlight continues
						// through the trailing spacing/description.
						return isSelected ? `${label}${theme.getFgAnsi("accent")}` : label;
					},
				},
			);

			const currentIndex = rows.findIndex((option) => option.isCurrent);
			list.setSelectedIndex(currentIndex >= 0 ? currentIndex : 0);

			list.onSelect = (item) => done(item.value as NetworkPolicySetting);
			list.onCancel = () => done(null);

			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓/j k navigate • enter select • esc cancel")));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return { container, list, items };
		};

		let view = createView();

		const moveSelection = (delta: number) => {
			if (view.items.length === 0) return;
			const current = view.list.getSelectedItem();
			const currentIndex = current ? view.items.findIndex((item) => item.value === current.value) : 0;
			const nextIndex = Math.max(0, Math.min(view.items.length - 1, currentIndex + delta));
			view.list.setSelectedIndex(nextIndex);
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
				if (matchesKey(data, "j") || data === "j") {
					moveSelection(1);
					return;
				}
				if (matchesKey(data, "k") || data === "k") {
					moveSelection(-1);
					return;
				}

				view.list.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return result ?? null;
}
