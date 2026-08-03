import { StringEnum, Type } from "@mariozechner/pi-ai";
import { ANSWER_STAGES, ITEM_TYPES, NOTE_SOURCES, PRIORITIES, STATUSES } from "../core/constants";

export const PrioritySchema = StringEnum(PRIORITIES, { description: "Priority." });
export const StatusSchema = StringEnum(STATUSES, { description: "Status." });
export const AnswerStageSchema = StringEnum(ANSWER_STAGES, { description: "Answer stage." });
export const ItemTypeSchema = StringEnum(ITEM_TYPES, { description: "Item type." });
export const NoteSourceSchema = StringEnum(NOTE_SOURCES, { description: "Note source." });
export const StrategySchema = StringEnum(["ranked", "one"] as const, { description: "Selection strategy." });
export const TreeModeSchema = StringEnum(["overview", "full"] as const, { description: "Tree read mode. Defaults to overview." });

const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableAnswerStage = Type.Union([AnswerStageSchema, Type.Null()]);

export const DtInitParams = Type.Object({});

export const DtGetSessionParams = Type.Object({});

export const DtCreateTreeParams = Type.Object({
	title: Type.String({ description: "Decision tree title." }),
	priority: PrioritySchema,
});

export const DtListTreesParams = Type.Object({});

export const DtSelectTreeParams = Type.Object({
	tree_id: Type.String({ description: "Tree UUID or unique prefix." }),
});

export const DtGetTreeParams = Type.Object({
	tree_id: Type.Optional(Type.String({ description: "Tree UUID or unique prefix. Defaults to active tree." })),
	mode: Type.Optional(TreeModeSchema),
	include_deleted_notes: Type.Optional(Type.Boolean({ description: "Include deleted notes in full mode." })),
});

export const DtGetItemParams = Type.Object({
	tree_id: Type.Optional(Type.String({ description: "Tree UUID or unique prefix. Defaults to active tree." })),
	item_id: Type.Optional(Type.String({ description: "Item UUID. Defaults to active item, then root." })),
	include_path: Type.Optional(Type.Boolean({ description: "Include ancestors and computed path. Defaults to true." })),
	children_depth: Type.Optional(Type.Number({ description: "Number of child levels to include. Defaults to 0." })),
	include_deleted_notes: Type.Optional(Type.Boolean({ description: "Include deleted notes." })),
});

export const DtCreateItemParams = Type.Object({
	tree_id: Type.Optional(Type.String({ description: "Tree UUID or unique prefix. Defaults to active tree." })),
	parent_id: Type.Optional(Type.String({ description: "Parent item UUID. Defaults to active item." })),
	type: ItemTypeSchema,
	priority: PrioritySchema,
	title: Type.Optional(NullableString),
	question: Type.Optional(Type.String({ description: "Required for decision items." })),
	answer: Type.Optional(NullableString),
	answer_stage: Type.Optional(NullableAnswerStage),
	status: Type.Optional(StatusSchema),
});

export const DtUpdateItemParams = Type.Object({
	tree_id: Type.Optional(Type.String({ description: "Tree UUID or unique prefix. Defaults to active tree." })),
	item_id: Type.Optional(Type.String({ description: "Item UUID. Defaults to active item." })),
	priority: Type.Optional(PrioritySchema),
	title: Type.Optional(NullableString),
	question: Type.Optional(Type.String()),
	answer: Type.Optional(NullableString),
	answer_stage: Type.Optional(NullableAnswerStage),
	status: Type.Optional(StatusSchema),
	append_notes: Type.Optional(Type.Array(Type.Object({ source: NoteSourceSchema, content: Type.String() }))),
	append_raw_refs: Type.Optional(Type.Array(Type.String({ description: "Raw entry UUID reference." }))),
});

export const DtUpdateNoteParams = Type.Object({
	tree_id: Type.Optional(Type.String({ description: "Tree UUID or unique prefix. Defaults to active tree." })),
	item_id: Type.String({ description: "Item UUID." }),
	note_id: Type.String({ description: "Note UUID." }),
	content: Type.Optional(Type.String()),
	source: Type.Optional(NoteSourceSchema),
	deleted_at: Type.Optional(NullableString),
});

export const DtSetActiveItemParams = Type.Object({
	tree_id: Type.Optional(Type.String({ description: "Tree UUID or unique prefix. Defaults to active tree." })),
	item_id: Type.String({ description: "Item UUID." }),
});

export const DtNextUnresolvedParams = Type.Object({
	tree_id: Type.Optional(Type.String({ description: "Tree UUID or unique prefix. Defaults to all trees." })),
	strategy: Type.Optional(StrategySchema),
	priorities: Type.Optional(Type.Array(PrioritySchema)),
	statuses: Type.Optional(Type.Array(StatusSchema)),
	answer_stages: Type.Optional(Type.Array(NullableAnswerStage)),
	subtree_root_id: Type.Optional(Type.String({ description: "Limit search to this item subtree." })),
	limit: Type.Optional(Type.Number({ description: "Maximum returned items for ranked strategy." })),
});
