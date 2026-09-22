import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	addRewirePreset,
	deleteRewirePreset,
	formatRewirePreset,
	latestUsedRewirePreset,
	loadRewirePresets,
	markRewirePresetUsed,
	rewirePresetsPath,
	saveRewirePresets,
	type RewirePreset,
} from "./rewire-presets.ts";

const tempDirs: string[] = [];

function tempFile(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rewire-presets-"));
	tempDirs.push(directory);
	return path.join(directory, "nested", "presets.json");
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const first: RewirePreset = { model: "anthropic/claude", thinkingLevel: "high" };
const second: RewirePreset = { model: "openai/gpt", thinkingLevel: "medium" };

describe("rewire preset storage", () => {
	test("uses one global file under the agent directory", () => {
		expect(rewirePresetsPath("/tmp/agent")).toBe("/tmp/agent/subagent-rewire-presets.json");
	});

	test("missing files load as an empty list", () => {
		expect(loadRewirePresets(tempFile())).toEqual([]);
	});

	test("saves and reloads presets in order", () => {
		const file = tempFile();
		saveRewirePresets(file, [first, second]);
		expect(loadRewirePresets(file)).toEqual([first, second]);
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([first, second]);
	});

	test("drops malformed entries but rejects a malformed root", () => {
		const file = tempFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify([first, null, first, { model: "x", thinkingLevel: "turbo" }]));
		expect(loadRewirePresets(file)).toEqual([first]);
		fs.writeFileSync(file, JSON.stringify({ presets: [first] }));
		expect(() => loadRewirePresets(file)).toThrow("Expected a JSON array");
	});

	test("adds unique presets and deletes by index", () => {
		expect(addRewirePreset([first], first)).toEqual([first]);
		expect(addRewirePreset([first], second)).toEqual([first, second]);
		expect(deleteRewirePreset([first, second], 0)).toEqual([second]);
		expect(deleteRewirePreset([first], 9)).toEqual([first]);
	});

	test("marks only the latest applied preset and persists that marker", () => {
		const marked = markRewirePresetUsed([{ ...first, lastUsed: true }, second], second);
		expect(marked).toEqual([first, { ...second, lastUsed: true }]);
		expect(latestUsedRewirePreset(marked)).toEqual({ ...second, lastUsed: true });

		const file = tempFile();
		saveRewirePresets(file, marked);
		expect(latestUsedRewirePreset(loadRewirePresets(file))).toEqual({ ...second, lastUsed: true });
		expect(markRewirePresetUsed(marked, { model: "missing/model", thinkingLevel: "off" })).toEqual(marked);
	});

	test("normalizes multiple hand-edited latest markers to the last one", () => {
		const file = tempFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify([{ ...first, lastUsed: true }, { ...second, lastUsed: true }]));
		const loaded = loadRewirePresets(file);
		expect(loaded).toEqual([first, { ...second, lastUsed: true }]);
		expect(latestUsedRewirePreset(loaded)).toEqual({ ...second, lastUsed: true });
	});

	test("formats a compact model and effort label", () => {
		expect(formatRewirePreset(first)).toBe("anthropic/claude · high");
	});
});
