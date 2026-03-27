import type { BashCommandMatcher } from "../../types";
import { READ_ONLY_BASH_COMMANDS } from "../../shared/command-lists";

export const readOnlyCommandMatcher: BashCommandMatcher = {
	id: "command/read-only",
	evaluate(command) {
		if (!READ_ONLY_BASH_COMMANDS.has(command.program)) return undefined;
		return {
			commandIndex: command.index,
			program: command.program,
			kind: "read",
			reasonCode: "read-only-command",
		};
	},
};
