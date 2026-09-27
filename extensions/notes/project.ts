import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

export type NoteProjectMetadata = { cwd: string };

/** Keep project metadata outside user-authored Markdown content. */
export function metadataPath(notesDir: string, fileName: string): string {
	return join(notesDir, ".metadata", `${basename(fileName)}.json`);
}

export async function writeProjectMetadata(notesDir: string, fileName: string, cwd: string): Promise<void> {
	const dir = join(notesDir, ".metadata");
	await mkdir(dir, { recursive: true });
	const metadata: NoteProjectMetadata = { cwd };
	await writeFile(metadataPath(notesDir, fileName), `${JSON.stringify(metadata)}\n`, { encoding: "utf8", flag: "wx" });
}

/** Change a note's scope without touching its Markdown. Missing metadata means Global. */
export async function moveNoteScope(notesDir: string, fileName: string, cwd: string | undefined): Promise<void> {
	const path = metadataPath(notesDir, fileName);
	if (cwd !== undefined) {
		const dir = join(notesDir, ".metadata");
		await mkdir(dir, { recursive: true });
		const temporaryPath = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify({ cwd } satisfies NoteProjectMetadata)}\n`, { encoding: "utf8", flag: "wx" });
			await rename(temporaryPath, path);
		} catch (error) {
			try { await unlink(temporaryPath); } catch { /* No temporary file to clean up. */ }
			throw error;
		}
		return;
	}
	try {
		await unlink(path);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
}

export async function readProjectMetadata(path: string): Promise<NoteProjectMetadata | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof value === "object" && value !== null && "cwd" in value && typeof value.cwd === "string") {
			return { cwd: value.cwd };
		}
	} catch {
		// Missing or malformed metadata is treated like a legacy note.
	}
	return undefined;
}

export function noteMatchesProject(cwd: string | undefined, currentCwd: string, allProjects: boolean): boolean {
	return allProjects ? true : cwd === currentCwd;
}

export function noteMatchesScope(cwd: string | undefined, currentCwd: string, scope: "current" | "global" | "all"): boolean {
	if (scope === "all") return true;
	return scope === "global" ? cwd === undefined : cwd === currentCwd;
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
