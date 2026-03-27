import type { BashCommandMatcher } from "../../types";
import { PACKAGE_MANAGER_WRITE_SUBCOMMANDS } from "../../shared/command-lists";
import { normalizeSubcommand } from "../../shared/normalization";

export const packageManagerCommandMatcher: BashCommandMatcher = {
	id: "command/package-manager",
	evaluate(command) {
		const writeSubcommands = PACKAGE_MANAGER_WRITE_SUBCOMMANDS[command.program];
		if (!writeSubcommands) return undefined;

		const subcommand = normalizeSubcommand(command.args[0]);
		if (!subcommand || !writeSubcommands.has(subcommand)) return undefined;

		return {
			commandIndex: command.index,
			program: command.program,
			kind: "write",
			reasonCode: "package-manager-write-subcommand",
		};
	},
};
