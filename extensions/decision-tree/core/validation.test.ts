import { expect, test } from "bun:test";
import { priorityRank } from "./constants";
import { isUuid } from "./ids";
import { isIsoTimestamp, nowIso } from "./time";
import type { DecisionItem, GroupItem, TreeDoc } from "./types";
import {
	cloneTree,
	cloneTreeItem,
	isActiveNote,
	validateIndexDoc,
	validateNoteDoc,
	validateRawEntry,
	validateSessionDoc,
	validateTreeDoc,
	validateTreeItem,
	withoutDeletedNotes,
} from "./validation";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const now = "2026-01-02T03:04:05.000Z";
const later = "2026-01-03T03:04:05.000Z";

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

function validGroup(overrides: Partial<GroupItem> = {}): GroupItem {
	return {
		id: id(10),
		type: "group",
		priority: "important",
		title: "Group",
		status: "open",
		notes: [],
		raw_refs: [],
		children: [],
		created_at: now,
		updated_at: now,
		...overrides,
	};
}

function validDecision(overrides: Partial<DecisionItem> = {}): DecisionItem {
	return {
		id: id(11),
		type: "decision",
		priority: "major",
		title: null,
		question: "What should we choose?",
		answer: null,
		answer_stage: null,
		status: "open",
		notes: [],
		raw_refs: [],
		children: [],
		created_at: now,
		updated_at: now,
		...overrides,
	};
}

function validTree(): TreeDoc {
	return {
		version: 1,
		id: id(1),
		title: "Product decisions",
		status: "open",
		history: { capture: null },
		root: validGroup({ id: id(2), title: "", children: [] }),
		created_at: now,
		updated_at: now,
	};
}

function errorCodes(result: ReturnType<typeof validateTreeDoc>): string[] {
	expect(result.ok).toBe(false);
	return result.ok ? [] : result.errors.map((error) => error.code);
}

function expectTreeError(mutator: (tree: Mutable<TreeDoc>) => void, code: string): void {
	const tree = validTree() as Mutable<TreeDoc>;
	mutator(tree);
	expect(errorCodes(validateTreeDoc(tree))).toContain(code);
}

function expectInvalid(result: { ok: boolean; errors: { code: string }[] }, code: string): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.errors.map((error) => error.code)).toContain(code);
}

test("validateIndexDoc accepts v1 index shape", () => {
	expect(validateIndexDoc({ version: 1, history: { capture_default: true } }).ok).toBe(true);
});

test("validateIndexDoc rejects invalid document shapes", () => {
	expectInvalid(validateIndexDoc(null), "invalid_document");
	expectInvalid(validateIndexDoc({ version: 2, history: { capture_default: true } }), "invalid_version");
	expectInvalid(validateIndexDoc({ version: 1, history: null }), "invalid_history");
	expectInvalid(validateIndexDoc({ version: 1, history: { capture_default: "yes" } }), "invalid_capture_default");
});

test("validateSessionDoc accepts nullable and UUID active context", () => {
	expect(validateSessionDoc({ version: 1, active_tree_id: null, active_item_id: null, created_at: now, updated_at: now }).ok).toBe(true);
	expect(validateSessionDoc({ version: 1, active_tree_id: id(1), active_item_id: id(2), created_at: now, updated_at: now }).ok).toBe(true);
});

test("validateSessionDoc rejects invalid fields", () => {
	expectInvalid(validateSessionDoc([]), "invalid_document");
	expectInvalid(validateSessionDoc({ version: "1", active_tree_id: null, active_item_id: null, created_at: now, updated_at: now }), "invalid_version");
	expectInvalid(validateSessionDoc({ version: 1, active_tree_id: "bad", active_item_id: null, created_at: now, updated_at: now }), "invalid_uuid");
	expectInvalid(validateSessionDoc({ version: 1, active_tree_id: null, active_item_id: "bad", created_at: now, updated_at: now }), "invalid_uuid");
	expectInvalid(validateSessionDoc({ version: 1, active_tree_id: null, active_item_id: null, created_at: "bad", updated_at: now }), "invalid_timestamp");
});

test("validateTreeDoc accepts minimal valid tree", () => {
	expect(validateTreeDoc(validTree()).ok).toBe(true);
});

test("validateTreeDoc accepts nested groups, decisions, notes, and raw refs", () => {
	const tree = validTree();
	tree.root.children.push(
		validGroup({
			id: id(3),
			title: "Scope",
			notes: [{ id: id(4), timestamp: now, source: "user", content: "Constraint", deleted_at: null }],
			raw_refs: [id(5)],
			children: [validDecision({ id: id(6), answer: "Ship it", answer_stage: "accepted", status: "answered" })],
		}),
		validDecision({ id: id(7), title: "Launch", children: [validGroup({ id: id(8), title: "Follow-up" })] }),
	);
	expect(validateTreeDoc(tree).ok).toBe(true);
});

test("validateTreeDoc rejects top-level tree field errors", () => {
	expectInvalid(validateTreeDoc(null), "invalid_document");
	expectTreeError((tree) => (tree.version = 2 as never), "invalid_version");
	expectTreeError((tree) => (tree.id = "bad"), "invalid_uuid");
	expectTreeError((tree) => (tree.title = ""), "empty_string");
	expectTreeError((tree) => (tree.status = "bad" as never), "invalid_status");
	expectTreeError((tree) => (tree.history = null as never), "invalid_history");
	expectTreeError((tree) => (tree.history.capture = "yes" as never), "invalid_capture");
	expectTreeError((tree) => (tree.created_at = "not iso"), "invalid_timestamp");
	expectTreeError((tree) => (tree.updated_at = "not iso"), "invalid_timestamp");
});

test("validateTreeDoc enforces root invariants", () => {
	expectTreeError((tree) => (tree.root = null as never), "invalid_root");
	expectTreeError((tree) => (tree.root.type = "decision" as never), "invalid_root_type");
	expectTreeError((tree) => (tree.root.title = "Root title"), "invalid_root_title");
});

test("validateTreeDoc enforces common item fields", () => {
	expectTreeError((tree) => (tree.root.id = "bad"), "invalid_uuid");
	expectTreeError((tree) => (tree.root.priority = "bad" as never), "invalid_priority");
	expectTreeError((tree) => (tree.root.status = "bad" as never), "invalid_status");
	expectTreeError((tree) => (tree.root.notes = null as never), "invalid_notes");
	expectTreeError((tree) => (tree.root.raw_refs = null as never), "invalid_raw_refs");
	expectTreeError((tree) => (tree.root.raw_refs = ["bad"]), "invalid_uuid");
	expectTreeError((tree) => (tree.root.children = null as never), "invalid_children");
	expectTreeError((tree) => (tree.root.created_at = "bad"), "invalid_timestamp");
	expectTreeError((tree) => (tree.root.updated_at = "bad"), "invalid_timestamp");
});

test("validateTreeDoc enforces group title rules", () => {
	expectTreeError((tree) => tree.root.children.push(validGroup({ id: id(3), title: "" })), "empty_string");
	expectTreeError((tree) => tree.root.children.push(validGroup({ id: id(3), title: null as never })), "invalid_string");
});

test("validateTreeDoc enforces decision question and title rules", () => {
	expectTreeError((tree) => tree.root.children.push(validDecision({ id: id(3), question: "" })), "empty_string");
	expectTreeError((tree) => tree.root.children.push(validDecision({ id: id(3), question: null as never })), "invalid_string");
	expectTreeError((tree) => tree.root.children.push(validDecision({ id: id(3), title: 1 as never })), "invalid_string");
	expectTreeError((tree) => tree.root.children.push({ ...validDecision({ id: id(3) }), type: "unknown" as never }), "invalid_item_type");
});

test("validateTreeDoc permits decision title to be null or string", () => {
	const tree = validTree();
	tree.root.children.push(validDecision({ id: id(3), title: null }), validDecision({ id: id(4), title: "Short label" }));
	expect(validateTreeDoc(tree).ok).toBe(true);
});

test("validateTreeDoc enforces answer and answer_stage iff rules", () => {
	expectTreeError((tree) => tree.root.children.push(validDecision({ id: id(3), answer: null, answer_stage: "accepted" })), "invalid_answer_stage");
	expectTreeError((tree) => tree.root.children.push(validDecision({ id: id(3), answer: "Yes", answer_stage: null })), "invalid_answer_stage");
	expectTreeError((tree) => tree.root.children.push(validDecision({ id: id(3), answer: "", answer_stage: "accepted" })), "empty_string");
	expectTreeError((tree) => tree.root.children.push(validDecision({ id: id(3), answer: "Yes", answer_stage: "bad" as never })), "invalid_answer_stage");
});

test("validateTreeDoc accepts all valid enum values", () => {
	const statuses = ["open", "answered", "resolved", "superseded"] as const;
	const priorities = ["critical", "important", "major", "minor", "nitpick"] as const;
	const stages = ["accepted", "need_polishing", "need_approval"] as const;
	for (const status of statuses) {
		for (const priority of priorities) {
			for (const answer_stage of stages) {
				const tree = validTree();
				tree.status = status;
				tree.root.priority = priority;
				tree.root.children.push(validDecision({ id: id(3), answer: "Yes", answer_stage }));
				expect(validateTreeDoc(tree).ok).toBe(true);
			}
		}
	}
});

test("validateTreeDoc rejects duplicate item IDs anywhere and duplicate sibling child IDs", () => {
	const duplicateId = id(3);
	expectTreeError(
		(tree) =>
			tree.root.children.push(
				validGroup({ id: duplicateId, title: "A" }),
				validGroup({ id: duplicateId, title: "B" }),
			),
		"duplicate_child_id",
	);
	expectTreeError(
		(tree) =>
			tree.root.children.push(
				validGroup({ id: duplicateId, title: "A", children: [validDecision({ id: id(4), children: [validGroup({ id: duplicateId, title: "Nested duplicate" })] })] }),
			),
		"duplicate_item_id",
	);
});

test("validateTreeItem validates standalone root and non-root items", () => {
	expect(validateTreeItem(validGroup({ title: "" }), { root: true }).ok).toBe(true);
	expectInvalid(validateTreeItem(validGroup({ title: "" })), "empty_string");
	expectInvalid(validateTreeItem({ nope: true }), "invalid_item_type");
});

test("validateNoteDoc accepts active and deleted notes", () => {
	expect(validateNoteDoc({ id: id(1), timestamp: now, source: "user", content: "A note", deleted_at: null }).ok).toBe(true);
	expect(validateNoteDoc({ id: id(1), timestamp: now, source: "tool", content: "A note", deleted_at: later }).ok).toBe(true);
});

test("validateNoteDoc rejects invalid note fields", () => {
	expectInvalid(validateNoteDoc(null), "invalid_note");
	expectInvalid(validateNoteDoc({ id: "bad", timestamp: now, source: "user", content: "A", deleted_at: null }), "invalid_uuid");
	expectInvalid(validateNoteDoc({ id: id(1), timestamp: "bad", source: "user", content: "A", deleted_at: null }), "invalid_timestamp");
	expectInvalid(validateNoteDoc({ id: id(1), timestamp: now, source: "agent", content: "A", deleted_at: null }), "invalid_note_source");
	expectInvalid(validateNoteDoc({ id: id(1), timestamp: now, source: "user", content: "", deleted_at: null }), "empty_string");
	expectInvalid(validateNoteDoc({ id: id(1), timestamp: now, source: "user", content: "A", deleted_at: "bad" }), "invalid_timestamp");
});

test("validateRawEntry accepts valid raw entries", () => {
	expect(validateRawEntry({ id: id(1), timestamp: now, role: "user", content: "Raw user input" }).ok).toBe(true);
	expect(validateRawEntry({ id: id(1), timestamp: now, role: "tool", content: "Raw tool input" }).ok).toBe(true);
});

test("validateRawEntry rejects invalid raw entry fields", () => {
	expectInvalid(validateRawEntry(null), "invalid_raw_entry");
	expectInvalid(validateRawEntry({ id: "bad", timestamp: now, role: "user", content: "A" }), "invalid_uuid");
	expectInvalid(validateRawEntry({ id: id(1), timestamp: "bad", role: "user", content: "A" }), "invalid_timestamp");
	expectInvalid(validateRawEntry({ id: id(1), timestamp: now, role: "agent", content: "A" }), "invalid_raw_role");
	expectInvalid(validateRawEntry({ id: id(1), timestamp: now, role: "user", content: "" }), "empty_string");
});

test("isActiveNote and withoutDeletedNotes filter deleted notes recursively", () => {
	const active = { id: id(1), timestamp: now, source: "user" as const, content: "Active", deleted_at: null };
	const deleted = { id: id(2), timestamp: now, source: "tool" as const, content: "Deleted", deleted_at: later };
	expect(isActiveNote(active)).toBe(true);
	expect(isActiveNote(deleted)).toBe(false);

	const item = validGroup({
		notes: [active, deleted],
		children: [validDecision({ id: id(3), notes: [active, deleted] })],
	});
	const filtered = withoutDeletedNotes(item);
	expect(filtered.notes).toEqual([active]);
	expect(filtered.children[0]?.notes).toEqual([active]);
});

test("priorityRank returns configured ranking order", () => {
	expect(["critical", "important", "major", "minor", "nitpick"].map((priority) => priorityRank(priority as never))).toEqual([0, 1, 2, 3, 4]);
});

test("id and time helpers recognize valid shapes", () => {
	expect(isUuid(id(1))).toBe(true);
	expect(isUuid("bad")).toBe(false);
	expect(isIsoTimestamp(now)).toBe(true);
	expect(isIsoTimestamp("2026-01-02T03:04:05Z")).toBe(false);
	expect(isIsoTimestamp("bad")).toBe(false);
	expect(isIsoTimestamp(nowIso())).toBe(true);
});

test("clone helpers produce mutation-safe copies", () => {
	const tree = validTree();
	const treeClone = cloneTree(tree);
	treeClone.root.title = "changed";
	expect(tree.root.title).toBe("");

	const item = validGroup({ title: "Original" });
	const itemClone = cloneTreeItem(item);
	itemClone.title = "Changed";
	expect(item.title).toBe("Original");
});
