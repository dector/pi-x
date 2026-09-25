import { describe, expect, test } from "bun:test";
import { shiftInputMouseColumns, shiftOutputColumns } from "./transform";

const ESC = "\u001B";

describe("shiftOutputColumns", () => {
	test("is a no-op without a margin", () => {
		const frame = `${ESC}[1;1Hhello`;
		expect(shiftOutputColumns(frame, 0)).toBe(frame);
		expect(shiftOutputColumns("", 4)).toBe("");
	});

	test("indents carriage returns so every line starts at the margin", () => {
		expect(shiftOutputColumns("\r\n", 3)).toBe(`\r\n${"   "}`);
		expect(shiftOutputColumns("line\r\nnext\r", 2)).toBe("line\r\n  next\r  ");
	});

	test("shifts absolute cursor positions", () => {
		expect(shiftOutputColumns(`${ESC}[5;1H`, 4)).toBe(`${ESC}[5;5H`);
		expect(shiftOutputColumns(`${ESC}[12;37H`, 10)).toBe(`${ESC}[12;47H`);
	});

	test("treats missing cursor position parameters as 1", () => {
		expect(shiftOutputColumns(`${ESC}[H`, 6)).toBe(`${ESC}[1;7H`);
		expect(shiftOutputColumns(`${ESC}[;3H`, 6)).toBe(`${ESC}[1;9H`);
		expect(shiftOutputColumns(`${ESC}[4H`, 6)).toBe(`${ESC}[4;7H`);
	});

	test("shifts absolute columns and line hops", () => {
		expect(shiftOutputColumns(`${ESC}[1G`, 5)).toBe(`${ESC}[6G`);
		expect(shiftOutputColumns(`${ESC}[G`, 5)).toBe(`${ESC}[6G`);
		expect(shiftOutputColumns(`${ESC}[F`, 5)).toBe(`${ESC}[6F`);
		expect(shiftOutputColumns(`${ESC}[E`, 5)).toBe(`${ESC}[6E`);
	});

	test("leaves sequences that do not address a column alone", () => {
		const frame = [
			`${ESC}[?2026h`,
			`${ESC}[2J`,
			`${ESC}[3J`,
			`${ESC}[2K`,
			`${ESC}[2A`,
			`${ESC}[3B`,
			`${ESC}[?25l`,
			"\u001B[38;5;42mgreen\u001B[0m",
			`]8;;https://example.com/1;5Hlink]8;;\u0007`,
		].join("");
		expect(shiftOutputColumns(frame, 7)).toBe(frame);
	});

	test("shifts a realistic fullscreen frame", () => {
		const frame = `${ESC}[?2026h${ESC}[1;1H${ESC}[2Khello${ESC}[2;1H${ESC}[2Kworld${ESC}[2;4H${ESC}[?25h${ESC}[?2026l`;
		expect(shiftOutputColumns(frame, 2)).toBe(
			`${ESC}[?2026h${ESC}[1;3H${ESC}[2Khello${ESC}[2;3H${ESC}[2Kworld${ESC}[2;6H${ESC}[?25h${ESC}[?2026l`,
		);
	});

	test("a CRLF pair is padded once", () => {
		expect(shiftOutputColumns("\r\n", 1)).toBe("\r\n ");
	});
});

describe("shiftInputMouseColumns", () => {
	test("is a no-op without a margin", () => {
		const input = `${ESC}[<0;50;10M`;
		expect(shiftInputMouseColumns(input, 0)).toBe(input);
	});

	test("shifts SGR press and release reports left", () => {
		expect(shiftInputMouseColumns(`${ESC}[<0;50;10M`, 20)).toBe(`${ESC}[<0;30;10M`);
		expect(shiftInputMouseColumns(`${ESC}[<0;50;10m`, 20)).toBe(`${ESC}[<0;30;10m`);
	});

	test("shifts wheel reports, which use the same format", () => {
		expect(shiftInputMouseColumns(`${ESC}[<64;41;3M`, 20)).toBe(`${ESC}[<64;21;3M`);
	});

	test("clamps clicks in the left margin to the first column", () => {
		expect(shiftInputMouseColumns(`${ESC}[<0;3;10M`, 20)).toBe(`${ESC}[<0;1;10M`);
	});

	test("passes keyboard input through untouched", () => {
		const keys = `hello\r${ESC}[A${ESC}[13;2u${ESC}[200~pasted\u001B[201~`;
		expect(shiftInputMouseColumns(keys, 30)).toBe(keys);
	});
});
