import { randomUUID } from "node:crypto";
import { link, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export type NoteToDelete = { path: string; fileName: string };
export type DeletedNote<T extends NoteToDelete = NoteToDelete> = { note: T; trashPath: string };

/** Move a note into hidden, recoverable storage beside the active notes. */
export async function softDeleteNote<T extends NoteToDelete>(
	notesDir: string,
	note: T,
): Promise<DeletedNote<T>> {
	const trashDir = join(notesDir, ".trash");
	await mkdir(trashDir, { recursive: true });
	const trashPath = join(trashDir, `${randomUUID()}-${note.fileName}`);
	await rename(note.path, trashPath);
	return { note, trashPath };
}

/** Restore without overwriting a new note created at the original path. */
export async function restoreNote<T extends NoteToDelete>(deleted: DeletedNote<T>): Promise<void> {
	// link() is exclusive: never overwrite a note recreated at its original path.
	await link(deleted.trashPath, deleted.note.path);
	// Cleanup is optional: if it fails, both links still preserve the content.
	try {
		await unlink(deleted.trashPath);
	} catch {
		// The note has already been restored; leave the hidden recovery copy alone.
	}
}
