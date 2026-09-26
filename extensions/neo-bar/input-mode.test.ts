import { describe, expect, test } from "bun:test";
import { isInputModeSetPayload, stripEditorCursor } from "./index";
import type { NeoBarInputMode } from "./contract";

const CURSOR_MARKER = "\u001B_pi:c\u0007";

describe("neo-bar input mode", () => {
	test("accepts exactly the two supported set payloads", () => {
		const modes: NeoBarInputMode[] = ["normal", "insert"];
		for (const mode of modes) {
			expect(isInputModeSetPayload({ mode })).toBe(true);
		}
		for (const payload of [undefined, null, {}, { mode: "visual" }, { mode: 1 }, "normal"]) {
			expect(isInputModeSetPayload(payload)).toBe(false);
		}
	});

	test("strips the hardware-cursor marker and the reverse-video block", () => {
		const line = `prefix ${CURSOR_MARKER}\x1b[7mX\x1b[0m suffix`;
		const stripped = stripEditorCursor([line]);
		expect(stripped).toEqual([`prefix X\x1b[0m suffix`]);
		expect(stripped[0]).not.toContain(CURSOR_MARKER);
		expect(stripped[0]).not.toContain("\x1b[7m");
	});

	test("leaves lines without a cursor untouched", () => {
		const lines = ["plain", "\x1b[38;5;1mred\x1b[0m"];
		expect(stripEditorCursor(lines)).toEqual(lines);
	});
});
