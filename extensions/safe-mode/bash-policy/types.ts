export type BashPolicyAction = "allow" | "confirm" | "block";

export type BashParseStatus =
	| { ok: true }
	| { ok: false; kind: "empty" | "line-continuation" | "parse-error" };

export type BashStructureFacts = {
	hasPipe: boolean;
	hasOtherControlFlow: boolean;
	hasInputRedirection: boolean;
	hasOutputRedirection: boolean;
	hasSubstitution: boolean;
	isPlainCommand: boolean;
};

export type BashAggregateFacts = {
	hasReads: boolean;
	hasWrites: boolean;
	hasUnknownCommand: boolean;
	hasDynamicArguments: boolean;
};

export type SourceKind = "top-level" | "command-substitution";

export type AnalyzedRedirect = {
	operator: string;
	fileText?: string;
	direction: "input" | "output" | "other";
	hasExpansion: boolean;
};

export type AnalyzedCommand = {
	index: number;
	programRaw: string;
	program: string;
	args: readonly string[];
	hasDynamicName: boolean;
	hasDynamicArgs: boolean;
	hasAnyExpansion: boolean;
	redirects: readonly AnalyzedRedirect[];
	sourceKind: SourceKind;
};

export type BashAnalysis = {
	source: string;
	trimmedSource: string;
	parse: BashParseStatus;
	ast?: unknown;
	commandCount: number;
	commands: readonly AnalyzedCommand[];
	paths: readonly string[];
	structure: BashStructureFacts;
	aggregate: BashAggregateFacts;
};

export type BashReasonCode =
	| "empty-command"
	| "parse-error"
	| "line-continuation"
	| "input-redirection"
	| "output-redirection"
	| "command-substitution"
	| "unknown-command"
	| "dynamic-arguments"
	| "read-only-command"
	| "write-command"
	| "find-write-like-flag"
	| "git-read-subcommand"
	| "git-write-subcommand"
	| "package-manager-write-subcommand"
	| "command-builtin-read"
	| "fallback-confirm";

export type BashDecisionReason = {
	code: BashReasonCode;
	message: string;
	matcherId: string;
	commandIndex?: number;
	program?: string;
	detail?: string;
};

export type BashPolicyDecision = {
	action: BashPolicyAction;
	reasons: readonly BashDecisionReason[];
	matchedBy: readonly string[];
	analysis: BashAnalysis;
};

export type CommandClassificationKind = "read" | "write" | "unknown";

export type CommandClassification = {
	commandIndex: number;
	program: string;
	kind: CommandClassificationKind;
	reasonCode?: BashReasonCode;
	detail?: string;
};

export type CommandClassificationSummary = {
	allRecognized: boolean;
	anyWriteLike: boolean;
	anyReadLike: boolean;
	allReadOnly: boolean;
	hasUnknownCommand: boolean;
	hasDynamicArguments: boolean;
	details: readonly CommandClassification[];
};

export interface BashCommandMatcher {
	id: string;
	evaluate(command: AnalyzedCommand): CommandClassification | undefined;
}

export type BashMatcherContext = {
	profileId: "reader" | "smart";
	analysis: BashAnalysis;
	classification: CommandClassificationSummary;
};

export type BashMatcherResult = {
	action: BashPolicyAction;
	reasons: readonly BashDecisionReason[];
};

export interface BashMatcher {
	id: string;
	priority: number;
	evaluate(ctx: BashMatcherContext): BashMatcherResult | undefined;
}
