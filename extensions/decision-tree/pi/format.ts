import { DecisionTreeServiceError } from "../core/service";
import { PersistenceError, ProjectNotInitializedError } from "../persistence/errors";

type ToolContent = { type: "text"; text: string };

export function okResult(message: string, details: Record<string, unknown>, options: { returnJson?: boolean } = {}): { content: ToolContent[]; details: Record<string, unknown> } {
	if (!options.returnJson) return { content: [], details: {} };
	return {
		content: [{ type: "text", text: `${message}\n${stableJson(details)}` }],
		details,
	};
}

export function errorResult(error: unknown, base?: Record<string, unknown>): { content: ToolContent[]; details: Record<string, unknown> } {
	const mapped = mapError(error);
	const details = { ok: false, ...base, ...mapped };
	return { content: [{ type: "text", text: `Decision tree error: ${mapped.message}` }], details };
}

export function shortId(id: string | null | undefined): string | null {
	return id ? id.slice(0, 8) : null;
}

export function stableJson(value: unknown): string {
	return JSON.stringify(value, null, "\t");
}

function mapError(error: unknown): { code: string; message: string; suggestion?: string } {
	if (error instanceof ProjectNotInitializedError) {
		return { code: error.code, message: `${error.message}. Run dt_init first.`, suggestion: "Run dt_init." };
	}
	if (error instanceof DecisionTreeServiceError) {
		if (error.code === "missing_active_tree") return { code: error.code, message: `${error.message}. Create or select a tree first.`, suggestion: "Run dt_create_tree or dt_select_tree." };
		if (error.code === "item_not_found") return { code: error.code, message: error.message, suggestion: "Check item_id or select another active item." };
		if (error.code === "tree_not_found" || error.code === "ambiguous_tree_id") return { code: error.code, message: error.message, suggestion: "Use dt_list_trees to find the full tree ID." };
		return { code: error.code, message: error.message };
	}
	if (error instanceof PersistenceError) return { code: error.code, message: error.message };
	if (error instanceof Error) return { code: "error", message: error.message };
	return { code: "error", message: String(error) };
}
