import type { BashCommandMatcher } from "../../types";
import { classifyGitArgs } from "../../shared/command-lists";

export const gitCommandMatcher: BashCommandMatcher = {
	id: "command/git",
	evaluate(command) {
		if (command.program !== "git") return undefined;
		const classification = classifyGitArgs(command.args);
		if (classification === "read") {
			return {
				commandIndex: command.index,
				program: command.program,
				kind: "read",
				reasonCode: "git-read-subcommand",
			};
		}
		if (classification === "write") {
			return {
				commandIndex: command.index,
				program: command.program,
				kind: "write",
				reasonCode: "git-write-subcommand",
			};
		}
		return undefined;
	},
};
