import { describe, expect, test } from "bun:test";
import { parseResetArguments } from "./arguments.ts";

describe("/reset arguments", () => {
	test("accepts an empty argument string and whitespace", () => {
		expect(parseResetArguments("  ")).toEqual({ ok: true, options: { keepAgents: false, stopProc: false } });
	});

	test("reserves and clearly rejects deferred active-work options", () => {
		expect(parseResetArguments("+agents").message).toContain("checkpoint 2");
		expect(parseResetArguments("-proc").message).toContain("checkpoint 2");
		expect(parseResetArguments("+agents -proc").ok).toBe(false);
	});

	test("rejects unknown flags instead of silently ignoring them", () => {
		expect(parseResetArguments("--unknown")).toEqual({ ok: false, message: "Unknown /reset option: --unknown" });
	});
});
