import type { BashCommandMatcher } from "../../types";

function hasInPlaceFlag(args: readonly string[]): boolean {
	for (const arg of args) {
		const lower = arg.toLowerCase();
		if (lower === "-i" || lower === "--in-place") return true;
		if (lower.startsWith("--in-place=")) return true;
		if (/^-i.+/.test(lower)) return true;
	}
	return false;
}

export const sedCommandMatcher: BashCommandMatcher = {
	id: "command/sed",
	evaluate(command) {
		if (command.program !== "sed") return undefined;
		if (command.hasDynamicArgs || command.hasDynamicName) return undefined;

		if (hasInPlaceFlag(command.args)) {
			return {
				commandIndex: command.index,
				program: command.program,
				kind: "write",
				reasonCode: "write-command",
				detail: "sed in-place editing",
			};
		}

		return {
			commandIndex: command.index,
			program: command.program,
			kind: "read",
			reasonCode: "read-only-command",
		};
	},
};
