import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendApprovalInvestigation } from "./investigation.ts";

let temporaryDirectory: string | undefined;

afterEach(async () => {
	if (!temporaryDirectory) return;
	await rm(temporaryDirectory, { recursive: true, force: true });
	temporaryDirectory = undefined;
});

describe("approval investigation log", () => {
	test("appends timestamped JSONL records to the requested path", async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "safe-mode-investigation-"));
		const filePath = join(temporaryDirectory, "nested", "investigations.jsonl");
		const first = {
			mode: "smart",
			outerAccess: false,
			toolName: "bash",
			command: "git status --short",
			cwd: "/work/project",
			userChoice: "deny",
		};

		await appendApprovalInvestigation(first, filePath);
		await appendApprovalInvestigation({ ...first, userChoice: "approve-once" }, filePath);

		const entries = (await readFile(filePath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject(first);
		expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(entries[1]).toMatchObject({ ...first, userChoice: "approve-once" });
	});
});
