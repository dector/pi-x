export class PersistenceError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}

export class ProjectNotInitializedError extends PersistenceError {
	constructor(projectRoot: string) {
		super("project_not_initialized", `Decision tree storage is not initialized for project: ${projectRoot}`);
	}
}

export class MissingIndexError extends PersistenceError {
	constructor(projectRoot: string) {
		super("missing_index", `Decision tree index is missing for project: ${projectRoot}`);
	}
}

export class MissingSessionError extends PersistenceError {
	constructor(projectRoot: string) {
		super("missing_session", `Decision tree session is missing for project: ${projectRoot}`);
	}
}

export class TreeNotFoundError extends PersistenceError {
	constructor(projectRoot: string, treeId: string) {
		super("tree_not_found", `Decision tree not found for project ${projectRoot}: ${treeId}`);
	}
}

export class MalformedJsonError extends PersistenceError {
	constructor(path: string, cause?: unknown) {
		super("malformed_json", `Malformed JSON or invalid persisted content at: ${path}`, { cause });
	}
}

export class PersistenceValidationError extends PersistenceError {
	constructor(path: string, cause?: unknown) {
		super("validation_failed", `Persisted decision tree content failed validation at: ${path}`, { cause });
	}
}

export class RawHistoryUnavailableError extends PersistenceError {
	constructor(projectRoot: string, treeId: string) {
		super("raw_history_unavailable", `Raw history is unavailable for project ${projectRoot}, tree ${treeId}`);
	}
}
