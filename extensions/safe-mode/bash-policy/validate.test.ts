import { expect, test } from "bun:test";
import { analyzeBash } from "./analyze";
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

test("validateBashCommand: read-only chain with || true is auto-allowed", () => {
	const profiles = ["reader", "smart"] as const;
	for (const profile of profiles) {
		const decision = validateBashCommand({
			command: 'ls -la | rg -n "plan.md|PLAN.md" || true',
			profile,
		});
		expect(decision.action).toBe("allow");
		expect(decision.reasons[0]?.code).toBe("read-only-command");
	}
});

test("validateBashCommand: read-only file listing pipeline is auto-allowed", () => {
	const profiles = ["reader", "smart"] as const;
	for (const profile of profiles) {
		const decision = validateBashCommand({
			command: "pwd; find . -maxdepth 3 -type f | sed 's#^./##' | sort | head -300",
			profile,
		});
		expect(decision.action).toBe("allow");
		expect(decision.reasons[0]?.code).toBe("read-only-command");
	}
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

test("analyzeBash: parse + structure matrix", () => {
	const cases = [
		{
			name: "plain read-only",
			command: "ls -la",
			expects: {
				commandCount: 1,
				structure: { hasPipe: false, hasOtherControlFlow: false, isPlainCommand: true },
			},
		},
		{
			name: "pipeline",
			command: "ls | grep policy",
			expects: {
				commandCount: 2,
				structure: { hasPipe: true, hasOtherControlFlow: false, isPlainCommand: false },
			},
		},
		{
			name: "logical expression",
			command: "ls && pwd",
			expects: {
				commandCount: 2,
				structure: { hasPipe: false, hasOtherControlFlow: true, isPlainCommand: false },
			},
		},
		{
			name: "input redirection",
			command: "cat < README.md",
			expects: {
				commandCount: 1,
				structure: { hasInputRedirection: true, hasOutputRedirection: false, isPlainCommand: false },
			},
		},
		{
			name: "output redirection",
			command: "cat README.md > out.txt",
			expects: {
				commandCount: 1,
				structure: { hasInputRedirection: false, hasOutputRedirection: true, isPlainCommand: false },
			},
		},
		{
			name: "command substitution",
			command: "echo $(pwd)",
			expects: {
				commandCount: 2,
				structure: { hasSubstitution: true, isPlainCommand: false },
			},
		},
		{
			name: "empty",
			command: "",
			expects: { parseKind: "empty", commandCount: 0 },
		},
		{
			name: "line continuation",
			command: "echo \\",
			expects: { parseKind: "line-continuation", commandCount: 0 },
		},
		{
			name: "parse error",
			command: "'unterminated",
			expects: { parseKind: "parse-error", commandCount: 0 },
		},
	] as const;

	for (const entry of cases) {
		const analysis = analyzeBash(entry.command);
		expect(analysis.commandCount).toBe(entry.expects.commandCount);

		if (entry.expects.parseKind) {
			expect(analysis.parse.ok).toBe(false);
			if (!analysis.parse.ok) expect(analysis.parse.kind).toBe(entry.expects.parseKind);
			continue;
		}

		expect(analysis.parse.ok).toBe(true);
		const expectedStructure = entry.expects.structure ?? {};
		for (const [key, value] of Object.entries(expectedStructure)) {
			expect(analysis.structure[key as keyof typeof analysis.structure]).toBe(value);
		}
	}
});

test("analyzeBash: nested command substitutions are tracked", () => {
	const analysis = analyzeBash("echo $(pwd)");
	expect(analysis.parse.ok).toBe(true);
	expect(analysis.commandCount).toBe(2);
	expect(analysis.commands[0]?.program).toBe("echo");
	expect(analysis.commands[0]?.sourceKind).toBe("top-level");
	expect(analysis.commands[1]?.program).toBe("pwd");
	expect(analysis.commands[1]?.sourceKind).toBe("command-substitution");
	expect(analysis.structure.hasSubstitution).toBe(true);
});

test("validateBashCommand: matrix across command type, shell structure, and mode", () => {
	const structureCases = [
		{ name: "plain", build: (segment: string) => segment },
		{ name: "pipe", build: (segment: string) => `ls -la | ${segment}` },
		{ name: "&&", build: (segment: string) => `ls -la && ${segment}` },
		{ name: "||", build: (segment: string) => `ls -la || ${segment}` },
		{ name: ";", build: (segment: string) => `ls -la; ${segment}` },
		{ name: "newline", build: (segment: string) => `ls -la\n${segment}` },
	] as const;

	const commandTypeCases = [
		{ type: "read-only", command: "pwd", action: "allow", reasonCode: "read-only-command" },
		{ type: "write-like", command: "rm -rf tmp", action: "confirm", reasonCode: "write-command" },
		{ type: "unknown", command: "custom-tool arg1", action: "confirm", reasonCode: "unknown-command" },
	] as const;

	const profiles = ["reader", "smart"] as const;

	for (const profile of profiles) {
		for (const structureCase of structureCases) {
			for (const commandTypeCase of commandTypeCases) {
				const command = structureCase.build(commandTypeCase.command);
				const decision = validateBashCommand({ command, profile });
				expect(decision.action).toBe(commandTypeCase.action);
				expect(decision.reasons[0]?.code).toBe(commandTypeCase.reasonCode);
			}
		}
	}
});

test("validateBashCommand: sed safety coverage is conservative", () => {
	const profiles = ["reader", "smart"] as const;

	const unsafeWriteCapableSed = [
		"sed -i 's/a/b/' file",
		"sed -i.bak 's/a/b/' file",
		"sed --in-place 's/a/b/' file",
		"sed --in-place=.bak 's/a/b/' file",
		"git diff -- file | sed -i 's/a/b/'",
	] as const;

	for (const profile of profiles) {
		for (const command of unsafeWriteCapableSed) {
			const decision = validateBashCommand({ command, profile });
			expect(decision.action).toBe("confirm");
			expect(decision.reasons[0]?.code).not.toBe("read-only-command");
		}
	}

	const readIntentSed = ["sed -n '1,220p' file", "git diff -- file | sed -n '1,220p'"] as const;
	for (const profile of profiles) {
		for (const command of readIntentSed) {
			const decision = validateBashCommand({ command, profile });
			expect(decision.action).toBe("allow");
			expect(decision.reasons[0]?.code).toBe("read-only-command");
		}
	}

	const ambiguousDynamicSed = ["sed \"$EXPR\" file", "git diff -- file | sed -n \"$RANGE\""] as const;
	for (const profile of profiles) {
		for (const command of ambiguousDynamicSed) {
			const decision = validateBashCommand({ command, profile });
			expect(decision.action).toBe("confirm");
			expect(["command-substitution", "unknown-command"]).toContain(decision.reasons[0]?.code);
		}
	}
});
