export interface ResetOptions {
	keepAgents: boolean;
	stopProc: boolean;
}

export type ResetArguments =
	| { ok: true; options: ResetOptions }
	| { ok: false; message: string };

/** Parse /reset flags. These flags are reserved for checkpoint 2. */
export function parseResetArguments(args: string): ResetArguments {
	const options: ResetOptions = { keepAgents: false, stopProc: false };
	const tokens = args.trim() ? args.trim().split(/\s+/) : [];
	for (const token of tokens) {
		if (token === "+agents") options.keepAgents = true;
		else if (token === "-proc") options.stopProc = true;
		else return { ok: false, message: `Unknown /reset option: ${token}` };
	}
	if (options.keepAgents || options.stopProc) {
		return {
			ok: false,
			message: "/reset +agents and -proc are not available yet; active-agent handoff and process stopping are deferred to checkpoint 2.",
		};
	}
	return { ok: true, options };
}
