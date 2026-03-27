import type { BashCommandMatcher } from "../../types";
import { isReadOnlyCommandBuiltinArgs } from "../../shared/command-lists";

export const builtinCommandMatcher: BashCommandMatcher = {
	id: "command/builtin",
	evaluate(command) {
		if (command.program !== "command") return undefined;
		if (!isReadOnlyCommandBuiltinArgs(command.args)) return undefined;
		return {
			commandIndex: command.index,
			program: command.program,
			kind: "read",
			reasonCode: "command-builtin-read",
		};
	},
};
