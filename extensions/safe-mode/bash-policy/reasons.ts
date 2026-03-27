import type { BashDecisionReason, BashReasonCode } from "./types";

const MESSAGES: Record<BashReasonCode, string> = {
	"empty-command": "Bash command is empty and requires approval.",
	"parse-error": "Bash command could not be parsed safely.",
	"line-continuation": "Bash command ends in a line continuation and requires approval.",
	"input-redirection": "Bash command uses input redirection and requires approval.",
	"output-redirection": "Bash command uses output redirection and requires approval.",
	"command-substitution": "Bash command contains substitutions and requires approval.",
	"unknown-command": "Bash command includes unknown or unclassified commands.",
	"dynamic-arguments": "Bash command includes dynamic arguments and requires approval.",
	"read-only-command": "Bash command is read-only and matches the policy profile.",
	"write-command": "Bash command is write-like and requires approval.",
	"find-write-like-flag": "find includes write-capable flags and requires approval.",
	"git-read-subcommand": "git subcommand is read-only.",
	"git-write-subcommand": "git subcommand is write-like and requires approval.",
	"package-manager-write-subcommand": "Package manager subcommand is write-like and requires approval.",
	"command-builtin-read": "command -v/-V lookup is read-only.",
	"fallback-confirm": "Bash command requires approval by default.",
};

export function createReason(args: {
	code: BashReasonCode;
	matcherId: string;
	commandIndex?: number;
	program?: string;
	detail?: string;
}): BashDecisionReason {
	return {
		code: args.code,
		message: MESSAGES[args.code],
		matcherId: args.matcherId,
		commandIndex: args.commandIndex,
		program: args.program,
		detail: args.detail,
	};
}

export function reasonMessageFromDecision(reasons: readonly BashDecisionReason[]): string | undefined {
	return reasons[0]?.message;
}
