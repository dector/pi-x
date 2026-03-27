import { analyzeBash } from "./analyze";
import { classifyAnalyzedCommands } from "./classify-command";
import { matchersForProfile } from "./profiles";
import { runMatcherRegistry } from "./registry";
import type { BashPolicyDecision } from "./types";

export function validateBashCommand(args: {
	command: string;
	profile: "reader" | "smart";
}): BashPolicyDecision {
	const analysis = analyzeBash(args.command);
	const classification = classifyAnalyzedCommands(analysis.commands);
	const decision = runMatcherRegistry({
		matchers: matchersForProfile(args.profile),
		ctx: {
			profileId: args.profile,
			analysis,
			classification,
		},
	});

	return {
		...decision,
		analysis,
	};
}

export { classifyAnalyzedCommands };
