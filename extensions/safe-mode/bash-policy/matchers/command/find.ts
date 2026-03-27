import type { BashCommandMatcher } from "../../types";
import { hasFindWriteLikeArgs } from "../../shared/command-lists";

export const findCommandMatcher: BashCommandMatcher = {
	id: "command/find",
	evaluate(command) {
		if (command.program !== "find") return undefined;
		if (command.hasDynamicArgs || hasFindWriteLikeArgs(command.args)) {
			return {
				commandIndex: command.index,
				program: command.program,
				kind: "write",
				reasonCode: command.hasDynamicArgs ? "dynamic-arguments" : "find-write-like-flag",
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
