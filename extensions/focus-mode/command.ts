import { MAX_BIAS, MAX_WIDTH, MIN_BIAS, MIN_WIDTH } from "./viewport";

export const USAGE = [
	"/px:focus            toggle the reading column",
	"/px:focus on         enable it (default width 100)",
	"/px:focus off        disable it, back to full width",
	"/px:focus set 100           set the width and enable it",
	"/px:focus set 100/-50      set the width, slide the column left, and enable it",
	"/px:focus on 100     same as `set 100`",
	"/px:focus bias       show the current bias",
	"/px:focus bias -50   slide the column left, -100 is flush against the left edge",
	"/px:focus bias 100   slide it right, 0 (the default) is centered",
	"/px:focus config     open the settings dialog",
	"/px:focus status     show the current state",
].join("\n");

export type FocusModeAction =
	| { kind: "toggle" }
	| { kind: "status" }
	| { kind: "config" }
	| { kind: "enable"; width?: number; bias?: number }
	| { kind: "disable" }
	| { kind: "showBias" }
	| { kind: "setBias"; bias: number };

export type ParsedCommand = FocusModeAction | { error: string };

function parseWidth(raw: string): number | { error: string } {
	if (!/^\d+$/.test(raw)) return { error: `focus: "${raw}" is not a column count` };

	const width = Number.parseInt(raw, 10);
	if (width < MIN_WIDTH || width > MAX_WIDTH) {
		return { error: `focus: width must be between ${MIN_WIDTH} and ${MAX_WIDTH} columns` };
	}
	return width;
}

function parseBias(raw: string): number | { error: string } {
	if (!/^[+-]?\d+$/.test(raw)) return { error: `focus: "${raw}" is not a bias percentage` };

	const bias = Number.parseInt(raw, 10);
	if (bias < MIN_BIAS || bias > MAX_BIAS) {
		return { error: `focus: bias must be between ${MIN_BIAS} and ${MAX_BIAS} percent` };
	}
	return bias;
}

/** `set` takes `columns` or `columns/bias`; the bias half is optional. */
function parseSetArgument(raw: string): { width: number; bias?: number } | { error: string } {
	const parts = raw.split("/");
	if (parts.length > 2) return { error: `focus: expected "columns" or "columns/bias", got "${raw}"` };

	const [widthToken, biasToken] = parts;
	if (widthToken === "") return { error: "focus: set needs a column count, e.g. /px:focus set 100" };
	if (biasToken === "") return { error: `focus: "${raw}" is missing a bias percentage` };

	const width = parseWidth(widthToken);
	if (typeof width !== "number") return width;
	if (biasToken === undefined) return { width };

	const bias = parseBias(biasToken);
	return typeof bias === "number" ? { width, bias } : bias;
}

/** Parse the argument string of `/px:focus`. */
export function parseFocusModeCommand(input: string): ParsedCommand {
	const tokens = input.trim().split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return { kind: "toggle" };

	const [verb, ...rest] = tokens;
	const extra = rest[0];
	if (rest.length > 1) {
		return { error: `focus: unexpected argument "${rest.join(" ")}"` };
	}

	switch (verb.toLowerCase()) {
		case "toggle":
			if (extra !== undefined) return { error: "focus: toggle does not take an argument" };
			return { kind: "toggle" };
		case "status":
			if (extra !== undefined) return { error: "focus: status does not take an argument" };
			return { kind: "status" };
		case "config":
			if (extra !== undefined) return { error: "focus: config does not take an argument" };
			return { kind: "config" };
		case "on":
		case "enable": {
			if (extra === undefined) return { kind: "enable" };
			const width = parseWidth(extra);
			return typeof width === "number" ? { kind: "enable", width } : width;
		}
		case "off":
		case "disable": {
			if (extra !== undefined) return { error: "focus: off does not take an argument" };
			return { kind: "disable" };
		}
		case "set": {
			if (extra === undefined) return { error: "focus: set needs a column count, e.g. /px:focus set 100" };
			const parsed = parseSetArgument(extra);
			if ("error" in parsed) return parsed;
			return parsed.bias === undefined
				? { kind: "enable", width: parsed.width }
				: { kind: "enable", width: parsed.width, bias: parsed.bias };
		}
		case "bias": {
			if (extra === undefined) return { kind: "showBias" };
			const bias = parseBias(extra);
			return typeof bias === "number" ? { kind: "setBias", bias } : bias;
		}
		default:
			return { error: `focus: unknown option "${verb}"` };
	}
}

export const COMPLETIONS = [
	{ value: "on", label: "on", description: "enable the centered reading column" },
	{ value: "off", label: "off", description: "disable it, back to full width" },
	{ value: "set", label: "set <columns>[/<bias>]", description: "set the width, optionally the bias, and enable it" },
	{ value: "bias", label: "bias <percent>", description: "slide the column sideways, -100 is flush left, 0 is centered, 100 is flush right" },
	{ value: "toggle", label: "toggle", description: "flip between focus mode and full width" },
	{ value: "config", label: "config", description: "open the settings dialog" },
	{ value: "status", label: "status", description: "show the current state" },
];

/** Autocomplete items for the argument prefix of `/px:focus`. */
export function focusModeCompletions(prefix: string): typeof COMPLETIONS {
	const needle = prefix.trim().toLowerCase();
	if (needle === "") return COMPLETIONS;

	const startsWithWord = COMPLETIONS.filter((item) => item.value.toLowerCase().startsWith(needle));
	if (startsWithWord.length > 0) return startsWithWord;
	return COMPLETIONS.filter((item) => item.value.toLowerCase().includes(needle));
}
