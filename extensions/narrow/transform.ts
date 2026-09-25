/**
 * Pure ANSI helpers used by the narrow viewport.
 *
 * Pi centers a narrow column by writing the same frame it would write at full
 * width, but shifted right by `margin` cells. That only needs a column shift on
 * the handful of sequences pi uses to address a column:
 *
 *   `\r` / `\r\n`        carriage return, i.e. "column 1 of this line"
 *   `ESC [ r ; c H`     absolute cursor position (row; column)
 *   `ESC [ c G`         absolute column
 *   `ESC [ F` / `E`     previous / next line, column 1
 *
 * Everything else is passed through untouched: SGR styling, erase line and
 * erase display, vertical moves, OSC hyperlinks, and kitty/iterm2 image
 * payloads. Those either do not address a column or place images relative to
 * the cursor, which the shift already moved.
 *
 * Mouse input needs the inverse: SGR reports (`ESC [ < b ; x ; y M`) carry a
 * 1-based column, so the margin is subtracted before pi parses them.
 */

const ESC = "\u001B";

/** `\r\n` and `\r` come first so a CRLF pair is consumed as one token. */
const OUTPUT_PATTERN = /\r\n|\r|\u001B\[([0-9;]*)([HEFG])/g;

/** SGR mouse report: button, 1-based column, 1-based row, press/release. */
const MOUSE_PATTERN = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/g;

function paramOrOne(value: string | undefined): number {
	if (value === undefined || value === "") return 1;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Shift every column-addressing sequence in a chunk of pi output right by
 * `margin` cells. Returns the input unchanged when there is nothing to do.
 */
export function shiftOutputColumns(data: string, margin: number): string {
	if (margin <= 0 || data.length === 0) return data;

	const leftPad = " ".repeat(margin);
	return data.replace(OUTPUT_PATTERN, (match, params: string | undefined, final: string | undefined) => {
		// `\r` and `\r\n`: move to column 1, then step over the left margin.
		if (final === undefined) return `${match}${leftPad}`;

		// `ESC [ F` / `ESC [ E` always land on column 1 of another line.
		if (final !== "H" && final !== "G") return `${ESC}[${1 + margin}${final}`;

		if (final === "G") {
			return `${ESC}[${paramOrOne(params) + margin}G`;
		}

		// `ESC [ H`: row stays, column shifts. Missing params mean 1.
		const parts = params === undefined || params === "" ? [] : params.split(";");
		const row = parts.length > 0 ? paramOrOne(parts[0]) : 1;
		const column = paramOrOne(parts[1]) + margin;
		return `${ESC}[${row};${column}H`;
	});
}

/**
 * Shift SGR mouse reports left by `margin` cells so pi sees the column the user
 * aimed at. Columns below 1 clamp to 1: that is a click inside the margin,
 * which pi clamps to its first column anyway.
 */
export function shiftInputMouseColumns(data: string, margin: number): string {
	if (margin <= 0 || !data.includes(`${ESC}[<`)) return data;

	return data.replace(MOUSE_PATTERN, (_match, button: string, x: string, y: string, kind: string) => {
		const shifted = Math.max(1, Number.parseInt(x, 10) - margin);
		return `${ESC}[<${button};${shifted};${y}${kind}`;
	});
}
