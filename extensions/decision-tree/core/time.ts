export function nowIso(): string {
	return new Date().toISOString();
}

export function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) return false;
	return new Date(timestamp).toISOString() === value;
}
