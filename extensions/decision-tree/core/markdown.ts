import type { Note, TreeDoc, TreeItem } from "./types";

export function treeAsMarkdown(tree: TreeDoc, options: { include_deleted_notes?: boolean } = {}): string {
	const lines: string[] = [];
	lines.push(header(1, tree.title));
	appendItemChildren(lines, tree.root.children, 2, options.include_deleted_notes === true);
	return lines.join("\n").trimEnd() + "\n";
}

function appendItemChildren(lines: string[], items: TreeItem[], level: number, includeDeletedNotes: boolean): void {
	for (const item of items) appendItem(lines, item, level, includeDeletedNotes);
}

function appendItem(lines: string[], item: TreeItem, level: number, includeDeletedNotes: boolean): void {
	lines.push("", header(level, itemHeading(item)));
	if (item.type === "decision") {
		lines.push("", `Q: ${singleLine(item.question)}`);
		lines.push(`A: ${item.answer ? singleLine(item.answer) : ""}`);
		appendNotes(lines, item.notes, includeDeletedNotes);
	}
	appendItemChildren(lines, item.children, level + 1, includeDeletedNotes);
}

function appendNotes(lines: string[], notes: Note[], includeDeletedNotes: boolean): void {
	const visibleNotes = includeDeletedNotes ? notes : notes.filter((note) => note.deleted_at === null);
	if (visibleNotes.length === 0) {
		lines.push("Notes:");
		return;
	}
	lines.push("Notes:");
	for (const note of visibleNotes) {
		const deleted = note.deleted_at ? " [deleted]" : "";
		lines.push(`- ${note.source}${deleted}: ${singleLine(note.content)}`);
	}
}

function itemHeading(item: TreeItem): string {
	if (item.type === "group") return item.title;
	return item.title ?? item.question;
}

function header(level: number, text: string): string {
	return `${"#".repeat(Math.max(1, level))} ${singleLine(text)}`;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
