import { describe, expect, test } from "bun:test";
import { parseRenewArguments } from "./arguments.ts";

describe("/renew arguments", () => {
	test("accepts an empty argument string and whitespace", () => {
		expect(parseRenewArguments("  ")).toEqual({ ok: true, options: { keepAgents: false, stopProc: false } });
	});

	test("accepts active-work options in either order", () => {
		expect(parseRenewArguments("+agents")).toEqual({ ok: true, options: { keepAgents: true, stopProc: false } });
		expect(parseRenewArguments("-proc")).toEqual({ ok: true, options: { keepAgents: false, stopProc: true } });
		expect(parseRenewArguments("-proc +agents")).toEqual({ ok: true, options: { keepAgents: true, stopProc: true } });
	});

	test("rejects unknown flags instead of silently ignoring them", () => {
		expect(parseRenewArguments("--unknown")).toEqual({ ok: false, message: "Unknown /renew option: --unknown" });
	});
});
