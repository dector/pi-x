declare module "node:fs" {
	export const constants: { F_OK: number };
}

declare module "node:fs/promises" {
	export function access(path: string, mode?: number): Promise<void>;
	export function appendFile(path: string, data: string, options?: string | { encoding?: string }): Promise<void>;
	export function mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
	export function readFile(path: string, options?: string | { encoding?: string }): Promise<string>;
	export function readdir(path: string, options?: { withFileTypes?: boolean }): Promise<any[]>;
	export function rename(oldPath: string, newPath: string): Promise<void>;
	export function writeFile(path: string, data: string, options?: string | { encoding?: string }): Promise<void>;
}

declare module "node:path" {
	export function dirname(path: string): string;
}

declare module "node:child_process" {
	export function execFile(file: string, args?: readonly string[], options?: unknown, callback?: (...args: any[]) => void): unknown;
}

declare module "node:util" {
	export function promisify(fn: (...args: any[]) => any): (...args: any[]) => Promise<any>;
}

declare const process: {
	cwd(): string;
};
