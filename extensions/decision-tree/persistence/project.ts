/// <reference path="./node-shims.d.ts" />

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resolves project identity for decision storage.
 * Uses the git repository root when cwd is inside a git work tree; otherwise cwd.
 */
export async function resolveProjectRoot(cwd = process.cwd()): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
		const root = stdout.trim();
		return root.length > 0 ? root : cwd;
	} catch {
		return cwd;
	}
}
