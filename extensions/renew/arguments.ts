export interface RenewOptions {
	keepAgents: boolean;
	stopProc: boolean;
}

export type RenewArguments =
	| { ok: true; options: RenewOptions }
	| { ok: false; message: string };

/** Parse /renew flags without silently accepting unknown options. */
export function parseRenewArguments(args: string): RenewArguments {
	const options: RenewOptions = { keepAgents: false, stopProc: false };
	const tokens = args.trim() ? args.trim().split(/\s+/) : [];
	for (const token of tokens) {
		if (token === "+agents") options.keepAgents = true;
		else if (token === "-proc") options.stopProc = true;
		else return { ok: false, message: `Unknown /renew option: ${token}` };
	}
	return { ok: true, options };
}
