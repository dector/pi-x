export type Version = 1;

export type Priority = "critical" | "important" | "major" | "minor" | "nitpick";
export type Status = "open" | "answered" | "resolved" | "superseded";
export type AnswerStage = "accepted" | "need_polishing" | "need_approval";
export type ItemType = "group" | "decision";
export type NoteSource = "user" | "tool";
export type RawRole = "user" | "tool";

export type IndexDoc = {
	version: Version;
	history: {
		capture_default: boolean;
	};
};

export type SessionDoc = {
	version: Version;
	active_tree_id: string | null;
	active_item_id: string | null;
	created_at: string;
	updated_at: string;
};

export type TreeDoc = {
	version: Version;
	id: string;
	title: string;
	status: Status;
	history: {
		capture: boolean | null;
	};
	root: GroupItem;
	created_at: string;
	updated_at: string;
};

export type BaseItem = {
	id: string;
	type: ItemType;
	priority: Priority;
	title: string | null;
	status: Status;
	notes: Note[];
	raw_refs: string[];
	children: TreeItem[];
	created_at: string;
	updated_at: string;
};

export type GroupItem = BaseItem & {
	type: "group";
	title: string;
};

export type DecisionItem = BaseItem & {
	type: "decision";
	title: string | null;
	question: string;
	answer: string | null;
	answer_stage: AnswerStage | null;
};

export type TreeItem = GroupItem | DecisionItem;

export type Note = {
	id: string;
	timestamp: string;
	source: NoteSource;
	content: string;
	deleted_at: string | null;
};

export type RawEntry = {
	id: string;
	timestamp: string;
	role: RawRole;
	content: string;
};

export type ValidationError = {
	path: string;
	code: string;
	message: string;
};

export type ValidationResult =
	| { ok: true; errors: [] }
	| { ok: false; errors: ValidationError[] };
