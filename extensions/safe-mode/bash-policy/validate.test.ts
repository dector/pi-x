import { expect, test } from "bun:test";
import { validateBashCommand } from "./validate";

test("validateBashCommand: parse-error reason is structured", () => {
	const decision = validateBashCommand({ command: "'unterminated", profile: "reader" });
	expect(decision.action).toBe("confirm");
	expect(decision.reasons[0]?.code).toBe("parse-error");
	expect(decision.reasons[0]?.matcherId).toBe("structural/parse-error");
});

test("validateBashCommand: substitution requires confirmation", () => {
	const decision = validateBashCommand({ command: "echo $(pwd)", profile: "reader" });
	expect(decision.action).toBe("confirm");
	expect(decision.reasons[0]?.code).toBe("command-substitution");
});

test("validateBashCommand: find write-like flags require confirmation", () => {
	const decision = validateBashCommand({ command: "find . -delete", profile: "reader" });
	expect(decision.action).toBe("confirm");
	expect(decision.reasons[0]?.code).toBe("find-write-like-flag");
});

test("validateBashCommand: reader and smart profiles currently match", () => {
	const corpus = [
		"ls -la",
		"find . -name '*.ts'",
		"find . -delete",
		"bun test",
		"echo $(pwd)",
		"cat a > b",
	];

	for (const command of corpus) {
		const reader = validateBashCommand({ command, profile: "reader" });
		const smart = validateBashCommand({ command, profile: "smart" });
		expect(smart.action).toBe(reader.action);
		expect(smart.reasons[0]?.code).toBe(reader.reasons[0]?.code);
	}
});

test("validateBashCommand: fallback matcher handles unknown commands", () => {
	const decision = validateBashCommand({ command: "custom-tool arg1", profile: "reader" });
	expect(decision.action).toBe("confirm");
	expect(decision.reasons[0]?.code).toBe("unknown-command");
});
