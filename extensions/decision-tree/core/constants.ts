import type { AnswerStage, ItemType, NoteSource, Priority, RawRole, Status, Version } from "./types";

export const SCHEMA_VERSION: Version = 1;

export const DECISIONS_DIR = "docs/.decisions";
export const TREES_DIR = "trees";
export const TREE_FILE = "tree.json";
export const RAW_FILE = "raw.jsonl";
export const INDEX_FILE = "index.json";
export const SESSION_FILE = "session.json";

export const PRIORITIES = ["critical", "important", "major", "minor", "nitpick"] as const satisfies readonly Priority[];
export const STATUSES = ["open", "answered", "resolved", "superseded"] as const satisfies readonly Status[];
export const ANSWER_STAGES = ["accepted", "need_polishing", "need_approval"] as const satisfies readonly AnswerStage[];
export const ITEM_TYPES = ["group", "decision"] as const satisfies readonly ItemType[];
export const NOTE_SOURCES = ["user", "tool"] as const satisfies readonly NoteSource[];
export const RAW_ROLES = ["user", "tool"] as const satisfies readonly RawRole[];

export function priorityRank(priority: Priority): number {
	return PRIORITIES.indexOf(priority);
}

export function isPriority(value: unknown): value is Priority {
	return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is Status {
	return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

export function isAnswerStage(value: unknown): value is AnswerStage {
	return typeof value === "string" && (ANSWER_STAGES as readonly string[]).includes(value);
}

export function isItemType(value: unknown): value is ItemType {
	return typeof value === "string" && (ITEM_TYPES as readonly string[]).includes(value);
}

export function isNoteSource(value: unknown): value is NoteSource {
	return typeof value === "string" && (NOTE_SOURCES as readonly string[]).includes(value);
}

export function isRawRole(value: unknown): value is RawRole {
	return typeof value === "string" && (RAW_ROLES as readonly string[]).includes(value);
}
