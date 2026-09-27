import { randomUUID } from "node:crypto";
import { link, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export type NoteToDelete = { path: string; fileName: string; metadataPath?: string };
export type DeletedNote<T extends NoteToDelete = NoteToDelete> = {
	note: T;
	trashPath: string;
	metadataTrashPath?: string;
};

/** Move a note into hidden, recoverable storage beside the active notes. */
export async function softDeleteNote<T extends NoteToDelete>(
	notesDir: string,
	note: T,
): Promise<DeletedNote<T>> {
	const trashDir = join(notesDir, ".trash");
	await mkdir(trashDir, { recursive: true });
	const id = randomUUID();
	const trashPath = join(trashDir, `${id}-${note.fileName}`);
	const metadataTrashPath = note.metadataPath ? join(trashDir, `${id}-${note.fileName}.json`) : undefined;
	let movedMetadata = false;
	if (note.metadataPath && metadataTrashPath) {
		try {
			await rename(note.metadataPath, metadataTrashPath);
			movedMetadata = true;
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}
	try {
		await rename(note.path, trashPath);
	} catch (error) {
		if (movedMetadata && note.metadataPath && metadataTrashPath) {
			try {
				await rename(metadataTrashPath, note.metadataPath);
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], "Note deletion failed and metadata rollback failed");
			}
		}
		throw error;
	}
	return { note, trashPath, ...(movedMetadata && metadataTrashPath ? { metadataTrashPath } : {}) };
}

/** Restore without overwriting a new note created at the original path. */
export async function restoreNote<T extends NoteToDelete>(deleted: DeletedNote<T>): Promise<void> {
	let restoredMetadata = false;
	if (deleted.metadataTrashPath && deleted.note.metadataPath) {
		await link(deleted.metadataTrashPath, deleted.note.metadataPath);
		restoredMetadata = true;
	}
	try {
		// link() is exclusive: never overwrite a note recreated at its original path.
		await link(deleted.trashPath, deleted.note.path);
	} catch (error) {
		if (restoredMetadata && deleted.note.metadataPath) {
			try {
				await unlink(deleted.note.metadataPath);
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], "Note restore failed and metadata rollback failed");
			}
		}
		throw error;
	}
	// Cleanup is optional: the original hidden copies remain recoverable if cleanup fails.
	try {
		await unlink(deleted.trashPath);
	} catch {
		// Restored note is intact; leave the hidden recovery copy alone.
	}
	if (restoredMetadata && deleted.metadataTrashPath) {
		try {
			await unlink(deleted.metadataTrashPath);
		} catch {
			// Restored metadata is intact; leave the hidden recovery copy alone.
		}
	}
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
