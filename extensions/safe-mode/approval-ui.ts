import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type ApprovalDecision = "approve-once" | "approve-all-session" | "approve-project" | "deny" | "steer";
type ApprovalChoice = ApprovalDecision | "toggle-investigation";

// Match Quick Actions: bright rounded corners and heavy sides, with filled rows.
function frameDialog(title: string, lines: string[], width: number): string[] {
	if (width < 4) return lines.map((line) => truncateToWidth(line, width, ""));
	const border = (text: string) => `\x1b[97m${text}\x1b[39m`;
	const innerWidth = width - 2;
	const label = truncateToWidth(` ${title} `, Math.max(0, innerWidth - 3), "");
	const top = innerWidth >= 3
		? `╭━╾${label}╼${"━".repeat(Math.max(0, innerWidth - visibleWidth(label) - 3))}╮`
		: `╭${"━".repeat(innerWidth)}╮`;
	return [
		border(`\x1b[1m${top}\x1b[22m`),
		...lines.map((line) => {
			const fitted = truncateToWidth(line, Math.max(1, innerWidth - 2), "");
			const padded = innerWidth >= 3 ? ` ${fitted} ` : fitted;
			const filled = `${padded}${" ".repeat(Math.max(0, innerWidth - visibleWidth(padded)))}`;
			const selected = line.replace(/\x1b\[[0-9;]*m/g, "").trimStart().startsWith("→");
			const row = selected ? `\x1b[48;2;0;0;0m\x1b[97m${filled}\x1b[39m\x1b[49m` : filled;
			return `${border("┃")}${row}${border("┃")}`;
		}),
		border(`╰${"━".repeat(innerWidth)}╯`),
	];
}

const overlay = {
	overlay: true,
	overlayOptions: { anchor: "center" as const, width: "90%" as const, maxHeight: "90%" as const, margin: 1 },
};

/** Serialize the whole approval + optional steering sequence, not individual dialogs.
 * A rejected dialog must not poison the queue. Wait declarations belong outside
 * this queue so queued requests still suspend the hub's timeout clock.
 */
export function createApprovalQueue() {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(action: () => Promise<T>): Promise<T> => {
		const result = tail.then(action);
		tail = result.catch(() => {});
		return result;
	};
}

export async function confirmApproval(
	ctx: ExtensionContext,
	title: string,
	message: string,
	options?: { allowProjectApproval?: boolean; investigation?: { enabled: boolean } },
): Promise<ApprovalDecision> {
	let invoked = false;
	const result = await ctx.ui.custom?.<ApprovalDecision>((tui, theme, _kb, done) => {
		invoked = true;
		let scroll = 0;
		let viewportHeight = 1;
		let visibleChoices = 0;
		const investigation = options?.investigation;
		const items = () => [
			{ value: "approve-once", label: "[Y]es" },
			{ value: "deny", label: "[N]o" },
			{ value: "approve-all-session", label: "[A]ll for this session" },
			...(options?.allowProjectApproval ? [{ value: "approve-project", label: "[P]ermanently allow" }] : []),
			{ value: "steer", label: "[Esc] to steer" },
			...(investigation ? [{ value: "toggle-investigation", label: `[I]nvestigate: ${investigation.enabled ? "on" : "off"}` }] : []),
		];
		const choose = (choice: ApprovalChoice) => {
			if (choice === "toggle-investigation") {
				if (investigation) investigation.enabled = !investigation.enabled;
				const index = list.getSelectedItem()?.value;
				list = makeList(visibleChoices);
				list.setSelectedIndex(Math.max(0, items().findIndex((item) => item.value === index)));
				tui.requestRender();
			} else done(choice);
		};
		const makeList = (maxVisible = items().length) => {
			visibleChoices = maxVisible;
			const list = new SelectList(items(), maxVisible, {
				selectedPrefix: (s) => `\x1b[97m${s}\x1b[39m`,
				selectedText: (s) => `\x1b[97m${s}\x1b[39m`,
				description: (s) => theme.fg("muted", s),
				scrollInfo: (s) => theme.fg("dim", s),
				noMatch: (s) => theme.fg("warning", s),
			});
			list.onSelect = (item) => choose(item.value as ApprovalChoice);
			list.onCancel = () => done("steer");
			return list;
		};
		let list = makeList();
		return {
			invalidate() { list.invalidate(); },
			render(width: number) {
				// Reserve space for choices before laying out the request. Long
				// commands must never push the decision keys below overlay cropping.
				const height = Math.max(1, Math.min(Math.floor(tui.terminal.rows * 0.9), tui.terminal.rows - 2));
				const contentWidth = Math.max(1, width - 4);
				const showHint = height >= 7;
				// SelectList adds a scroll-info row when compacted. Reserve that
				// too, keeping at least one request row even on a six-row terminal.
				const count = Math.max(1, Math.min(items().length, height - 3 - Number(showHint)));
				if (count !== visibleChoices) {
					const selected = list.getSelectedItem()?.value;
					list = makeList(count);
					list.setSelectedIndex(Math.max(0, items().findIndex((item) => item.value === selected)));
				}
				const choices = list.render(contentWidth).slice(0, Math.max(1, height - 3 - Number(showHint)));
				const body = new Text(message.trim(), 0, 0).render(contentWidth);
				viewportHeight = Math.max(1, height - choices.length - 2 - Number(showHint));
				scroll = Math.max(0, Math.min(scroll, body.length - viewportHeight));
				const hint = body.length > viewportHeight ? "PgUp/PgDn: scroll request" : "↑/↓: choose · Enter: confirm";
				return frameDialog(title, [...body.slice(scroll, scroll + viewportHeight), ...(showHint ? new Text(theme.fg("dim", hint), 0, 0).render(contentWidth).slice(0, 1) : []), ...choices], width);
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) return done("steer");
				if (matchesKey(data, "y") || data === "Y") return choose("approve-once");
				if (matchesKey(data, "n") || data === "N") return choose("deny");
				if (matchesKey(data, "a") || data === "A") return choose("approve-all-session");
				if (options?.allowProjectApproval && (matchesKey(data, "p") || data === "P")) return choose("approve-project");
				if (investigation && (matchesKey(data, "i") || data === "I")) return choose("toggle-investigation");
				if (matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - Math.min(5, viewportHeight));
				else if (matchesKey(data, Key.pageDown)) scroll += Math.min(5, viewportHeight);
				else list.handleInput(data);
				tui.requestRender();
			},
		};
	}, overlay);
	if (invoked) return result ?? "steer";
	// RPC hasUI is true, but custom() is a no-op and never calls the factory.
	// Only that path may use the host dialogs; never replace a live TUI editor.
	while (true) {
		const choices = [
			"[Y]es", "[N]o", "[A]ll for this session",
			...(options?.allowProjectApproval ? ["[P]ermanently allow"] : []),
			"[Esc] to steer",
			...(options?.investigation ? [`[I]nvestigate: ${options.investigation.enabled ? "on" : "off"}`] : []),
		];
		const selected = await ctx.ui.select(`${title}${message}`, choices);
		if (options?.investigation && selected === choices.at(-1)) {
			options.investigation.enabled = !options.investigation.enabled;
			continue;
		}
		switch (selected) {
			case "[Y]es": return "approve-once";
			case "[N]o": return "deny";
			case "[A]ll for this session": return "approve-all-session";
			case "[P]ermanently allow": return options?.allowProjectApproval ? "approve-project" : "steer";
			default: return "steer";
		}
	}
}

export async function promptSteering(ctx: ExtensionContext): Promise<string | undefined> {
	let invoked = false;
	const result = await ctx.ui.custom?.<string | undefined>((tui, theme, _kb, done) => {
		invoked = true;
		const input = new Input();
		input.onSubmit = done;
		input.onEscape = () => done(undefined);
		return {
			get focused() { return input.focused; },
			set focused(value: boolean) { input.focused = value; },
			invalidate() { input.invalidate(); },
			render(width: number) {
				const contentWidth = Math.max(1, width - 4);
				return frameDialog("How should I proceed instead?", [
					...new Text(theme.fg("dim", "Enter: send · Esc: cancel"), 0, 0).render(contentWidth).slice(0, 1),
					...input.render(contentWidth),
				], width);
			},
			handleInput(data: string) { input.handleInput(data); tui.requestRender(); },
		};
	}, overlay);
	return invoked ? result : ctx.ui.input("How should I proceed instead?", "Describe the safer approach");
}
