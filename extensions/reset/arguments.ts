export interface ResetOptions {
	keepAgents: boolean;
	stopProc: boolean;
}

export type ResetArguments =
	| { ok: true; options: ResetOptions }
	| { ok: false; message: string };

/** Parse /reset flags without silently accepting unknown options. */
export function parseResetArguments(args: string): ResetArguments {
	const options: ResetOptions = { keepAgents: false, stopProc: false };
	const tokens = args.trim() ? args.trim().split(/\s+/) : [];
	for (const token of tokens) {
		if (token === "+agents") options.keepAgents = true;
		else if (token === "-proc") options.stopProc = true;
		else return { ok: false, message: `Unknown /reset option: ${token}` };
	}
	return { ok: true, options };
}
