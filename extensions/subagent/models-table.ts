/**
 * Read-only "Subagent models" table.
 *
 * Shows the effective agent -> model assignment for the current session. The
 * resolution intentionally mirrors the dispatch path instead of re-deriving it:
 *
 *   - with session rewiring disabled, `resolveMappedModel` selects the same
 *     function/level cell and concrete alias target a dispatch would use;
 *   - with rewiring enabled, `resolveSubagentModel` supplies the fixed or
 *     inherited target, and an inherited parent model/effort is clamped by the
 *     injected `clampInheritedThinking` exactly as the child launch does.
 *
 * The table is a snapshot of the *current* effective configuration (mapping,
 * rewire state, and parent model). It is not a record of what already-running
 * or completed children actually used.
 *
 * The module stays runtime-free: the alias resolver and inherited-effort clamp
 * are injected, so the table can be unit tested without the Pi runtime.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	effectiveAgentLevel,
	resolveMappedModel,
	type AliasResolver,
	type ModelMapping,
	type SubagentFunction,
	type SubagentLevel,
} from "./model-mapping.ts";
import { isInheritAllRewire, isInheritedRewire, resolveSubagentModel } from "./rewire.ts";
import type { DispatchDefaults, SubagentRewireConfig } from "./types.ts";

export const MODELS_TABLE_TITLE = "Models table";
export const MODELS_TABLE_HELP = "↑↓ or j/k scroll • shift+j/k scroll 5 • esc close";
export const MODELS_TABLE_MAIN_AGENT = "main";
export const DEFAULT_MODELS_TABLE_VISIBLE = 16;

/** The subset of an agent profile the table needs to resolve a model. */
export interface AgentModelAgent {
	name: string;
	function?: SubagentFunction;
	level?: SubagentLevel;
	/** Legacy pin, ignored by the mapping resolver but passed through as-is. */
	model?: string;
	thinking?: ThinkingLevel;
}

export type AgentModelSource = "main" | "mapping" | "rewire" | "rewire-inherit-model" | "rewire-inherit-all";

export interface AgentModelRow {
	agent: string;
	/** Mapping rows always set this; the main-agent row leaves it undefined. */
	fn?: SubagentFunction;
	level?: SubagentLevel;
	source: AgentModelSource;
	alias?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	error?: string;
	warnings: string[];
}

export interface BuildModelsTableRowsInput {
	agents: readonly AgentModelAgent[];
	mapping: ModelMapping;
	/** Only passed when rewiring is enabled; otherwise the mapping applies. */
	rewire?: SubagentRewireConfig;
	/** Current parent model/effort, shown as the main row and used for inheritance. */
	parentDefaults: DispatchDefaults;
	resolveAlias: AliasResolver;
	/**
	 * Clamp an inherited (parent-derived) effort to the detected model. Injected
	 * because it needs the live model registry; mirrors the child launch hook.
	 */
	clampInheritedThinking?: (
		model: string | undefined,
		level: ThinkingLevel | undefined,
	) => ThinkingLevel | undefined;
}

/** The parent agent's current model, shown first so subagents have a baseline. */
export function mainAgentModelRow(parentDefaults: DispatchDefaults): AgentModelRow {
	return {
		agent: MODELS_TABLE_MAIN_AGENT,
		source: "main",
		...(parentDefaults.model ? { model: parentDefaults.model } : {}),
		...(parentDefaults.thinkingLevel ? { thinkingLevel: parentDefaults.thinkingLevel } : {}),
		warnings: [],
	};
}

/**
 * Resolve every agent to its effective model for the current session, with the
 * main-agent row first. Pure given the injected alias resolver and clamp.
 */
export function buildModelsTableRows(input: BuildModelsTableRowsInput): AgentModelRow[] {
	const rows: AgentModelRow[] = [mainAgentModelRow(input.parentDefaults)];
	for (const agent of input.agents) {
		const { level } = effectiveAgentLevel(input.mapping, agent);
		const fn = agent.function ?? "general";
		if (input.rewire?.enabled) {
			const inheritAll = isInheritAllRewire(input.rewire);
			const inherited = isInheritedRewire(input.rewire);
			const resolved = resolveSubagentModel(agent, input.parentDefaults, input.rewire, input.parentDefaults);
			let thinkingLevel = resolved.thinkingLevel;
			if (inherited && input.clampInheritedThinking) {
				thinkingLevel = input.clampInheritedThinking(resolved.model, thinkingLevel);
			}
			rows.push({
				agent: agent.name,
				fn,
				level,
				source: inheritAll ? "rewire-inherit-all" : inherited ? "rewire-inherit-model" : "rewire",
				...(resolved.model ? { model: resolved.model } : {}),
				...(thinkingLevel ? { thinkingLevel } : {}),
				warnings: [],
			});
			continue;
		}
		const resolution = resolveMappedModel(input.mapping, agent, undefined, input.resolveAlias);
		if (!resolution.ok) {
			rows.push({ agent: agent.name, fn, level, source: "mapping", error: resolution.error, warnings: resolution.warnings });
			continue;
		}
		rows.push({
			agent: agent.name,
			fn: resolution.function,
			level: resolution.level,
			source: "mapping",
			alias: resolution.alias,
			model: resolution.model,
			thinkingLevel: resolution.thinkingLevel,
			warnings: resolution.warnings,
		});
	}
	return rows;
}

/** One-line summary of where the current assignments come from. */
export function modelsModeLabel(rewire: SubagentRewireConfig | undefined, parentDefaults: DispatchDefaults): string {
	if (!rewire?.enabled) return "Function/level mapping";
	if (isInheritAllRewire(rewire)) {
		return `Inherit All · ${parentDefaults.model ?? "parent model"} · ${parentDefaults.thinkingLevel ?? "parent effort"}`;
	}
	if (isInheritedRewire(rewire)) {
		return `Inherit model · ${parentDefaults.model ?? "parent model"} · ${rewire.thinkingLevel}`;
	}
	return `Rewired · ${rewire.model} · ${rewire.thinkingLevel}`;
}

export function agentModelSourceLabel(source: AgentModelSource): string {
	switch (source) {
		case "main":
			return "main";
		case "mapping":
			return "mapping";
		case "rewire":
			return "rewired";
		case "rewire-inherit-model":
			return "inherit model";
		case "rewire-inherit-all":
			return "inherit all";
	}
}

interface ModelColumn {
	header: string;
	max: number;
	/** `0` is always shown; larger values are dropped first on narrow widths. */
	priority: number;
	flex?: boolean;
}

/**
 * Columns in display order. `Agent`, `Model`, and `Effort` are the read-only
 * core; `Source` and the mapping detail columns are added only when the width
 * leaves room, so the model stays readable at 80 columns.
 */
const COLUMNS: readonly ModelColumn[] = [
	{ header: "Agent", max: 22, priority: 0 },
	{ header: "Function", max: 10, priority: 2 },
	{ header: "Level", max: 6, priority: 2 },
	{ header: "Model", max: 40, priority: 0, flex: true },
	{ header: "Effort", max: 8, priority: 0 },
	{ header: "Source", max: 14, priority: 1 },
];
const COLUMN_GAP = 2;
const MIN_MODEL_WIDTH = 12;
const FLEX_INDEX = COLUMNS.findIndex((column) => column.flex);

/** Plain-text cells for one row, in `COLUMNS` order. */
export function modelsTableCells(row: AgentModelRow): string[] {
	return [
		row.agent,
		row.fn ?? "—",
		row.level ?? "—",
		row.error ? `! ${row.error}` : row.model ?? "(unresolved)",
		row.thinkingLevel ?? "—",
		agentModelSourceLabel(row.source),
	];
}

function naturalWidths(rows: readonly AgentModelRow[]): number[] {
	return COLUMNS.map((column, index) => {
		let max = column.header.length;
		for (const row of rows) max = Math.max(max, visibleWidth(modelsTableCells(row)[index] ?? ""));
		return Math.min(column.max, max);
	});
}

function includedColumns(natural: readonly number[], width: number): Set<number> {
	const usable = Math.max(1, width - 1); // one leading space
	const included = new Set<number>();
	COLUMNS.forEach((column, index) => {
		if (column.priority === 0) included.add(index);
	});
	const used = (): number =>
		[...included].reduce((sum, index) => sum + (index === FLEX_INDEX ? Math.max(MIN_MODEL_WIDTH, natural[index]!) : natural[index]!), 0) +
		COLUMN_GAP * Math.max(0, included.size - 1);
	let total = used();
	const optional = COLUMNS.map((column, index) => ({ column, index }))
		.filter(({ column, index }) => column.priority > 0 && !included.has(index))
		.sort((a, b) => a.column.priority - b.column.priority || a.index - b.index);
	for (const { column, index } of optional) {
		const extra = COLUMN_GAP + natural[index]!;
		if (total + extra <= usable) {
			included.add(index);
			total += extra;
		}
	}
	return included;
}

/** Column widths for the given terminal width; hidden columns report `0`. */
export function modelsTableColumnWidths(rows: readonly AgentModelRow[], width: number): number[] {
	const natural = naturalWidths(rows);
	const included = includedColumns(natural, width);
	const fixed = natural.reduce((sum, value, index) => {
		if (!included.has(index) || index === FLEX_INDEX) return sum;
		return sum + value;
	}, 0);
	const gaps = COLUMN_GAP * Math.max(0, included.size - 1);
	const modelRoom = Math.max(MIN_MODEL_WIDTH, width - 1 - fixed - gaps);
	return natural.map((value, index) => {
		if (!included.has(index)) return 0;
		if (index === FLEX_INDEX) return Math.max(MIN_MODEL_WIDTH, Math.min(natural[FLEX_INDEX]!, modelRoom));
		return value;
	});
}

function padCell(cell: string, cellWidth: number): string {
	const clipped = truncateToWidth(cell, cellWidth, "…");
	return clipped + " ".repeat(Math.max(0, cellWidth - visibleWidth(clipped)));
}

function visibleColumns(widths: readonly number[]): number[] {
	return COLUMNS.map((_column, index) => index).filter((index) => (widths[index] ?? 0) > 0);
}

export function formatModelsTableHeader(widths: readonly number[]): string {
	return visibleColumns(widths)
		.map((index) => padCell(COLUMNS[index]!.header, widths[index]!))
		.join("  ")
		.trimEnd();
}

export function formatModelsTableSeparator(widths: readonly number[]): string {
	return visibleColumns(widths)
		.map((index) => "─".repeat(Math.max(1, widths[index]!)))
		.join("  ");
}

function formatModelsTableRow(cells: readonly string[], widths: readonly number[]): string {
	return visibleColumns(widths)
		.map((index) => padCell(cells[index] ?? "", widths[index]!))
		.join("  ")
		.trimEnd();
}

/** Plain-text table lines used for previews and the non-TUI list fallback. */
export function formatModelsTableLines(rows: readonly AgentModelRow[], mode: string, width = 120): string[] {
	const widths = modelsTableColumnWidths(rows, width);
	const lines = [`Mode: ${mode}`, "", formatModelsTableHeader(widths), formatModelsTableSeparator(widths)];
	if (rows.length === 0) lines.push("(no agents found)");
	for (const row of rows) lines.push(formatModelsTableRow(modelsTableCells(row), widths));
	return lines;
}

export function formatModelsTableText(rows: readonly AgentModelRow[], mode: string, width = 120): string {
	return formatModelsTableLines(rows, mode, width).join("\n");
}

export type ModelsTableResult = { type: "close" };

export type ModelsTableNavigationKey = "tui.select.up" | "tui.select.down" | "tui.select.cancel" | "tui.select.confirm";

export interface ModelsTableTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export interface ModelsTableKeybindings {
	matches: (data: string, keybinding: ModelsTableNavigationKey) => boolean;
}

export interface ModelsTableViewOptions {
	rows: readonly AgentModelRow[];
	/** Summary of the active resolution mode, e.g. "Function/level mapping". */
	mode: string;
	theme: ModelsTableTheme;
	keybindings: ModelsTableKeybindings;
	requestRender: () => void;
	done: (result: ModelsTableResult) => void;
	maxVisible?: number;
}

/** Scrollable, read-only table. The only actions are scrolling and closing. */
export class ModelsTableView implements Component {
	private readonly options: ModelsTableViewOptions;
	private top = 0;

	constructor(options: ModelsTableViewOptions) {
		this.options = options;
	}

	invalidate(): void {
		// No cached render state; themed strings are built on every render.
	}

	handleInput(data: string): void {
		const keybindings = this.options.keybindings;
		if (
			keybindings.matches(data, "tui.select.cancel") ||
			keybindings.matches(data, "tui.select.confirm") ||
			data === "q" ||
			data === "Q"
		) {
			this.options.done({ type: "close" });
			return;
		}
		if (matchesKey(data, "shift+j")) {
			this.scroll(5);
			return;
		}
		if (matchesKey(data, "shift+k")) {
			this.scroll(-5);
			return;
		}
		if (data === "j" || data === "J" || keybindings.matches(data, "tui.select.down")) {
			this.scroll(1);
			return;
		}
		if (data === "k" || data === "K" || keybindings.matches(data, "tui.select.up")) {
			this.scroll(-1);
		}
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const { theme, rows, mode } = this.options;
		const border = truncateToWidth(theme.fg("dim", "─".repeat(w)), w);
		const lines = [
			border,
			"",
			truncateToWidth(` ${theme.fg("accent", theme.bold(MODELS_TABLE_TITLE))}`, w),
			truncateToWidth(` ${theme.fg("muted", mode)}`, w),
			"",
		];
		const widths = modelsTableColumnWidths(rows, w);
		lines.push(truncateToWidth(` ${theme.fg("dim", formatModelsTableHeader(widths))}`, w));
		lines.push(truncateToWidth(` ${theme.fg("dim", formatModelsTableSeparator(widths))}`, w));
		if (rows.length === 0) {
			lines.push(truncateToWidth(` ${theme.fg("muted", "No agents found.")}`, w));
		} else {
			const { start, end } = this.visibleRange(rows.length);
			for (let index = start; index < end; index += 1) {
				lines.push(truncateToWidth(` ${this.renderRow(rows[index]!, widths)}`, w));
			}
			if (start > 0 || end < rows.length) {
				lines.push(truncateToWidth(theme.fg("dim", `   ${start + 1}-${end} of ${rows.length}`), w));
			}
		}
		lines.push("", truncateToWidth(` ${theme.fg("dim", MODELS_TABLE_HELP)}`, w), "", border);
		return lines;
	}

	private renderRow(row: AgentModelRow, widths: readonly number[]): string {
		const { theme } = this.options;
		const cells = modelsTableCells(row).map((cell, index) => {
			if (index === 3) return theme.fg(row.error ? "error" : "accent", cell);
			if (index === 5) return theme.fg(row.source === "mapping" || row.source === "main" ? "muted" : "warning", cell);
			return cell;
		});
		return formatModelsTableRow(cells, widths);
	}

	private scroll(delta: number): void {
		const maxTop = Math.max(0, this.options.rows.length - this.visibleCount());
		this.top = Math.max(0, Math.min(this.top + delta, maxTop));
		this.options.requestRender();
	}

	private visibleCount(): number {
		return Math.max(1, this.options.maxVisible ?? DEFAULT_MODELS_TABLE_VISIBLE);
	}

	private visibleRange(count: number): { start: number; end: number } {
		const maxVisible = this.visibleCount();
		if (count <= maxVisible) return { start: 0, end: count };
		return { start: this.top, end: Math.min(count, this.top + maxVisible) };
	}
}
