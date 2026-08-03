import {
	SCHEMA_VERSION,
	isAnswerStage,
	isNoteSource,
	isPriority,
	isRawRole,
	isStatus,
} from "./constants";
import { isUuid } from "./ids";
import { isIsoTimestamp } from "./time";
import type { IndexDoc, Note, RawEntry, SessionDoc, TreeDoc, TreeItem, ValidationError, ValidationResult } from "./types";

class ValidationCollector {
	readonly errors: ValidationError[] = [];

	add(path: string, code: string, message: string): void {
		this.errors.push({ path, code, message });
	}

	result(): ValidationResult {
		return this.errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors: this.errors };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateVersion(value: unknown, path: string, errors: ValidationCollector): void {
	if (value !== SCHEMA_VERSION) errors.add(path, "invalid_version", "version must be 1");
}

function validateUuid(value: unknown, path: string, errors: ValidationCollector): void {
	if (!isUuid(value)) errors.add(path, "invalid_uuid", "must be a UUID");
}

function validateTimestamp(value: unknown, path: string, errors: ValidationCollector): void {
	if (!isIsoTimestamp(value)) errors.add(path, "invalid_timestamp", "must be an ISO-8601 timestamp");
}

function validateString(value: unknown, path: string, errors: ValidationCollector, options?: { nonEmpty?: boolean; nullable?: boolean }): void {
	if (value === null && options?.nullable) return;
	if (typeof value !== "string") {
		errors.add(path, "invalid_string", "must be a string");
		return;
	}
	if (options?.nonEmpty && value.trim().length === 0) errors.add(path, "empty_string", "must be non-empty");
}

function validateNotes(value: unknown, path: string, errors: ValidationCollector): void {
	if (!Array.isArray(value)) {
		errors.add(path, "invalid_notes", "must be an array");
		return;
	}
	for (let index = 0; index < value.length; index++) validateNote(value[index], `${path}[${index}]`, errors);
}

function validateRawRefs(value: unknown, path: string, errors: ValidationCollector): void {
	if (!Array.isArray(value)) {
		errors.add(path, "invalid_raw_refs", "must be an array");
		return;
	}
	for (let index = 0; index < value.length; index++) validateUuid(value[index], `${path}[${index}]`, errors);
}

function validateCommonItemFields(item: Record<string, unknown>, path: string, errors: ValidationCollector): void {
	validateUuid(item.id, `${path}.id`, errors);
	if (!isPriority(item.priority)) errors.add(`${path}.priority`, "invalid_priority", "must be a valid priority");
	if (!isStatus(item.status)) errors.add(`${path}.status`, "invalid_status", "must be a valid status");
	validateNotes(item.notes, `${path}.notes`, errors);
	validateRawRefs(item.raw_refs, `${path}.raw_refs`, errors);
	validateTimestamp(item.created_at, `${path}.created_at`, errors);
	validateTimestamp(item.updated_at, `${path}.updated_at`, errors);
}

function validateItemRecursive(
	value: unknown,
	path: string,
	errors: ValidationCollector,
	ctx: { root: boolean; seenIds: Set<string> },
): void {
	if (!isRecord(value)) {
		errors.add(path, "invalid_item", "must be an object");
		return;
	}

	validateCommonItemFields(value, path, errors);

	if (isUuid(value.id)) {
		if (ctx.seenIds.has(value.id)) errors.add(`${path}.id`, "duplicate_item_id", "item IDs must be unique within a tree");
		ctx.seenIds.add(value.id);
	}

	if (value.type === "group") {
		validateString(value.title, `${path}.title`, errors, { nonEmpty: !ctx.root });
		if (ctx.root && value.title !== "") errors.add(`${path}.title`, "invalid_root_title", "root group title must be empty");
	} else if (value.type === "decision") {
		validateString(value.title, `${path}.title`, errors, { nullable: true });
		validateString(value.question, `${path}.question`, errors, { nonEmpty: true });
		validateString(value.answer, `${path}.answer`, errors, { nullable: true, nonEmpty: true });
		if (value.answer === null) {
			if (value.answer_stage !== null) errors.add(`${path}.answer_stage`, "invalid_answer_stage", "must be null when answer is null");
		} else {
			if (!isAnswerStage(value.answer_stage)) {
				errors.add(`${path}.answer_stage`, "invalid_answer_stage", "must be a valid answer stage when answer is set");
			}
		}
	} else {
		errors.add(`${path}.type`, "invalid_item_type", "must be group or decision");
	}

	if (!Array.isArray(value.children)) {
		errors.add(`${path}.children`, "invalid_children", "must be an array");
		return;
	}

	const childIds = new Set<string>();
	for (let index = 0; index < value.children.length; index++) {
		const child = value.children[index];
		if (isRecord(child) && isUuid(child.id)) {
			if (childIds.has(child.id)) errors.add(`${path}.children[${index}].id`, "duplicate_child_id", "child IDs must not repeat under a parent");
			childIds.add(child.id);
		}
		validateItemRecursive(child, `${path}.children[${index}]`, errors, { root: false, seenIds: ctx.seenIds });
	}
}

export function validateIndexDoc(value: unknown): ValidationResult {
	const errors = new ValidationCollector();
	if (!isRecord(value)) {
		errors.add("$", "invalid_document", "index must be an object");
		return errors.result();
	}
	validateVersion(value.version, "$.version", errors);
	if (!isRecord(value.history)) {
		errors.add("$.history", "invalid_history", "must be an object");
	} else if (typeof value.history.capture_default !== "boolean") {
		errors.add("$.history.capture_default", "invalid_capture_default", "must be a boolean");
	}
	return errors.result();
}

export function validateSessionDoc(value: unknown): ValidationResult {
	const errors = new ValidationCollector();
	if (!isRecord(value)) {
		errors.add("$", "invalid_document", "session must be an object");
		return errors.result();
	}
	validateVersion(value.version, "$.version", errors);
	if (value.active_tree_id !== null) validateUuid(value.active_tree_id, "$.active_tree_id", errors);
	if (value.active_item_id !== null) validateUuid(value.active_item_id, "$.active_item_id", errors);
	validateTimestamp(value.created_at, "$.created_at", errors);
	validateTimestamp(value.updated_at, "$.updated_at", errors);
	return errors.result();
}

export function validateTreeDoc(value: unknown): ValidationResult {
	const errors = new ValidationCollector();
	if (!isRecord(value)) {
		errors.add("$", "invalid_document", "tree must be an object");
		return errors.result();
	}
	validateVersion(value.version, "$.version", errors);
	validateUuid(value.id, "$.id", errors);
	validateString(value.title, "$.title", errors, { nonEmpty: true });
	if (!isStatus(value.status)) errors.add("$.status", "invalid_status", "must be a valid status");
	if (!isRecord(value.history)) {
		errors.add("$.history", "invalid_history", "must be an object");
	} else if (value.history.capture !== null && typeof value.history.capture !== "boolean") {
		errors.add("$.history.capture", "invalid_capture", "must be a boolean or null");
	}
	if (!isRecord(value.root)) {
		errors.add("$.root", "invalid_root", "root must be an object");
	} else {
		if (value.root.type !== "group") errors.add("$.root.type", "invalid_root_type", "root item must be a group");
		validateItemRecursive(value.root, "$.root", errors, { root: true, seenIds: new Set<string>() });
	}
	validateTimestamp(value.created_at, "$.created_at", errors);
	validateTimestamp(value.updated_at, "$.updated_at", errors);
	return errors.result();
}

export function validateTreeItem(value: unknown, options?: { root?: boolean }): ValidationResult {
	const errors = new ValidationCollector();
	validateItemRecursive(value, "$", errors, { root: options?.root ?? false, seenIds: new Set<string>() });
	return errors.result();
}

export function validateNoteDoc(value: unknown): ValidationResult {
	const errors = new ValidationCollector();
	validateNote(value, "$", errors);
	return errors.result();
}

function validateNote(value: unknown, path: string, errors: ValidationCollector): void {
	if (!isRecord(value)) {
		errors.add(path, "invalid_note", "must be an object");
		return;
	}
	validateUuid(value.id, `${path}.id`, errors);
	validateTimestamp(value.timestamp, `${path}.timestamp`, errors);
	if (!isNoteSource(value.source)) errors.add(`${path}.source`, "invalid_note_source", "must be user or tool");
	validateString(value.content, `${path}.content`, errors, { nonEmpty: true });
	if (value.deleted_at !== null) validateTimestamp(value.deleted_at, `${path}.deleted_at`, errors);
}

export function validateRawEntry(value: unknown): ValidationResult {
	const errors = new ValidationCollector();
	if (!isRecord(value)) {
		errors.add("$", "invalid_raw_entry", "must be an object");
		return errors.result();
	}
	validateUuid(value.id, "$.id", errors);
	validateTimestamp(value.timestamp, "$.timestamp", errors);
	if (!isRawRole(value.role)) errors.add("$.role", "invalid_raw_role", "must be user or tool");
	validateString(value.content, "$.content", errors, { nonEmpty: true });
	return errors.result();
}

export function assertValidIndexDoc(value: unknown): asserts value is IndexDoc {
	assertValid(validateIndexDoc(value));
}

export function assertValidSessionDoc(value: unknown): asserts value is SessionDoc {
	assertValid(validateSessionDoc(value));
}

export function assertValidTreeDoc(value: unknown): asserts value is TreeDoc {
	assertValid(validateTreeDoc(value));
}

export function assertValidTreeItem(value: unknown): asserts value is TreeItem {
	assertValid(validateTreeItem(value));
}

export function assertValidNote(value: unknown): asserts value is Note {
	assertValid(validateNoteDoc(value));
}

export function assertValidRawEntry(value: unknown): asserts value is RawEntry {
	assertValid(validateRawEntry(value));
}

function assertValid(result: ValidationResult): void {
	if (!result.ok) throw new Error(result.errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
}

export function isActiveNote(note: Note): boolean {
	return note.deleted_at === null;
}

export function withoutDeletedNotes<T extends TreeItem>(item: T): T {
	return {
		...item,
		notes: item.notes.filter(isActiveNote),
		children: item.children.map((child) => withoutDeletedNotes(child)),
	};
}

export function cloneTree<T extends TreeDoc>(tree: T): T {
	return structuredClone(tree);
}

export function cloneTreeItem<T extends TreeItem>(item: T): T {
	return structuredClone(item);
}

export function normalizeOptionalString(value: string | null | undefined): string | null {
	if (value === undefined || value === null) return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

export function normalizeRequiredString(value: string): string {
	return value.trim();
}
