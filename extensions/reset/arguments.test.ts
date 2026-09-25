import { describe, expect, test } from "bun:test";
import { parseResetArguments } from "./arguments.ts";

describe("/reset arguments", () => {
	test("accepts an empty argument string and whitespace", () => {
		expect(parseResetArguments("  ")).toEqual({ ok: true, options: { keepAgents: false, stopProc: false } });
	});

	test("accepts active-work options in either order", () => {
		expect(parseResetArguments("+agents")).toEqual({ ok: true, options: { keepAgents: true, stopProc: false } });
		expect(parseResetArguments("-proc")).toEqual({ ok: true, options: { keepAgents: false, stopProc: true } });
		expect(parseResetArguments("-proc +agents")).toEqual({ ok: true, options: { keepAgents: true, stopProc: true } });
	});

	test("rejects unknown flags instead of silently ignoring them", () => {
		expect(parseResetArguments("--unknown")).toEqual({ ok: false, message: "Unknown /reset option: --unknown" });
	});
});
