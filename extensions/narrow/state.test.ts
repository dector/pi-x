import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlobalState, sanitizeState, saveGlobalState } from "./state";

describe("sanitizeState", () => {
	test("defaults to an enabled 100 column reading column", () => {
		expect(sanitizeState(undefined)).toEqual({ version: 1, enabled: true, width: 100, bias: 0 });
		expect(sanitizeState("nonsense")).toEqual({ version: 1, enabled: true, width: 100, bias: 0 });
	});

	test("keeps valid values", () => {
		expect(sanitizeState({ enabled: false, width: 120, bias: -50 })).toEqual({ version: 1, enabled: false, width: 120, bias: -50 });
	});

	test("repairs partial and out of range values", () => {
		expect(sanitizeState({ enabled: "yes", width: 4 })).toEqual({ version: 1, enabled: true, width: 20, bias: 0 });
		expect(sanitizeState({ enabled: false, width: 99999, bias: 999 })).toEqual({ version: 1, enabled: false, width: 2000, bias: 100 });
		expect(sanitizeState({ enabled: false, width: 90.7, bias: -12.6 })).toEqual({ version: 1, enabled: false, width: 90, bias: -13 });
	});
});

describe("persistence", () => {
	test("round-trips through disk", () => {
		const path = join(mkdtempSync(join(tmpdir(), "narrow-")), "state.json");
		expect(saveGlobalState({ version: 1, enabled: false, width: 96, bias: -25 }, path)).toEqual({ ok: true });
		expect(loadGlobalState(path)).toEqual({ state: { version: 1, enabled: false, width: 96, bias: -25 } });
	});

	test("falls back to defaults when the file is missing", () => {
		const path = join(mkdtempSync(join(tmpdir(), "narrow-")), "missing.json");
		expect(loadGlobalState(path)).toEqual({ state: { version: 1, enabled: true, width: 100, bias: 0 } });
	});

	test("reports unreadable files without throwing", () => {
		const path = join(mkdtempSync(join(tmpdir(), "narrow-")), "broken.json");
		writeFileSync(path, "{ not json", "utf-8");
		const result = loadGlobalState(path);
		expect(result.state).toEqual({ version: 1, enabled: true, width: 100, bias: 0 });
		expect(result.error).toContain(path);
	});
});
