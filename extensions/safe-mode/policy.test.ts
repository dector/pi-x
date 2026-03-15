import { expect, test } from "bun:test";
import {
	decideToolCall,
	describeToolCall,
	getBashCommandType,
	type BashCommandType,
	type SafeMode,
} from "./policy.ts";

const PROJECT_ROOT = "/tmp/pi-safe-mode-project";

type BashExpectation = Partial<BashCommandType>;

function expectBashType(command: string, expected: BashExpectation): void {
	const actual = getBashCommandType(command);
	for (const [key, value] of Object.entries(expected) as Array<[keyof BashCommandType, boolean]>) {
		if (actual[key] !== value) {
			throw new Error(`command=${JSON.stringify(command)} expected ${key}=${value}, got ${actual[key]}`);
		}
	}
}

function decide(
	mode: SafeMode,
	toolName: string,
	input: Record<string, unknown>,
	projectRoot = PROJECT_ROOT,
	outerAccess = false,
) {
	return decideToolCall({ mode, toolName, input, projectRoot, outerAccess });
}

test("getBashCommandType: empty/invalid input", () => {
	expectBashType("", { hasReads: false, hasWrites: false, isPlainCommand: false });
	expectBashType("   ", { hasReads: false, hasWrites: false, isPlainCommand: false });
	expectBashType("'unterminated", { isPlainCommand: false });
	expectBashType('"unterminated', { isPlainCommand: false });
	expectBashType(`grep foo ${"\\"}`, { isPlainCommand: false });
});

test("getBashCommandType: plain read-only commands", () => {
	const commands = [
		"ls -la",
		"pwd",
		"cd ..",
		"cat README.md",
		"head -n 20 README.md",
		"tail -n 5 README.md",
		"grep rm README.md",
		"rg safe-mode",
		"fd policy",
		"stat policy.ts",
		"file policy.ts",
		"wc -l policy.ts",
		"whoami",
		"id",
		"date",
		"uname -a",
		"uptime",
		"hostname",
		"env",
		"printenv PATH",
		"echo hello",
		"printf '%s\n' hello",
		"which ls",
		"type ls",
		"command -v ls",
		"realpath .",
		"readlink -f .",
		"basename /tmp/foo.txt",
		"dirname /tmp/foo.txt",
		"sort README.md",
		"uniq README.md",
		"cut -d: -f1 /etc/passwd",
		"tr a-z A-Z",
		"nl README.md",
		"find . -name \"*.ts\"",
	];

	for (const command of commands) {
		expectBashType(command, { hasReads: true, hasWrites: false, isPlainCommand: true });
	}
});

test("getBashCommandType: plain mutating commands", () => {
	const commands = [
		"rm -rf tmp",
		"mv a b",
		"cp a b",
		"mkdir -p out",
		"touch foo.txt",
		"chmod 644 foo.txt",
		"chown user:group foo.txt",
		"truncate -s 0 foo.txt",
		"sudo ls",
		"su",
	];

	for (const command of commands) {
		expectBashType(command, { hasReads: false, hasWrites: true, isPlainCommand: true });
	}
});

test("getBashCommandType: git classification", () => {
	const readOnly = [
		"git status",
		"git log --oneline",
		"git diff -- src/policy.ts",
		"git show HEAD~1",
		"git rev-parse HEAD",
		"git ls-files",
		"git ls-tree HEAD",
		"git cat-file -p HEAD^{tree}",
		"git grep safe-mode",
		"git blame policy.ts",
		"git rev-list --max-count=5 HEAD",
		"git shortlog",
		"git branch",
		"git branch --list",
	];

	for (const command of readOnly) {
		expectBashType(command, { hasReads: true, hasWrites: false, isPlainCommand: true });
	}

	const mutating = [
		"git branch -d feature/foo",
		"git branch --delete feature/foo",
		"git branch -m old new",
		"git branch -c old new",
		"git add .",
		"git commit -m \"x\"",
		"git push",
		"git checkout main",
	];

	for (const command of mutating) {
		expectBashType(command, { hasReads: false, hasWrites: true, isPlainCommand: true });
	}
});

test("getBashCommandType: package manager classification", () => {
	const writeCommands = [
		"npm install",
		"npm ci",
		"npm uninstall foo",
		"yarn add foo",
		"yarn remove foo",
		"pnpm add foo",
		"pnpm remove foo",
		"pip install requests",
		"pip uninstall requests",
		"bun install",
	];

	for (const command of writeCommands) {
		expectBashType(command, { hasReads: false, hasWrites: true, isPlainCommand: true });
	}

	expectBashType("bun test", { hasReads: false, hasWrites: false, isPlainCommand: true });
});

test("getBashCommandType: non-plain shell syntax detection", () => {
	const nonPlain = [
		"ls | grep policy",
		"ls && rm -rf tmp",
		"ls || pwd",
		"ls; pwd",
		"ls &",
		"ls\npwd",
		"echo $(pwd)",
		"echo `pwd`",
	];

	for (const command of nonPlain) {
		expectBashType(command, { isPlainCommand: false });
	}

	expectBashType("ls && rm -rf tmp", { hasReads: true, hasWrites: true });
	expectBashType("ls || pwd", { hasReads: true, hasWrites: false });
	expectBashType("cat a > b", { isPlainCommand: false, hasWrites: true });
	expectBashType("cat a >> b", { isPlainCommand: false, hasWrites: true });
	expectBashType("cat < a", { isPlainCommand: false, hasReads: true });
	expectBashType("cat <<EOF", { isPlainCommand: false, hasReads: true });
});

test("getBashCommandType: quoting/escaping correctness", () => {
	const shouldRemainPlain = [
		"grep \"a|b\" README.md",
		"grep \"a&&b\" README.md",
		"grep \"a;b\" README.md",
		"grep '$(pwd)' README.md",
		"grep '\\$(pwd)' README.md",
		"grep '\\`pwd\\`' README.md",
		"grep \\| README.md",
		"grep \\&\\& README.md",
		"grep \\; README.md",
	];

	for (const command of shouldRemainPlain) {
		expectBashType(command, { hasReads: true, hasWrites: false, isPlainCommand: true });
	}
});

test("getBashCommandType: env assignment + absolute path executable", () => {
	expectBashType("FOO=1 ls", { hasReads: true, hasWrites: false, isPlainCommand: true });
	expectBashType("A=1 B=2 grep foo README.md", { hasReads: true, hasWrites: false, isPlainCommand: true });
	expectBashType("/bin/ls -la", { hasReads: true, hasWrites: false, isPlainCommand: true });
	expectBashType("/usr/bin/find . -name \"*.ts\"", { hasReads: true, hasWrites: false, isPlainCommand: true });
	expectBashType("NODE_ENV=prod npm install", { hasReads: false, hasWrites: true, isPlainCommand: true });
});

test("getBashCommandType: find write-like flags", () => {
	expectBashType("find . -name '*.ts'", { hasReads: true, hasWrites: false, isPlainCommand: true });
	expectBashType("find . -exec rm {} \\;", { hasReads: false, hasWrites: true, isPlainCommand: true });
	expectBashType("find . -delete", { hasReads: false, hasWrites: true, isPlainCommand: true });
});

test("getBashCommandType: unknown commands", () => {
	expectBashType("python -c \"print(1)\"", { hasReads: false, hasWrites: false, isPlainCommand: true });
	expectBashType("node -e \"console.log(1)\"", { hasReads: false, hasWrites: false, isPlainCommand: true });
	expectBashType("custom-tool arg1 arg2", { hasReads: false, hasWrites: false, isPlainCommand: true });
	expectBashType("command rm -rf tmp", { hasReads: false, hasWrites: false, isPlainCommand: true });
	expectBashType("custom-tool | grep x", { isPlainCommand: false });
});

test("decideToolCall: reader mode integration", () => {
	expect(decide("reader", "read", { path: "policy.ts" }).action).toBe("allow");
	expect(decide("reader", "read", { path: "/tmp/outside.txt" }).action).toBe("confirm");
	expect(decide("reader", "read", { path: "/tmp/outside.txt" }, PROJECT_ROOT, true).action).toBe("allow");
	expect(decide("reader", "ls", { path: "." }).action).toBe("allow");
	expect(decide("reader", "grep", { path: "." }).action).toBe("allow");
	expect(decide("reader", "find", { path: "." }).action).toBe("confirm");

	expect(decide("reader", "bash", { command: "ls -la" }).action).toBe("allow");
	expect(decide("reader", "bash", { command: "cd .." }).action).toBe("confirm");
	expect(decide("reader", "bash", { command: "cd .." }, PROJECT_ROOT, true).action).toBe("allow");
	expect(decide("reader", "bash", { command: "grep rm README.md" }).action).toBe("allow");
	expect(decide("reader", "bash", { command: "git ls-files" }).action).toBe("allow");
	expect(decide("reader", "bash", { command: "git shortlog" }).action).toBe("allow");
	expect(decide("reader", "bash", { command: "command -v ls" }).action).toBe("allow");
	expect(decide("reader", "bash", { command: "bun test" }).action).toBe("confirm");
	expect(decide("reader", "bash", { command: "find . -name '*.ts'" }).action).toBe("allow");
	expect(decide("reader", "bash", { command: "find . -exec rm {} \\;" }).action).toBe("confirm");
	expect(decide("reader", "bash", { command: "cat a > b" }).action).toBe("confirm");
	expect(decide("reader", "bash", { command: "ls | grep src" }).action).toBe("allow");
	expect(decide("reader", "bash", { command: "ls && pwd" }).action).toBe("allow");
	expect(decide("reader", "bash", { command: "cd .. && ls" }).action).toBe("confirm");
	expect(decide("reader", "bash", { command: "cd .. && ls" }, PROJECT_ROOT, true).action).toBe("allow");
	expect(decide("reader", "bash", { command: "git log --oneline | head -n 20" }).action).toBe("allow");
	expect(decide("reader", "bash", { command: "cat /tmp/outside.txt" }).action).toBe("confirm");
	expect(decide("reader", "bash", { command: "cat /tmp/outside.txt" }, PROJECT_ROOT, true).action).toBe("allow");
	expect(decide("reader", "bash", { command: "ls | rm -rf tmp" }).action).toBe("confirm");
	expect(decide("reader", "bash", { command: "python -c 'print(1)'" }).action).toBe("confirm");
});

test("decideToolCall: smart mode integration", () => {
	expect(decide("smart", "read", { path: "policy.ts" }).action).toBe("allow");
	expect(decide("smart", "edit", { path: "policy.ts" }).action).toBe("allow");
	expect(decide("smart", "write", { path: "new-file.ts" }).action).toBe("allow");
	expect(decide("smart", "write", { path: "../outside.txt" }).action).toBe("confirm");
	expect(decide("smart", "write", { path: "../outside.txt" }, PROJECT_ROOT, true).action).toBe("confirm");
	expect(decide("smart", "edit", { path: "" }).action).toBe("confirm");
	expect(decide("smart", "bash", { command: "find . -name '*.ts'" }).action).toBe("allow");
	expect(decide("smart", "bash", { command: "find . -delete" }).action).toBe("confirm");
	expect(decide("smart", "bash", { command: "ls -la" }).action).toBe("allow");
	expect(decide("smart", "bash", { command: "ls | grep src" }).action).toBe("allow");
});

test("decideToolCall: paranoid/yolo sanity", () => {
	expect(decide("paranoid", "read", { path: "policy.ts" }).action).toBe("confirm");
	expect(decide("paranoid", "read", { path: "/tmp/outside.txt" }, PROJECT_ROOT, true).action).toBe("confirm");
	expect(decide("paranoid", "bash", { command: "ls" }).action).toBe("confirm");

	expect(decide("yolo", "read", { path: "policy.ts" }).action).toBe("allow");
	expect(decide("yolo", "read", { path: "/tmp/outside.txt" }).action).toBe("confirm");
	expect(decide("yolo", "read", { path: "/tmp/outside.txt" }, PROJECT_ROOT, true).action).toBe("allow");
	expect(decide("yolo", "bash", { command: "rm -rf /tmp/x" }).action).toBe("confirm");
	expect(decide("yolo", "bash", { command: "rm -rf /tmp/x" }, PROJECT_ROOT, true).action).toBe("allow");
});

test("path normalization + project-root boundaries", () => {
	const insideRelative = "./nested/file.ts";
	const insideAbsolute = `${PROJECT_ROOT}/nested/file.ts`;
	const outsideAbsolute = "/tmp/outside-file.ts";

	const atPathDecision = decide("smart", "write", { path: "@policy.ts" });
	expect(atPathDecision.action).toBe("allow");
	expect(atPathDecision.summary).toBe("write: policy.ts");
	expect(describeToolCall("read", { path: "@policy.ts" })).toBe("read: policy.ts");

	expect(decide("smart", "write", { path: insideRelative }).action).toBe("allow");
	expect(decide("smart", "write", { path: insideAbsolute }).action).toBe("allow");
	expect(decide("smart", "write", { path: outsideAbsolute }).action).toBe("confirm");
	expect(decide("smart", "write", { path: outsideAbsolute }, PROJECT_ROOT, true).action).toBe("confirm");
	expect(decide("smart", "edit", { path: "../escape.ts" }).action).toBe("confirm");
	expect(decide("smart", "edit", { path: "../escape.ts" }, PROJECT_ROOT, true).action).toBe("confirm");
});

test("regressions from regex-based behavior", () => {
	const commands = [
		"grep rm README.md",
		"grep \"sudo\" README.md",
		"grep \"git commit\" README.md",
		"grep \"a > b\" README.md",
		"grep \"x | y && z\" README.md",
	];

	for (const command of commands) {
		expectBashType(command, { hasReads: true, hasWrites: false, isPlainCommand: true });
	}

	expect(decide("reader", "bash", { command: "grep rm README.md" }).action).toBe("allow");
});
