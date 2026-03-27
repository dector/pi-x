import type {
	AnalyzedCommand,
	BashCommandMatcher,
	CommandClassification,
	CommandClassificationSummary,
} from "./types";
import { findCommandMatcher } from "./matchers/command/find";
import { builtinCommandMatcher } from "./matchers/command/builtin-command";
import { writeCommandMatcher } from "./matchers/command/write-command";
import { gitCommandMatcher } from "./matchers/command/git";
import { packageManagerCommandMatcher } from "./matchers/command/package-manager";
import { readOnlyCommandMatcher } from "./matchers/command/read-only-command";

const COMMAND_MATCHERS: readonly BashCommandMatcher[] = [
	findCommandMatcher,
	builtinCommandMatcher,
	writeCommandMatcher,
	gitCommandMatcher,
	packageManagerCommandMatcher,
	readOnlyCommandMatcher,
];

export function classifyAnalyzedCommands(commands: readonly AnalyzedCommand[]): CommandClassificationSummary {
	const details: CommandClassification[] = [];
	let allRecognized = true;
	let anyWriteLike = false;
	let anyReadLike = false;
	let hasUnknownCommand = false;
	let hasDynamicArguments = false;

	for (const command of commands) {
		if (command.hasDynamicArgs || command.hasDynamicName) hasDynamicArguments = true;

		const classification = classifyCommand(command);
		details.push(classification);

		if (classification.kind === "read") anyReadLike = true;
		if (classification.kind === "write") anyWriteLike = true;
		if (classification.kind === "unknown") {
			hasUnknownCommand = true;
			allRecognized = false;
		}
	}

	return {
		allRecognized,
		anyWriteLike,
		anyReadLike,
		allReadOnly: details.length > 0 && !anyWriteLike && details.every((detail) => detail.kind === "read"),
		hasUnknownCommand,
		hasDynamicArguments,
		details,
	};
}

function classifyCommand(command: AnalyzedCommand): CommandClassification {
	for (const matcher of COMMAND_MATCHERS) {
		const match = matcher.evaluate(command);
		if (match) return match;
	}

	return {
		commandIndex: command.index,
		program: command.program,
		kind: "unknown",
	};
}
