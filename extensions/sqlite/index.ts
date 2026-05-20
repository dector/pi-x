import { StringEnum, Type } from "@mariozechner/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { classifySqliteQuery, normalizeSqliteToolInput, summarizeSqliteToolCall, type SqliteScalar } from "./sql";

const SQLITE_ACTIONS = ["query"] as const;
const DEFAULT_TIMEOUT_SEC = 15;

type SqliteToolParams = {
	action?: "query";
	database?: string;
	memory?: boolean;
	sql: string;
	params?: SqliteScalar[];
	timeoutSec?: number;
};

const SqliteToolParamsSchema = Type.Object({
	action: Type.Optional(
		StringEnum(SQLITE_ACTIONS, {
			description: "Sub-tool to run. Currently only 'query'.",
		}),
	),
	database: Type.Optional(Type.String({ description: "SQLite database file path." })),
	memory: Type.Optional(Type.Boolean({ description: "Use in-memory sqlite database (:memory:)." })),
	sql: Type.String({ description: "SQL statement or script to execute." }),
	params: Type.Optional(
		Type.Array(Type.Any({ description: "Positional bind values for ?1, ?2, ... placeholders." })),
	),
	timeoutSec: Type.Optional(Type.Number({ description: "Query timeout in seconds." })),
});

function toSqliteParameterLiteral(value: SqliteScalar): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "1" : "0";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("sqlite: parameter numbers must be finite.");
		return String(value);
	}
	return `'${value.replace(/'/g, "''")}'`;
}

function truncateOutput(content: string): { text: string; truncation?: TruncationResult } {
	const truncation = truncateHead(content, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});

	if (!truncation.truncated) return { text: truncation.content };

	let text = truncation.content;
	text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
	return { text, truncation };
}

export default function sqliteExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sqlite",
		label: "SQLite",
		description: "Run SQLite queries against a file-backed DB or :memory:.",
		promptSnippet: "Use sqlite for safe SQLite exploration and querying.",
		parameters: SqliteToolParamsSchema,
		renderCall(args, theme) {
			const summary = summarizeSqliteToolCall(args as Record<string, unknown>);
			let text = theme.fg("toolTitle", `${theme.bold("sqlite")} `);
			if (summary.startsWith("sqlite: ")) {
				text += theme.fg("muted", summary.slice("sqlite: ".length));
			}
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as SqliteToolParams;
			const normalized = normalizeSqliteToolInput(input as unknown as Record<string, unknown>);
			if (!normalized.ok) {
				throw new Error(normalized.error);
			}

			const sqlInfo = classifySqliteQuery(normalized.value.sql);
			const timeoutSec = normalized.value.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
			const timeoutMs = Math.max(1000, timeoutSec * 1000);
			const databaseTarget = normalized.value.target.kind === "memory"
				? ":memory:"
				: resolve(ctx.cwd, normalized.value.target.database);

			const sqliteArgs: string[] = ["-json"];
			if (sqlInfo.kind === "read-only") {
				sqliteArgs.push("-readonly");
			}
			sqliteArgs.push(databaseTarget);
			sqliteArgs.push(`.timeout ${timeoutMs}`);

			if (normalized.value.params.length > 0) {
				sqliteArgs.push(".parameter init");
				normalized.value.params.forEach((value, index) => {
					sqliteArgs.push(`.parameter set ?${index + 1} ${toSqliteParameterLiteral(value)}`);
				});
			}

			sqliteArgs.push(normalized.value.sql);

			const result = await pi.exec("sqlite3", sqliteArgs, {
				cwd: ctx.cwd,
				signal,
				timeout: timeoutMs,
			});

			const stdout = (result.stdout ?? "").trim();
			const stderr = (result.stderr ?? "").trim();
			const exitCode = result.code ?? 1;
			const ok = exitCode === 0;

			const contentText = ok
				? (stdout || (sqlInfo.kind === "read-only" ? "(no rows)" : "OK"))
				: (stderr || stdout || `sqlite3 failed with exit code ${exitCode}`);

			const truncated = truncateOutput(contentText);
			return {
				content: [{ type: "text" as const, text: truncated.text }],
				details: {
					ok,
					action: "query",
					queryKind: sqlInfo.kind,
					statementKinds: sqlInfo.statementKinds,
					target: normalized.value.target,
					databaseTarget,
					command: `sqlite3 ${sqlInfo.kind === "read-only" ? "-readonly " : ""}${databaseTarget}`,
					timeoutSec,
					exitCode,
					stdout,
					stderr,
					truncation: truncated.truncation,
				},
			};
		},
	});
}
