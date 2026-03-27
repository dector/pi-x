import type { BashCommandMatcher } from "../../types";
import { WRITE_BASH_COMMANDS } from "../../shared/command-lists";

export const writeCommandMatcher: BashCommandMatcher = {
	id: "command/write",
	evaluate(command) {
		if (!WRITE_BASH_COMMANDS.has(command.program)) return undefined;
		return {
			commandIndex: command.index,
			program: command.program,
			kind: "write",
			reasonCode: "write-command",
		};
	},
};
