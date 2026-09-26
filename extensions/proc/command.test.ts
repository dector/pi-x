import { expect, test } from "bun:test";
import { parseRunCommand } from "./command.ts";

test("x passes the user's shell command through without splitting quotes or spacing", () => {
	expect(parseRunCommand('x printf "%s\\n" "foo  bar"')).toBe('printf "%s\\n" "foo  bar"');
	expect(parseRunCommand("  x   foo bar  ")).toBe("foo bar");
	expect(parseRunCommand("x")).toBe("");
	expect(parseRunCommand("x   ")).toBe("");
	expect(parseRunCommand("xyz foo")).toBeUndefined();
	expect(parseRunCommand("list")).toBeUndefined();
});
