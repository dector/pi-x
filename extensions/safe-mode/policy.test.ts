import { expect, test } from "bun:test";
import {
	classifyGitToolCall,
	decideToolCall,
	describeToolCall,
	getBashCommandType,
	normalizeGitToolArgs,
	type BashCommandType,
	type SafeMode,
	classifySqliteQueryForPolicy,
} from "./policy.ts";

const PROJECT_ROOT = "/tmp/pi-safe-mode-project";
const PI_PACKAGE_ROOT = "/opt/pi-coding-agent";
const TRUSTED_PI_DOC_ROOTS = [
	`${PI_PACKAGE_ROOT}/README.md`,
	`${PI_PACKAGE_ROOT}/docs`,
	`${PI_PACKAGE_ROOT}/examples`,
];
const SKILL_ROOT = "/home/user/.pi/agent/skills/askme";
const SKILL_FILE = `${SKILL_ROOT}/SKILL.md`;

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
	trustedReadRoots?: string[],
) {
	return decideToolCall({ mode, toolName, input, projectRoot, outerAccess, trustedReadRoots });
}

test("git classifier: normalize + classify", () => {
	expect(normalizeGitToolArgs({})).toEqual([]);
	expect(normalizeGitToolArgs({ args: [" status "] })).toEqual(["status"]);
	expect(normalizeGitToolArgs({ args: "status" })).toBeUndefined();
	expect(normalizeGitToolArgs({ args: ["status", ""] })).toBeUndefined();
	expect(normalizeGitToolArgs({ args: ["status\nlog"] })).toBeUndefined();

	expect(classifyGitToolCall({ args: ["status"] })).toEqual({
		recognized: true,
		readOnly: true,
		subtool: "status",
		summary: "git: status (read-only)",
	});
	expect(classifyGitToolCall({ args: ["branch", "-d", "topic"] }).readOnly).toBe(false);
	expect(classifyGitToolCall({ args: ["push"] }).recognized).toBe(false);
	expect(classifyGitToolCall({ args: "status" }).recognized).toBe(false);
});

test("decideToolCall: git read-only auto-allow matrix", () => {
	const readOnlyCases: string[][] = [
		["status"],
		["log", "--oneline", "-n", "20"],
		["diff", "--", "src/policy.ts"],
		["show", "HEAD~1"],
		["blame", "policy.ts"],
		["grep", "safe-mode"],
		["shortlog"],
		["rev-parse", "HEAD"],
		["rev-list", "--max-count=5", "HEAD"],
		["merge-base", "HEAD", "origin/main"],
		["describe", "--tags"],
		["name-rev", "HEAD"],
		["symbolic-ref", "HEAD"],
		["show-ref"],
		["for-each-ref", "--format=%(refname)"],
		["ls-files"],
		["ls-tree", "HEAD"],
		["cat-file", "-p", "HEAD^{tree}"],
		["check-ignore", "README.md"],
		["branch", "--list", "feature/*"],
		["tag", "--list", "v*"],
		["remote", "-v"],
		["reflog", "show", "HEAD"],
		["config", "--list", "--show-origin"],
		["count-objects"],
		["fsck"],
		["verify-commit", "HEAD"],
		["verify-tag", "v1.0.0"],
	];

	for (const argv of readOnlyCases) {
		expect(decide("reader", "git", { args: argv }).action).toBe("allow");
		expect(decide("smart", "git", { args: argv }).action).toBe("allow");
		expect(decide("yolo", "git", { args: argv }).action).toBe("allow");
		expect(decide("paranoid", "git", { args: argv }).action).toBe("confirm");
	}
});

test("decideToolCall: git malformed/unknown/non-read-only requires confirm", () => {
	const confirmCases: Array<Record<string, unknown>> = [
		{ args: ["push"] },
		{ args: ["commit", "-m", "msg"] },
		{ args: ["branch", "topic"] },
		{ args: ["branch", "-d", "topic"] },
		{ args: ["tag", "v1.2.3"] },
		{ args: ["remote", "add", "origin", "https://example.com/repo.git"] },
		{ args: ["config", "user.name"] },
		{ args: ["diff", "--output=patch.diff"] },
		{ args: "status" },
		{ args: ["status", ""] },
		{ args: ["--version"] },
	];

	for (const input of confirmCases) {
		expect(decide("reader", "git", input).action).toBe("confirm");
		expect(decide("smart", "git", input).action).toBe("confirm");
	}
	for (const input of confirmCases) {
		expect(decide("yolo", "git", input).action).toBe("allow");
	}
});

test("sqlite classifier: read-only vs mutating", () => {
	expect(classifySqliteQueryForPolicy("select * from users")).toBe("read-only");
	expect(classifySqliteQueryForPolicy("with x as (select 1) select * from x")).toBe("read-only");
	expect(classifySqliteQueryForPolicy("pragma table_info(users)")).toBe("read-only");
	expect(classifySqliteQueryForPolicy("explain query plan select 1")).toBe("read-only");
	expect(classifySqliteQueryForPolicy("values (1), (2)")).toBe("read-only");

	expect(classifySqliteQueryForPolicy("insert into users(name) values ('a')")).toBe("mutating");
	expect(classifySqliteQueryForPolicy("pragma journal_mode = wal")).toBe("mutating");
	expect(classifySqliteQueryForPolicy("begin; select 1;")).toBe("mutating");
	expect(classifySqliteQueryForPolicy("select 1; update users set name = 'x';")).toBe("mutating");
	expect(classifySqliteQueryForPolicy("-- comment\nselect 1")).toBe("read-only");
});

test("decideToolCall: sqlite safe-mode matrix", () => {
	const inRepoDb = "data/app.db";
	const outsideDb = "/tmp/app.db";

	expect(decide("reader", "sqlite", { action: "query", database: inRepoDb, sql: "select 1" }).action).toBe("allow");
	expect(decide("reader", "sqlite", { action: "query", database: inRepoDb, sql: "insert into t values (1)" }).action).toBe("confirm");

	expect(decide("smart", "sqlite", { action: "query", database: inRepoDb, sql: "select 1" }).action).toBe("allow");
	expect(decide("smart", "sqlite", { action: "query", database: inRepoDb, sql: "update t set x = 1" }).action).toBe("confirm");

	expect(decide("reader", "sqlite", { action: "query", database: outsideDb, sql: "select 1" }).action).toBe("confirm");
	expect(decide("reader", "sqlite", { action: "query", database: outsideDb, sql: "select 1" }, PROJECT_ROOT, true).action).toBe("allow");
	expect(decide("reader", "sqlite", { action: "query", database: outsideDb, sql: "insert into t values (1)" }, PROJECT_ROOT, true).action).toBe("confirm");

	expect(decide("yolo", "sqlite", { action: "query", database: outsideDb, sql: "update t set x = 1" }).action).toBe("confirm");
	expect(decide("yolo", "sqlite", { action: "query", database: outsideDb, sql: "update t set x = 1" }, PROJECT_ROOT, true).action).toBe("allow");

	expect(decide("reader", "sqlite", { action: "query", memory: true, sql: "select 1" }).action).toBe("allow");
	expect(decide("reader", "sqlite", { action: "query", memory: true, sql: "create table t(x int)" }).action).toBe("confirm");

	expect(describeToolCall("sqlite", { action: "query", memory: true, sql: "select 1" })).toBe("sqlite: memory (read-only) — select 1");
});

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
	expect(decide("reader", "commit", { files: ["a.ts"], message: "feat: add a" }).action).toBe("confirm");

	expect(decide("reader", "bash", { command: "ls -la" }).action).toBe("allow");
	expect(decide("reader", "bash", { command: "cd .." }).action).toBe("confirm");
	expect(decide("reader", "bash", { command: "cd .." }, PROJECT_ROOT, true).action).toBe("allow");
	expect(decide("reader", "bash", { command: "grep rm README.md" }).action).toBe("allow");
	expect(decide("reader", "bash", { command: "nl README.md" }).action).toBe("allow");
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

test("decideToolCall: http and memoryfs safe-mode matrix", () => {
	expect(decide("paranoid", "http", { url: "https://example.com" }).action).toBe("confirm");
	expect(decide("paranoid", "http_md", { url: "https://example.com" }).action).toBe("confirm");
	expect(decide("paranoid", "read_memoryfs", { id: "mem-1" }).action).toBe("confirm");

	for (const mode of ["reader", "smart", "yolo"] as const) {
		expect(decide(mode, "http", { url: "https://example.com" }).action).toBe("allow");
		expect(decide(mode, "http", { url: "https://example.com", method: "GET" }).action).toBe("allow");
		expect(decide(mode, "http", { url: "https://example.com", method: "head" }).action).toBe("allow");
		expect(decide(mode, "http", { url: "https://example.com", method: "OPTIONS" }).action).toBe("allow");
		expect(decide(mode, "http_md", { url: "https://example.com", method: "GET" }).action).toBe("allow");
		expect(decide(mode, "read_memoryfs", { id: "mem-1" }).action).toBe("allow");
	}

	for (const mode of ["reader", "smart"] as const) {
		expect(decide(mode, "http", { url: "https://example.com", method: "POST" }).action).toBe("confirm");
		expect(decide(mode, "http_md", { url: "https://example.com", method: "DELETE" }).action).toBe("confirm");
		expect(decide(mode, "http_md", { url: "https://example.com", spillMode: "to_file" }).action).toBe("confirm");
		expect(decide(mode, "http", { url: "https://example.com", outputFile: "download.txt" }).action).toBe("confirm");
		expect(decide(mode, "http", { curlArgs: ["-X", "POST", "https://example.com"] }).action).toBe("confirm");
		expect(decide(mode, "http", { curlArgs: ["-d", "name=value", "https://example.com"] }).action).toBe("confirm");
		expect(decide(mode, "http", { curlArgs: ["-o", "download.txt", "https://example.com"] }).action).toBe("confirm");
		expect(decide(mode, "http", { curlArgs: ["--output=/tmp/download.txt", "https://example.com"] }).action).toBe("confirm");
	}

	expect(decide("yolo", "http", { url: "https://example.com", method: "POST" }).action).toBe("allow");
	expect(decide("yolo", "http", { url: "https://example.com", outputFile: "download.txt" }).action).toBe("allow");
	expect(decide("yolo", "http", { url: "https://example.com", outputFile: "/tmp/download.txt" }).action).toBe("confirm");
	expect(decide("yolo", "http", { url: "https://example.com", outputFile: "/tmp/download.txt" }, PROJECT_ROOT, true).action).toBe("confirm");
	expect(decide("yolo", "http", { curlArgs: ["-o", "/tmp/download.txt", "https://example.com"] }, PROJECT_ROOT, true).action).toBe("confirm");
	expect(decide("yolo", "http_md", { url: "https://example.com", spillMode: "to_file" }).action).toBe("confirm");
});

test("decideToolCall: smart mode integration", () => {
	expect(decide("smart", "read", { path: "policy.ts" }).action).toBe("allow");
	expect(decide("smart", "edit", { path: "policy.ts" }).action).toBe("allow");
	expect(decide("smart", "write", { path: "new-file.ts" }).action).toBe("allow");
	expect(decide("smart", "write", { path: "../outside.txt" }).action).toBe("confirm");
	expect(decide("smart", "write", { path: "../outside.txt" }, PROJECT_ROOT, true).action).toBe("confirm");
	expect(decide("smart", "edit", { path: "" }).action).toBe("confirm");
	expect(decide("smart", "commit", { files: ["a.ts"], message: "feat: add a" }).action).toBe("confirm");
	expect(decide("smart", "bash", { command: "find . -name '*.ts'" }).action).toBe("allow");
	expect(decide("smart", "bash", { command: "find . -delete" }).action).toBe("confirm");
	expect(decide("smart", "bash", { command: "ls -la" }).action).toBe("allow");
	expect(decide("smart", "bash", { command: "nl README.md" }).action).toBe("allow");
	expect(decide("smart", "bash", { command: "ls | grep src" }).action).toBe("allow");
});

test("decideToolCall: trusted read roots outside project", () => {
	const docsFile = `${PI_PACKAGE_ROOT}/docs/extensions.md`;
	const readmeFile = `${PI_PACKAGE_ROOT}/README.md`;
	const skillReferenceFile = `${SKILL_ROOT}/references/foo.md`;
	const outsideFile = "/tmp/outside.txt";
	const trustedReadRoots = [...TRUSTED_PI_DOC_ROOTS, SKILL_ROOT];

	expect(decide("reader", "read", { path: docsFile }).action).toBe("confirm");
	expect(decide("reader", "read", { path: docsFile }, PROJECT_ROOT, false, trustedReadRoots).action).toBe("allow");
	expect(decide("smart", "read", { path: readmeFile }, PROJECT_ROOT, false, trustedReadRoots).action).toBe("allow");

	expect(decide("reader", "read", { path: SKILL_FILE }, PROJECT_ROOT, false, [SKILL_ROOT]).action).toBe("allow");
	expect(decide("smart", "read", { path: SKILL_FILE }, PROJECT_ROOT, false, [SKILL_ROOT]).action).toBe("allow");
	expect(decide("paranoid", "read", { path: SKILL_FILE }, PROJECT_ROOT, false, [SKILL_ROOT]).action).toBe("confirm");
	expect(decide("reader", "read", { path: skillReferenceFile }, PROJECT_ROOT, false, [SKILL_ROOT]).action).toBe("allow");

	expect(decide("reader", "read", { path: outsideFile }, PROJECT_ROOT, false, trustedReadRoots).action).toBe("confirm");
	expect(decide("smart", "write", { path: SKILL_FILE }, PROJECT_ROOT, false, [SKILL_ROOT]).action).toBe("confirm");

	expect(
		decide("reader", "bash", { command: `cat ${docsFile}` }, PROJECT_ROOT, false, trustedReadRoots).action,
	).toBe("allow");
	expect(
		decide("reader", "bash", { command: `cat ${SKILL_FILE}` }, PROJECT_ROOT, false, [SKILL_ROOT]).action,
	).toBe("allow");
	expect(
		decide("reader", "bash", { command: `cat ${SKILL_FILE} ${outsideFile}` }, PROJECT_ROOT, false, [SKILL_ROOT])
			.action,
	).toBe("confirm");
	expect(
		decide("reader", "bash", { command: `cat ${outsideFile}` }, PROJECT_ROOT, false, trustedReadRoots).action,
	).toBe("confirm");
});

test("decideToolCall: bash target-scope matrix (inside vs outside)", () => {
	const cases = [
		{ mode: "reader", outerAccess: false, command: "cat README.md", expected: "allow" },
		{ mode: "reader", outerAccess: false, command: "cat /tmp/outside.txt", expected: "confirm" },
		{ mode: "reader", outerAccess: true, command: "cat /tmp/outside.txt", expected: "allow" },
		{ mode: "smart", outerAccess: false, command: "cat README.md", expected: "allow" },
		{ mode: "smart", outerAccess: false, command: "cat /tmp/outside.txt", expected: "confirm" },
		{ mode: "smart", outerAccess: true, command: "cat /tmp/outside.txt", expected: "allow" },
		{ mode: "reader", outerAccess: false, command: "cat README.md | head -n 5", expected: "allow" },
		{ mode: "reader", outerAccess: false, command: "cat /tmp/outside.txt | head -n 5", expected: "confirm" },
		{ mode: "reader", outerAccess: true, command: "cat /tmp/outside.txt | head -n 5", expected: "allow" },
	] as const;

	for (const testCase of cases) {
		const decision = decide(testCase.mode, "bash", { command: testCase.command }, PROJECT_ROOT, testCase.outerAccess);
		expect(decision.action).toBe(testCase.expected);
	}
});

test("decideToolCall: paranoid/yolo sanity", () => {
	expect(decide("paranoid", "read", { path: "policy.ts" }).action).toBe("confirm");
	expect(decide("paranoid", "read", { path: "/tmp/outside.txt" }, PROJECT_ROOT, true).action).toBe("confirm");
	expect(decide("paranoid", "bash", { command: "ls" }).action).toBe("confirm");
	expect(decide("paranoid", "commit", { files: ["a.ts"], message: "feat: add a" }).action).toBe("confirm");

	expect(decide("yolo", "read", { path: "policy.ts" }).action).toBe("allow");
	expect(decide("yolo", "read", { path: "/tmp/outside.txt" }).action).toBe("confirm");
	expect(decide("yolo", "read", { path: "/tmp/outside.txt" }, PROJECT_ROOT, true).action).toBe("allow");
	expect(decide("yolo", "commit", { files: ["a.ts"], message: "feat: add a" }).action).toBe("allow");
	expect(decide("yolo", "commit", { files: ["../outside.ts"], message: "feat: outside" }).action).toBe("confirm");
	expect(
		decide("yolo", "commit", { files: ["../outside.ts"], message: "feat: outside" }, PROJECT_ROOT, true).action,
	).toBe("allow");
	expect(decide("yolo", "bash", { command: "rm -rf /tmp/x" }).action).toBe("confirm");
	expect(decide("yolo", "bash", { command: "rm -rf /tmp/x" }, PROJECT_ROOT, true).action).toBe("allow");
});

test("describeToolCall: git summaries", () => {
	expect(describeToolCall("git", {})).toBe("git");
	expect(describeToolCall("git", { args: ["status"] })).toBe("git: status");
	expect(describeToolCall("git", { args: ["log", "--oneline", "-n", "20"] })).toBe("git: log --oneline -n 20");
	expect(describeToolCall("git", { args: ["branch", "--list"] })).toBe("git: branch --list");
});

test("describeToolCall: commit summary", () => {
	expect(describeToolCall("commit", { files: ["a.ts", "b.ts"], message: "feat: add commit tool" })).toBe(
		'commit: 2 files "feat: add commit tool"',
	);
	expect(describeToolCall("commit", { files: ["a.ts", "a.ts"], message: "" })).toBe(
		'commit: 1 files "(empty message)"',
	);
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
