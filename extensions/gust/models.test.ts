import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelAssignments } from "./models.ts";
import { sessionId } from "./worker.ts";

test("new threads inherit the latest chat model; old assignments survive restart and choice changes", () => {
	const dir = mkdtempSync(join(tmpdir(), "gust-models-"));
	try {
		let chat = { provider: "parent", id: "first" };
		let choice: typeof chat | undefined;
		const resolve = () => choice ?? chat;
		let store = new ModelAssignments(() => dir);
		expect(store.resolve("/repo", "old", resolve)).toEqual(chat);
		chat = { provider: "parent", id: "latest" };
		expect(store.resolve("/repo", "new", resolve)).toEqual(chat);
		choice = { provider: "picked", id: "explicit" };
		expect(store.resolve("/repo", "picked", resolve)).toEqual(choice);
		expect(store.resolve("/repo", "old", resolve)).toEqual({ provider: "parent", id: "first" });
		store = new ModelAssignments(() => dir);
		expect(store.resolve("/repo", "old", resolve)).toEqual({ provider: "parent", id: "first" });
		choice = undefined;
		expect(store.resolve("/repo", "inherit-again", resolve)).toEqual(chat);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy session keeps its own model; missing foreground model fails explicitly", () => {
	const dir = mkdtempSync(join(tmpdir(), "gust-models-"));
	try {
		writeFileSync(join(dir, `timestamp_${sessionId("/repo", "legacy")}.jsonl`), "{}");
		const store = new ModelAssignments(() => dir);
		expect(store.resolve("/repo", "legacy", () => ({ provider: "new", id: "ignored" }))).toBeUndefined();
		expect(() => store.resolve("/repo", "fresh", () => undefined)).toThrow("no foreground chat model");
		expect(store.resolve("/repo", "fresh", () => ({ provider: "ok", id: "model" }))).toEqual({ provider: "ok", id: "model" });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
