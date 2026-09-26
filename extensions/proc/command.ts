/** Return the shell command after `x`, preserving quotes and internal whitespace. */
export function parseRunCommand(rawArgs: string): string | undefined {
	const args = rawArgs.trim();
	const match = /^x(?:\s|$)/.exec(args);
	if (!match) return undefined;
	return args.slice(match[0].length).trim();
}
