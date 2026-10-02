/** Visible worker events only. Never retain thinking blocks or raw RPC records. */
export interface WorkerActivity {
	kind: "text" | "tool" | "result" | "error";
	text: string;
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => block?.type === "text" && typeof block.text === "string" ? block.text : "").filter(Boolean).join("\n");
}

export function parseActivity(value: unknown): WorkerActivity | undefined {
	if (!value || typeof value !== "object") return;
	const event = value as Record<string, any>;
	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		if (update?.type === "text_delta" && typeof update.delta === "string") return { kind: "text", text: update.delta };
	}
	if (event.type === "tool_execution_start") {
		return { kind: "tool", text: `${event.toolName ?? "tool"} ${JSON.stringify(event.args ?? {})}` };
	}
	if (event.type === "tool_execution_end") {
		return { kind: event.isError ? "error" : "result", text: `${event.toolName ?? "tool"}: ${textContent(event.result) || "(no text result)"}` };
	}
	if (event.type === "message_end" && event.message?.role === "assistant" && event.message.errorMessage) {
		return { kind: "error", text: String(event.message.errorMessage) };
	}
	if (event.type === "response" && event.success === false) return { kind: "error", text: String(event.error ?? "RPC request failed") };
}

export const ACTIVITY_MAX_CHARS = 64 * 1024;
export const ACTIVITY_MAX_ENTRIES = 500;
export type ActivityState = "idle" | "running" | "completed" | "stopped" | "failed";
export interface ThreadActivity {
	state: ActivityState;
	entries: WorkerActivity[];
}

export function appendActivity(history: ThreadActivity, activity: WorkerActivity): void {
	const last = history.entries.at(-1);
	if (activity.kind === "text" && last?.kind === "text") last.text = (last.text + activity.text).slice(-ACTIVITY_MAX_CHARS);
	else history.entries.push({ ...activity, text: activity.text.slice(-ACTIVITY_MAX_CHARS) });
	let size = history.entries.reduce((sum, entry) => sum + entry.text.length, 0);
	while (history.entries.length > ACTIVITY_MAX_ENTRIES || size > ACTIVITY_MAX_CHARS) {
		size -= history.entries.shift()!.text.length;
	}
}
