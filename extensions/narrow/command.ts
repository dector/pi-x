import { MAX_BIAS, MAX_WIDTH, MIN_BIAS, MIN_WIDTH } from "./viewport";

export const USAGE = [
	"/px:narrow            toggle the reading column",
	"/px:narrow on         enable it (default width 100)",
	"/px:narrow off        disable it, back to full width",
	"/px:narrow set 100           set the width and enable it",
	"/px:narrow set 100/-50      set the width, slide the column left, and enable it",
	"/px:narrow on 100     same as `set 100`",
	"/px:narrow bias       show the current bias",
	"/px:narrow bias -50   slide the column left, -100 is flush against the left edge",
	"/px:narrow bias 100   slide it right, 0 (the default) is centered",
	"/px:narrow status     show the current state",
].join("\n");

export type NarrowAction =
	| { kind: "toggle" }
	| { kind: "status" }
	| { kind: "enable"; width?: number; bias?: number }
	| { kind: "disable" }
	| { kind: "showBias" }
	| { kind: "setBias"; bias: number };

export type ParsedCommand = NarrowAction | { error: string };

function parseWidth(raw: string): number | { error: string } {
	if (!/^\d+$/.test(raw)) return { error: `narrow: "${raw}" is not a column count` };

	const width = Number.parseInt(raw, 10);
	if (width < MIN_WIDTH || width > MAX_WIDTH) {
		return { error: `narrow: width must be between ${MIN_WIDTH} and ${MAX_WIDTH} columns` };
	}
	return width;
}

function parseBias(raw: string): number | { error: string } {
	if (!/^[+-]?\d+$/.test(raw)) return { error: `narrow: "${raw}" is not a bias percentage` };

	const bias = Number.parseInt(raw, 10);
	if (bias < MIN_BIAS || bias > MAX_BIAS) {
		return { error: `narrow: bias must be between ${MIN_BIAS} and ${MAX_BIAS} percent` };
	}
	return bias;
}

/** `set` takes `columns` or `columns/bias`; the bias half is optional. */
function parseSetArgument(raw: string): { width: number; bias?: number } | { error: string } {
	const parts = raw.split("/");
	if (parts.length > 2) return { error: `narrow: expected "columns" or "columns/bias", got "${raw}"` };

	const [widthToken, biasToken] = parts;
	if (widthToken === "") return { error: "narrow: set needs a column count, e.g. /px:narrow set 100" };
	if (biasToken === "") return { error: `narrow: "${raw}" is missing a bias percentage` };

	const width = parseWidth(widthToken);
	if (typeof width !== "number") return width;
	if (biasToken === undefined) return { width };

	const bias = parseBias(biasToken);
	return typeof bias === "number" ? { width, bias } : bias;
}

/** Parse the argument string of `/px:narrow`. */
export function parseNarrowCommand(input: string): ParsedCommand {
	const tokens = input.trim().split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return { kind: "toggle" };

	const [verb, ...rest] = tokens;
	const extra = rest[0];
	if (rest.length > 1) {
		return { error: `narrow: unexpected argument "${rest.join(" ")}"` };
	}

	switch (verb.toLowerCase()) {
		case "toggle":
			if (extra !== undefined) return { error: "narrow: toggle does not take an argument" };
			return { kind: "toggle" };
		case "status":
			if (extra !== undefined) return { error: "narrow: status does not take an argument" };
			return { kind: "status" };
		case "on":
		case "enable": {
			if (extra === undefined) return { kind: "enable" };
			const width = parseWidth(extra);
			return typeof width === "number" ? { kind: "enable", width } : width;
		}
		case "off":
		case "disable": {
			if (extra !== undefined) return { error: "narrow: off does not take an argument" };
			return { kind: "disable" };
		}
		case "set": {
			if (extra === undefined) return { error: "narrow: set needs a column count, e.g. /px:narrow set 100" };
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
			return { error: `narrow: unknown option "${verb}"` };
	}
}

export const COMPLETIONS = [
	{ value: "on", label: "on", description: "enable the centered reading column" },
	{ value: "off", label: "off", description: "disable it, back to full width" },
	{ value: "set", label: "set <columns>[/<bias>]", description: "set the width, optionally the bias, and enable it" },
	{ value: "bias", label: "bias <percent>", description: "slide the column sideways, -100 is flush left, 0 is centered, 100 is flush right" },
	{ value: "toggle", label: "toggle", description: "flip between narrow and full width" },
	{ value: "status", label: "status", description: "show the current state" },
];

/** Autocomplete items for the argument prefix of `/px:narrow`. */
export function narrowCompletions(prefix: string): typeof COMPLETIONS {
	const needle = prefix.trim().toLowerCase();
	if (needle === "") return COMPLETIONS;

	const startsWithWord = COMPLETIONS.filter((item) => item.value.toLowerCase().startsWith(needle));
	if (startsWithWord.length > 0) return startsWithWord;
	return COMPLETIONS.filter((item) => item.value.toLowerCase().includes(needle));
}
