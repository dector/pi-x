export function normalizeExecutable(rawProgram: string): string {
	const segments = rawProgram.split("/");
	const last = segments[segments.length - 1] ?? rawProgram;
	return last.toLowerCase();
}

export function normalizeSubcommand(value: string | undefined): string | undefined {
	if (!value) return undefined;
	if (value.startsWith("-")) return undefined;
	return value.toLowerCase();
}
