import parseBash from "bash-parser";
import type {
	AnalyzedCommand,
	AnalyzedRedirect,
	BashAggregateFacts,
	BashAnalysis,
	BashParseStatus,
	BashStructureFacts,
	SourceKind,
} from "./types";
import { normalizeExecutable } from "./shared/normalization";

type MutableState = {
	commands: AnalyzedCommand[];
	paths: string[];
	structure: Omit<BashStructureFacts, "isPlainCommand">;
};

const REDIRECT_TOKEN_TYPES = new Set([
	"less",
	"great",
	"dgreat",
	"clobber",
	"lessand",
	"greatand",
	"lessgreat",
	"dless",
	"dlessdash",
]);

export function analyzeBash(source: string): BashAnalysis {
	const trimmedSource = source.trim();
	if (trimmedSource.length === 0) {
		return buildEarly(source, trimmedSource, { ok: false, kind: "empty" });
	}

	if (trimmedSource.endsWith("\\")) {
		return buildEarly(source, trimmedSource, { ok: false, kind: "line-continuation" });
	}

	let ast: unknown;
	try {
		ast = parseBash(trimmedSource);
	} catch {
		return buildEarly(source, trimmedSource, { ok: false, kind: "parse-error" });
	}

	const state: MutableState = {
		commands: [],
		paths: [],
		structure: {
			hasPipe: false,
			hasOtherControlFlow: false,
			hasInputRedirection: false,
			hasOutputRedirection: false,
			hasSubstitution: false,
		},
	};

	visitNode(ast as any, state, "top-level");

	const structure: BashStructureFacts = {
		...state.structure,
		isPlainCommand: isSinglePlainCommand(ast as any, state.structure),
	};

	const aggregate: BashAggregateFacts = {
		hasReads: false,
		hasWrites: false,
		hasUnknownCommand: false,
		hasDynamicArguments: false,
	};

	for (const cmd of state.commands) {
		if (cmd.hasDynamicArgs || cmd.hasDynamicName) aggregate.hasDynamicArguments = true;
	}

	return {
		source,
		trimmedSource,
		parse: { ok: true },
		ast,
		commandCount: state.commands.length,
		commands: state.commands,
		paths: state.paths,
		structure,
		aggregate,
	};
}

function buildEarly(source: string, trimmedSource: string, parse: BashParseStatus): BashAnalysis {
	return {
		source,
		trimmedSource,
		parse,
		commandCount: 0,
		commands: [],
		paths: [],
		structure: {
			hasPipe: false,
			hasOtherControlFlow: false,
			hasInputRedirection: false,
			hasOutputRedirection: false,
			hasSubstitution: false,
			isPlainCommand: false,
		},
		aggregate: {
			hasReads: false,
			hasWrites: false,
			hasUnknownCommand: false,
			hasDynamicArguments: false,
		},
	};
}

function visitNode(node: any, state: MutableState, sourceKind: SourceKind): void {
	if (!node || typeof node !== "object") return;

	switch (node.type) {
		case "Script": {
			const commands = asArray(node.commands);
			if (commands.length > 1) state.structure.hasOtherControlFlow = true;
			for (const command of commands) visitNode(command, state, sourceKind);
			return;
		}
		case "LogicalExpression":
			state.structure.hasOtherControlFlow = true;
			visitNode(node.left, state, sourceKind);
			visitNode(node.right, state, sourceKind);
			return;
		case "Pipeline":
			state.structure.hasPipe = true;
			for (const command of asArray(node.commands)) visitNode(command, state, sourceKind);
			return;
		case "Command":
			visitCommandNode(node, state, sourceKind);
			return;
		case "Subshell":
			state.structure.hasOtherControlFlow = true;
			visitNode(node.list, state, sourceKind);
			return;
		case "CompoundList":
			for (const command of asArray(node.commands)) visitNode(command, state, sourceKind);
			return;
		case "If":
			state.structure.hasOtherControlFlow = true;
			visitNode(node.clause, state, sourceKind);
			visitNode(node.then, state, sourceKind);
			visitNode(node.else, state, sourceKind);
			return;
		case "For":
		case "While":
		case "Until":
			state.structure.hasOtherControlFlow = true;
			visitNode(node.clause, state, sourceKind);
			visitNode(node.do, state, sourceKind);
			return;
		case "Case":
			state.structure.hasOtherControlFlow = true;
			visitNode(node.clause, state, sourceKind);
			for (const item of asArray(node.cases)) visitNode(item, state, sourceKind);
			return;
		case "Function":
			state.structure.hasOtherControlFlow = true;
			visitNode(node.body, state, sourceKind);
			return;
		default:
			return;
	}
}

function visitCommandNode(node: any, state: MutableState, sourceKind: SourceKind): void {
	if (node.async) state.structure.hasOtherControlFlow = true;

	const index = state.commands.length;
	const extracted = extractCommand(node, sourceKind, index);
	if (extracted) {
		state.commands.push(extracted);
		collectPathCandidates(node, extracted, state.paths);
	} else {
		collectPathCandidates(node, undefined, state.paths);
	}

	for (const word of collectCommandWords(node)) {
		evaluateWordExpansions(word, state);
	}

	for (const redirect of collectRedirectNodes(node)) {
		const op = getRedirectOperator(redirect);
		if (op.includes(">")) state.structure.hasOutputRedirection = true;
		if (op.includes("<")) state.structure.hasInputRedirection = true;
		evaluateWordExpansions(redirect?.file, state);
	}
}

function extractCommand(node: any, sourceKind: SourceKind, index: number): AnalyzedCommand | undefined {
	const programRaw = extractWordText(node?.name);
	if (!programRaw) return undefined;

	const program = normalizeExecutable(programRaw);
	const args: string[] = [];
	let hasDynamicName = hasWordExpansion(node?.name);
	let hasDynamicArgs = false;
	const redirects: AnalyzedRedirect[] = [];

	for (const redirect of collectRedirectNodes(node)) {
		const operator = getRedirectOperator(redirect);
		const fileText = extractWordText(redirect?.file) || undefined;
		const hasExpansion = hasWordExpansion(redirect?.file);
		redirects.push({
			operator,
			fileText,
			direction: operator.includes(">") ? "output" : operator.includes("<") ? "input" : "other",
			hasExpansion,
		});
		if (hasExpansion) hasDynamicArgs = true;
	}

	for (const item of asArray(node?.suffix)) {
		if (!item || item.type !== "Word") continue;
		const text = extractWordText(item);
		if (text.length > 0) args.push(text);
		if (hasWordExpansion(item)) hasDynamicArgs = true;
	}

	const hasAnyExpansion = hasDynamicName || hasDynamicArgs;
	if (hasDynamicName) hasDynamicName = true;

	return {
		index,
		programRaw,
		program,
		args,
		hasDynamicName,
		hasDynamicArgs,
		hasAnyExpansion,
		redirects,
		sourceKind,
	};
}

function collectPathCandidates(node: any, command: AnalyzedCommand | undefined, paths: string[]): void {
	if (command) {
		if (command.program === "cd") {
			if (command.args[0]) paths.push(command.args[0]);
		} else {
			for (const arg of command.args) paths.push(arg);
		}
	}

	for (const redirect of collectRedirectNodes(node)) {
		const filePath = extractWordText(redirect?.file);
		if (filePath) paths.push(filePath);
	}
}

function evaluateWordExpansions(word: any, state: MutableState): void {
	if (!word || typeof word !== "object") return;
	const expansions = asArray(word.expansion);
	if (expansions.length === 0) return;

	state.structure.hasSubstitution = true;
	for (const expansion of expansions) {
		if (expansion?.type === "CommandExpansion" && expansion.commandAST) {
			visitNode(expansion.commandAST, state, "command-substitution");
		}
	}
}

function collectCommandWords(node: any): any[] {
	const words: any[] = [];
	for (const item of [...asArray(node?.prefix), ...asArray(node?.suffix)]) {
		if (!item) continue;
		if (item.type === "Word" || item.type === "AssignmentWord") words.push(item);
	}
	if (node?.name) words.push(node.name);
	return words;
}

function collectRedirectNodes(node: any): any[] {
	const redirects: any[] = [];
	for (const item of [...asArray(node?.prefix), ...asArray(node?.suffix)]) {
		if (!item) continue;
		if (item.type === "Redirect" || isStandaloneRedirectToken(item)) redirects.push(item);
	}
	return redirects;
}

function getRedirectOperator(node: any): string {
	if (!node || typeof node !== "object") return "";
	if (typeof node?.op?.text === "string") return node.op.text;
	if (typeof node?.text === "string") return node.text;
	return "";
}

function isStandaloneRedirectToken(node: any): boolean {
	if (!node || typeof node?.type !== "string") return false;
	return REDIRECT_TOKEN_TYPES.has(node.type);
}

function extractWordText(word: any): string {
	if (!word || typeof word.text !== "string") return "";
	return word.text;
}

function hasWordExpansion(word: any): boolean {
	return asArray(word?.expansion).length > 0;
}

function isSinglePlainCommand(ast: any, structure: Omit<BashStructureFacts, "isPlainCommand">): boolean {
	if (!ast || ast.type !== "Script") return false;
	const commands = asArray(ast.commands);
	if (commands.length !== 1) return false;
	const only = commands[0];
	if (!only || only.type !== "Command") return false;
	if (only.async) return false;
	if (structure.hasPipe || structure.hasOtherControlFlow || structure.hasSubstitution) return false;
	if (structure.hasInputRedirection || structure.hasOutputRedirection) return false;
	return true;
}

function asArray<T>(value: T | T[] | undefined): T[] {
	if (Array.isArray(value)) return value;
	if (value === undefined || value === null) return [];
	return [value];
}
