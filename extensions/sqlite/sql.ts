export type SqliteQueryKind = "read-only" | "mutating";

export type SqliteScalar = string | number | boolean | null;

export type NormalizedSqliteTarget =
	| { kind: "memory" }
	| { kind: "file"; database: string };

export type NormalizedSqliteToolInput = {
	action: "query";
	target: NormalizedSqliteTarget;
	sql: string;
	params: SqliteScalar[];
	timeoutSec?: number;
};

export type SqliteToolInputNormalizationResult =
	| { ok: true; value: NormalizedSqliteToolInput }
	| { ok: false; error: string };

const SQLITE_MUTATING_KEYWORDS = new Set([
	"INSERT",
	"UPDATE",
	"DELETE",
	"REPLACE",
	"CREATE",
	"ALTER",
	"DROP",
	"VACUUM",
	"ATTACH",
	"DETACH",
	"BEGIN",
	"COMMIT",
	"ROLLBACK",
	"SAVEPOINT",
	"RELEASE",
	"END",
]);

const SQLITE_READ_ONLY_KEYWORDS = new Set(["SELECT", "EXPLAIN", "VALUES"]);

function normalizeToolPath(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const normalized = trimmed.replace(/^@+/, "");
	if (!normalized) return undefined;
	if (normalized.includes("\0") || normalized.includes("\n") || normalized.includes("\r")) return undefined;
	return normalized;
}

function normalizeSql(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	return trimmed;
}

function normalizeParams(raw: unknown): SqliteScalar[] | undefined {
	if (raw == null) return [];
	if (!Array.isArray(raw)) return undefined;

	const normalized: SqliteScalar[] = [];
	for (const value of raw) {
		if (
			typeof value === "string"
			|| typeof value === "number"
			|| typeof value === "boolean"
			|| value === null
		) {
			normalized.push(value);
			continue;
		}
		return undefined;
	}

	return normalized;
}

function normalizeTimeoutSec(raw: unknown): number | undefined {
	if (raw == null) return undefined;
	if (typeof raw !== "number") return undefined;
	if (!Number.isFinite(raw) || raw <= 0) return undefined;
	return Math.floor(raw);
}

export function normalizeSqliteToolInput(input: Record<string, unknown>): SqliteToolInputNormalizationResult {
	const action = input.action ?? "query";
	if (action !== "query") {
		return { ok: false, error: "sqlite: unsupported action (only 'query' is supported)." };
	}

	const database = normalizeToolPath(input.database);
	const memory = input.memory === true;

	if ((database ? 1 : 0) + (memory ? 1 : 0) !== 1) {
		return { ok: false, error: "sqlite: exactly one target is required: either 'database' or 'memory=true'." };
	}

	const sql = normalizeSql(input.sql);
	if (!sql) {
		return { ok: false, error: "sqlite: 'sql' is required and must be non-empty." };
	}

	const params = normalizeParams(input.params);
	if (!params) {
		return { ok: false, error: "sqlite: 'params' must be an array of string | number | boolean | null." };
	}

	const timeoutSec = normalizeTimeoutSec(input.timeoutSec);
	if (input.timeoutSec != null && timeoutSec == null) {
		return { ok: false, error: "sqlite: 'timeoutSec' must be a positive number when provided." };
	}

	return {
		ok: true,
		value: {
			action: "query",
			target: memory ? { kind: "memory" } : { kind: "file", database: database! },
			sql,
			params,
			timeoutSec,
		},
	};
}

function splitSqlStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = "";
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	let inBracket = false;
	let inLineComment = false;
	let inBlockComment = false;

	while (i < sql.length) {
		const char = sql[i]!;
		const next = sql[i + 1];

		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
				current += char;
			}
			i += 1;
			continue;
		}

		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				i += 2;
				continue;
			}
			i += 1;
			continue;
		}

		if (!inSingle && !inDouble && !inBracket && char === "-" && next === "-") {
			inLineComment = true;
			i += 2;
			continue;
		}

		if (!inSingle && !inDouble && !inBracket && char === "/" && next === "*") {
			inBlockComment = true;
			i += 2;
			continue;
		}

		if (!inDouble && !inBracket && char === "'") {
			if (inSingle && next === "'") {
				current += "''";
				i += 2;
				continue;
			}
			inSingle = !inSingle;
			current += char;
			i += 1;
			continue;
		}

		if (!inSingle && !inBracket && char === '"') {
			if (inDouble && next === '"') {
				current += '""';
				i += 2;
				continue;
			}
			inDouble = !inDouble;
			current += char;
			i += 1;
			continue;
		}

		if (!inSingle && !inDouble) {
			if (char === "[") inBracket = true;
			if (char === "]" && inBracket) inBracket = false;
		}

		if (!inSingle && !inDouble && !inBracket && char === ";") {
			const trimmed = current.trim();
			if (trimmed.length > 0) statements.push(trimmed);
			current = "";
			i += 1;
			continue;
		}

		current += char;
		i += 1;
	}

	const trailing = current.trim();
	if (trailing.length > 0) statements.push(trailing);
	return statements;
}

function firstKeyword(statement: string): string | undefined {
	const match = statement.match(/^\s*([A-Za-z_]+)/);
	return match ? match[1]!.toUpperCase() : undefined;
}

function isPragmaWrite(statement: string): boolean {
	return /^\s*PRAGMA\b[\s\S]*=/i.test(statement);
}

function classifySingleStatement(statement: string): SqliteQueryKind {
	const keyword = firstKeyword(statement);
	if (!keyword) return "mutating";

	if (keyword === "WITH") {
		if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|ATTACH|DETACH|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END)\b/i.test(statement)) {
			return "mutating";
		}
		if (/\b(SELECT|VALUES|EXPLAIN)\b/i.test(statement)) {
			return "read-only";
		}
		return "mutating";
	}

	if (keyword === "PRAGMA") {
		return isPragmaWrite(statement) ? "mutating" : "read-only";
	}

	if (SQLITE_READ_ONLY_KEYWORDS.has(keyword)) return "read-only";
	if (SQLITE_MUTATING_KEYWORDS.has(keyword)) return "mutating";
	return "mutating";
}

export function classifySqliteQuery(sql: string): {
	kind: SqliteQueryKind;
	statementKinds: SqliteQueryKind[];
} {
	const statements = splitSqlStatements(sql);
	if (statements.length === 0) {
		return { kind: "mutating", statementKinds: [] };
	}

	const statementKinds = statements.map((statement) => classifySingleStatement(statement));
	const kind = statementKinds.some((entry) => entry === "mutating") ? "mutating" : "read-only";
	return { kind, statementKinds };
}

function summarizeSqlSnippet(sql: string, maxLength = 100): string {
	const collapsed = sql.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function summarizeSqliteToolCall(input: Record<string, unknown>): string {
	const normalized = normalizeSqliteToolInput(input);
	if (!normalized.ok) return "sqlite";

	const targetSummary = normalized.value.target.kind === "memory"
		? "memory"
		: normalized.value.target.database;
	const classification = classifySqliteQuery(normalized.value.sql).kind;
	const sqlSnippet = summarizeSqlSnippet(normalized.value.sql);
	return `sqlite: ${targetSummary} (${classification}) — ${sqlSnippet}`;
}
