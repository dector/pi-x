import { describe, expect, test } from "bun:test";
import { parseFocusModeCommand } from "./command";

describe("parseFocusModeCommand", () => {
	test("no arguments toggles", () => {
		expect(parseFocusModeCommand("")).toEqual({ kind: "toggle" });
		expect(parseFocusModeCommand("   ")).toEqual({ kind: "toggle" });
	});

	test("on and off", () => {
		expect(parseFocusModeCommand("on")).toEqual({ kind: "enable" });
		expect(parseFocusModeCommand("ON")).toEqual({ kind: "enable" });
		expect(parseFocusModeCommand("off")).toEqual({ kind: "disable" });
		expect(parseFocusModeCommand(" toggle ")).toEqual({ kind: "toggle" });
		expect(parseFocusModeCommand("status")).toEqual({ kind: "status" });
	});

	test("width can be attached to on or set", () => {
		expect(parseFocusModeCommand("on 100")).toEqual({ kind: "enable", width: 100 });
		expect(parseFocusModeCommand("set 90")).toEqual({ kind: "enable", width: 90 });
	});

	test("set takes an optional bias half", () => {
		expect(parseFocusModeCommand("set 100/-50")).toEqual({ kind: "enable", width: 100, bias: -50 });
		expect(parseFocusModeCommand("set 100/50")).toEqual({ kind: "enable", width: 100, bias: 50 });
		expect(parseFocusModeCommand("set 100/+25")).toEqual({ kind: "enable", width: 100, bias: 25 });
		expect(parseFocusModeCommand("set 100")).toEqual({ kind: "enable", width: 100 });
	});

	test("set rejects a malformed bias half", () => {
		expect(parseFocusModeCommand("set 100/")).toMatchObject({ error: expect.stringContaining("missing a bias") });
		expect(parseFocusModeCommand("set 100/left")).toMatchObject({ error: expect.stringContaining("not a bias percentage") });
		expect(parseFocusModeCommand("set 100/500")).toMatchObject({ error: expect.stringContaining("between -100 and 100") });
		expect(parseFocusModeCommand("set 100/-50/2")).toMatchObject({ error: expect.stringContaining('expected "columns"') });
		expect(parseFocusModeCommand("set /-50")).toMatchObject({ error: expect.stringContaining("needs a column count") });
	});

	test("bias reports or sets the sideways offset", () => {
		expect(parseFocusModeCommand("bias")).toEqual({ kind: "showBias" });
		expect(parseFocusModeCommand("bias -50")).toEqual({ kind: "setBias", bias: -50 });
		expect(parseFocusModeCommand("bias 50")).toEqual({ kind: "setBias", bias: 50 });
		expect(parseFocusModeCommand("BIAS +25")).toEqual({ kind: "setBias", bias: 25 });
	});

	test("rejects nonsense with a message", () => {
		expect(parseFocusModeCommand("set")).toMatchObject({ error: expect.stringContaining("set needs") });
		expect(parseFocusModeCommand("set wide")).toMatchObject({ error: expect.stringContaining("not a column count") });
		expect(parseFocusModeCommand("off 120")).toMatchObject({ error: expect.stringContaining("off does not take") });
		expect(parseFocusModeCommand("toggle 120")).toMatchObject({ error: expect.stringContaining("toggle does not take") });
		expect(parseFocusModeCommand("status now")).toMatchObject({ error: expect.stringContaining("status does not take") });
		expect(parseFocusModeCommand("on 90 100")).toMatchObject({ error: expect.stringContaining("unexpected argument") });
		expect(parseFocusModeCommand("sideways")).toMatchObject({ error: expect.stringContaining("unknown option") });
	});

	test("rejects a bias that is not a number or is out of range", () => {
		expect(parseFocusModeCommand("bias left")).toMatchObject({ error: expect.stringContaining("not a bias percentage") });
		expect(parseFocusModeCommand("bias -500")).toMatchObject({ error: expect.stringContaining("between -100 and 100") });
		expect(parseFocusModeCommand("bias 50%")).toMatchObject({ error: expect.stringContaining("not a bias percentage") });
	});

	test("rejects widths outside the supported range", () => {
		expect(parseFocusModeCommand("set 4")).toMatchObject({ error: expect.stringContaining("between 20 and 2000") });
		expect(parseFocusModeCommand("set 5000")).toMatchObject({ error: expect.stringContaining("between 20 and 2000") });
	});
});

describe("config", () => {
	test("opens the dialog", () => {
		expect(parseFocusModeCommand("config")).toEqual({ kind: "config" });
	});

	test("takes no argument", () => {
		expect(parseFocusModeCommand("config now")).toMatchObject({ error: expect.stringContaining("does not take an argument") });
	});
});

describe("-s session flag", () => {
	test("applies without persisting", () => {
		expect(parseFocusModeCommand("-s set 100")).toEqual({ kind: "enable", width: 100, session: true });
		expect(parseFocusModeCommand("set 100 -s")).toEqual({ kind: "enable", width: 100, session: true });
		expect(parseFocusModeCommand("--session set 100/-50")).toEqual({ kind: "enable", width: 100, bias: -50, session: true });
		expect(parseFocusModeCommand("-s bias -50")).toEqual({ kind: "setBias", bias: -50, session: true });
		expect(parseFocusModeCommand("-s off")).toEqual({ kind: "disable", session: true });
		expect(parseFocusModeCommand("-s")).toEqual({ kind: "toggle", session: true });
	});

	test("is optional and never changes the parse without it", () => {
		expect(parseFocusModeCommand("set 100")).toEqual({ kind: "enable", width: 100 });
		expect(parseFocusModeCommand("bias -50")).toEqual({ kind: "setBias", bias: -50 });
	});

	test("is ignored by the read only verbs", () => {
		expect(parseFocusModeCommand("-s status")).toEqual({ kind: "status" });
		expect(parseFocusModeCommand("-s config")).toEqual({ kind: "config" });
		expect(parseFocusModeCommand("-s bias")).toEqual({ kind: "showBias" });
	});

	test("still reports bad input", () => {
		expect(parseFocusModeCommand("-s sideways")).toMatchObject({ error: expect.stringContaining("unknown option") });
	});
});
