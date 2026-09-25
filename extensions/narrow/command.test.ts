import { describe, expect, test } from "bun:test";
import { parseNarrowCommand } from "./command";

describe("parseNarrowCommand", () => {
	test("no arguments toggles", () => {
		expect(parseNarrowCommand("")).toEqual({ kind: "toggle" });
		expect(parseNarrowCommand("   ")).toEqual({ kind: "toggle" });
	});

	test("on and off", () => {
		expect(parseNarrowCommand("on")).toEqual({ kind: "enable" });
		expect(parseNarrowCommand("ON")).toEqual({ kind: "enable" });
		expect(parseNarrowCommand("off")).toEqual({ kind: "disable" });
		expect(parseNarrowCommand(" toggle ")).toEqual({ kind: "toggle" });
		expect(parseNarrowCommand("status")).toEqual({ kind: "status" });
	});

	test("width can be attached to on or set", () => {
		expect(parseNarrowCommand("on 100")).toEqual({ kind: "enable", width: 100 });
		expect(parseNarrowCommand("set 90")).toEqual({ kind: "enable", width: 90 });
	});

	test("set takes an optional bias half", () => {
		expect(parseNarrowCommand("set 100/-50")).toEqual({ kind: "enable", width: 100, bias: -50 });
		expect(parseNarrowCommand("set 100/50")).toEqual({ kind: "enable", width: 100, bias: 50 });
		expect(parseNarrowCommand("set 100/+25")).toEqual({ kind: "enable", width: 100, bias: 25 });
		expect(parseNarrowCommand("set 100")).toEqual({ kind: "enable", width: 100 });
	});

	test("set rejects a malformed bias half", () => {
		expect(parseNarrowCommand("set 100/")).toMatchObject({ error: expect.stringContaining("missing a bias") });
		expect(parseNarrowCommand("set 100/left")).toMatchObject({ error: expect.stringContaining("not a bias percentage") });
		expect(parseNarrowCommand("set 100/500")).toMatchObject({ error: expect.stringContaining("between -100 and 100") });
		expect(parseNarrowCommand("set 100/-50/2")).toMatchObject({ error: expect.stringContaining('expected "columns"') });
		expect(parseNarrowCommand("set /-50")).toMatchObject({ error: expect.stringContaining("needs a column count") });
	});

	test("bias reports or sets the sideways offset", () => {
		expect(parseNarrowCommand("bias")).toEqual({ kind: "showBias" });
		expect(parseNarrowCommand("bias -50")).toEqual({ kind: "setBias", bias: -50 });
		expect(parseNarrowCommand("bias 50")).toEqual({ kind: "setBias", bias: 50 });
		expect(parseNarrowCommand("BIAS +25")).toEqual({ kind: "setBias", bias: 25 });
	});

	test("rejects nonsense with a message", () => {
		expect(parseNarrowCommand("set")).toMatchObject({ error: expect.stringContaining("set needs") });
		expect(parseNarrowCommand("set wide")).toMatchObject({ error: expect.stringContaining("not a column count") });
		expect(parseNarrowCommand("off 120")).toMatchObject({ error: expect.stringContaining("off does not take") });
		expect(parseNarrowCommand("toggle 120")).toMatchObject({ error: expect.stringContaining("toggle does not take") });
		expect(parseNarrowCommand("status now")).toMatchObject({ error: expect.stringContaining("status does not take") });
		expect(parseNarrowCommand("on 90 100")).toMatchObject({ error: expect.stringContaining("unexpected argument") });
		expect(parseNarrowCommand("sideways")).toMatchObject({ error: expect.stringContaining("unknown option") });
	});

	test("rejects a bias that is not a number or is out of range", () => {
		expect(parseNarrowCommand("bias left")).toMatchObject({ error: expect.stringContaining("not a bias percentage") });
		expect(parseNarrowCommand("bias -500")).toMatchObject({ error: expect.stringContaining("between -100 and 100") });
		expect(parseNarrowCommand("bias 50%")).toMatchObject({ error: expect.stringContaining("not a bias percentage") });
	});

	test("rejects widths outside the supported range", () => {
		expect(parseNarrowCommand("set 4")).toMatchObject({ error: expect.stringContaining("between 20 and 2000") });
		expect(parseNarrowCommand("set 5000")).toMatchObject({ error: expect.stringContaining("between 20 and 2000") });
	});
});
