import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

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
