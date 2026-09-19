import { expect, test } from "bun:test";
import { classifySqliteToolCall, isSqlitePermissionTool } from "./permissions.ts";

const PROJECT_ROOT = "/tmp/pi-sqlite-project";
const IN_REPO_DB = "data/app.db";
const OUTSIDE_DB = "/tmp/app.db";
const TRUSTED_ROOT = "/tmp/trusted-sqlite";

function decide(
	mode: string,
	input: Record<string, unknown>,
	options?: { projectRoot?: string; outerAccess?: boolean; trustedReadRoots?: string[] },
) {
	return classifySqliteToolCall({
		toolName: "sqlite",
		input,
		mode,
		projectRoot: options?.projectRoot ?? PROJECT_ROOT,
		outerAccess: options?.outerAccess,
		trustedReadRoots: options?.trustedReadRoots,
	})?.action;
}

test("isSqlitePermissionTool: only the sqlite tool", () => {
	expect(isSqlitePermissionTool("sqlite")).toBe(true);
	expect(isSqlitePermissionTool("bash")).toBe(false);
});

test("classifySqliteToolCall: ignores non-sqlite tools", () => {
	expect(
		classifySqliteToolCall({ toolName: "bash", input: {}, mode: "smart", projectRoot: PROJECT_ROOT }),
	).toBeUndefined();
});

test("classifySqliteToolCall: read-only in-repo queries auto-allow", () => {
	for (const mode of ["reader", "smart", "yolo"] as const) {
		expect(decide(mode, { action: "query", database: IN_REPO_DB, sql: "select 1" })).toBe("allow");
		expect(decide(mode, { action: "query", database: IN_REPO_DB, sql: "with x as (select 1) select * from x" })).toBe("allow");
		expect(decide(mode, { action: "query", database: IN_REPO_DB, sql: "pragma table_info(users)" })).toBe("allow");
		expect(decide(mode, { action: "query", memory: true, sql: "select 1" })).toBe("allow");
	}
});

test("classifySqliteToolCall: mutating queries require approval outside yolo", () => {
	for (const mode of ["reader", "smart"] as const) {
		expect(decide(mode, { action: "query", database: IN_REPO_DB, sql: "insert into t values (1)" })).toBe("confirm");
		expect(decide(mode, { action: "query", database: IN_REPO_DB, sql: "update t set x = 1" })).toBe("confirm");
		expect(decide(mode, { action: "query", database: IN_REPO_DB, sql: "pragma journal_mode = wal" })).toBe("confirm");
		expect(decide(mode, { action: "query", database: IN_REPO_DB, sql: "begin; select 1;" })).toBe("confirm");
		expect(decide(mode, { action: "query", memory: true, sql: "create table t(x int)" })).toBe("confirm");
	}
	expect(decide("yolo", { action: "query", database: IN_REPO_DB, sql: "update t set x = 1" })).toBe("allow");
});

test("classifySqliteToolCall: outside-project database", () => {
	expect(decide("reader", { action: "query", database: OUTSIDE_DB, sql: "select 1" })).toBe("confirm");
	expect(decide("reader", { action: "query", database: OUTSIDE_DB, sql: "select 1" }, { outerAccess: true })).toBe("allow");
	expect(decide("reader", { action: "query", database: OUTSIDE_DB, sql: "insert into t values (1)" }, { outerAccess: true })).toBe("confirm");

	expect(decide("yolo", { action: "query", database: OUTSIDE_DB, sql: "update t set x = 1" })).toBe("confirm");
	expect(decide("yolo", { action: "query", database: OUTSIDE_DB, sql: "update t set x = 1" }, { outerAccess: true })).toBe("allow");
});

test("classifySqliteToolCall: trusted read roots allow outside read-only queries", () => {
	const outsideRead = `${TRUSTED_ROOT}/shared.db`;
	expect(decide("reader", { action: "query", database: outsideRead, sql: "select 1" }, { trustedReadRoots: [TRUSTED_ROOT] })).toBe("allow");
	expect(decide("reader", { action: "query", database: outsideRead, sql: "delete from t" }, { trustedReadRoots: [TRUSTED_ROOT] })).toBe("confirm");
	expect(decide("reader", { action: "query", database: OUTSIDE_DB, sql: "select 1" }, { trustedReadRoots: [TRUSTED_ROOT] })).toBe("confirm");
});

test("classifySqliteToolCall: malformed input requires approval", () => {
	expect(decide("yolo", { action: "query", sql: "select 1" })).toBe("confirm");
	expect(decide("yolo", { action: "query", database: IN_REPO_DB, memory: true, sql: "select 1" })).toBe("confirm");
	expect(decide("yolo", { action: "query", database: IN_REPO_DB, sql: "   " })).toBe("confirm");
});

test("summarizeSqliteToolCall: used for hub perm:tool replies", async () => {
	const { summarizeSqliteToolCall } = await import("./sql.ts");
	expect(summarizeSqliteToolCall({ action: "query", memory: true, sql: "select 1" })).toBe(
		"sqlite: memory (read-only) — select 1",
	);
});
