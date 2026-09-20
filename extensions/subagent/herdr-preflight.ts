/**
 * Herdr detection, validation, and pane-bridge launch.
 *
 * Stage 4 runs this before an async dispatch is accepted so every predictable
 * failure (Herdr missing, executable missing, bridge runtime unavailable,
 * server unreachable, parent pane gone, tab creation failed) surfaces at
 * preparation time instead of after an acknowledgement.
 *
 * The launcher is the only place that renders a command for a Herdr pane. It
 * passes just the safe bridge bootstrap (socket path and token file); task
 * text, prompts, and Pi arguments travel over the authenticated socket.
 *
 * No Pi runtime imports, so this stays loadable from `bun test`.
 */

import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { HerdrBridgeLauncher } from "./herdr-bridge.ts";
import {
	createHerdrClient,
	createUnixSocketTransport,
	readHerdrEnvironment,
	resolveHerdrExecutable,
	type HerdrClient,
	type HerdrEnvironment,
} from "./herdr-client.ts";
import type { ParentHerdrTab } from "./herdr-tab.ts";

export type HerdrPreflightReason =
	| "not_detected"
	| "executable_missing"
	| "bridge_unavailable"
	| "unreachable"
	| "missing_parent"
	| "pane_unavailable";

export type HerdrPreflightResult =
	| { ok: true; environment: HerdrEnvironment; client: HerdrClient; tab: ParentHerdrTab }
	| { ok: false; reason: HerdrPreflightReason; error: string };

export interface HerdrPreflightDependencies {
	env?: NodeJS.ProcessEnv;
	/** Session-scoped Herdr state to reuse when the environment still matches. */
	existing?: { environment: HerdrEnvironment; client: HerdrClient; tab: ParentHerdrTab };
	/** Build a fresh parent tab manager (wired to the default file state store). */
	createTab: (client: HerdrClient, environment: HerdrEnvironment) => ParentHerdrTab;
	/** Injection seam for tests; defaults to a Unix-socket client. */
	createClient?: (environment: HerdrEnvironment) => HerdrClient;
	/** Throw when the pane bridge cannot be launched. */
	assertBridgeAvailable?: () => void;
	resolveExecutable?: (env: NodeJS.ProcessEnv) => string | undefined;
}

function fail(reason: HerdrPreflightReason, error: string): HerdrPreflightResult {
	return { ok: false, reason, error };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve Herdr, verify the server and parent pane, and create/reuse the owned
 * parent tab. Does no work unless Herdr was explicitly requested by the caller.
 */
export async function preflightHerdr(deps: HerdrPreflightDependencies): Promise<HerdrPreflightResult> {
	const env = deps.env ?? process.env;
	const environment = readHerdrEnvironment(env);
	if (!environment) {
		return fail(
			"not_detected",
			"Herdr was requested, but this session is not running inside a Herdr pane (HERDR_ENV is not 1).",
		);
	}

	const resolveExecutable = deps.resolveExecutable ?? resolveHerdrExecutable;
	if (!resolveExecutable(env)) {
		return fail("executable_missing", "Herdr was requested, but the `herdr` executable could not be found.");
	}

	try {
		(deps.assertBridgeAvailable ?? assertHerdrBridgeAvailable)();
	} catch (error) {
		return fail("bridge_unavailable", `Herdr was requested, but the pane bridge is unavailable: ${messageOf(error)}`);
	}

	const existing = deps.existing;
	const reuse =
		existing !== undefined &&
		existing.environment.socketPath === environment.socketPath &&
		existing.environment.paneId === environment.paneId &&
		existing.environment.workspaceId === environment.workspaceId;
	const client =
		reuse && existing
			? existing.client
			: (deps.createClient?.(environment) ??
				createHerdrClient({ environment, transport: createUnixSocketTransport({ socketPath: environment.socketPath }) }));

	try {
		await client.assertCompatible();
	} catch (error) {
		return fail("unreachable", `Herdr was requested, but the server could not be reached: ${messageOf(error)}`);
	}

	try {
		await client.getPane(environment.paneId);
	} catch (error) {
		return fail(
			"missing_parent",
			`Herdr was requested, but the parent pane ${environment.paneId} is not available: ${messageOf(error)}`,
		);
	}

	const tab = reuse && existing ? existing.tab : deps.createTab(client, environment);
	try {
		await tab.ensureTab();
	} catch (error) {
		return fail("pane_unavailable", `Herdr was requested, but the parent tab could not be prepared: ${messageOf(error)}`);
	}

	return { ok: true, environment, client, tab };
}

/** Absolute path to the pane-side bridge entry point shipped with this extension. */
export function resolveHerdrBridgeMainPath(): string {
	return join(import.meta.dir, "herdr-bridge-main.ts");
}

/**
 * Resolve a runtime that can execute the TypeScript bridge. Bun is the only
 * supported runtime; the compiled `pi` binary cannot run a standalone script.
 */
export function resolveHerdrBridgeRuntime(
	env: NodeJS.ProcessEnv = process.env,
	options: { isExecutable?: (path: string) => boolean } = {},
): string | undefined {
	const isExecutable = options.isExecutable ?? defaultIsExecutable;
	const exec = process.execPath;
	if (/^bun(\.exe)?$/i.test(baseName(exec)) && isExecutable(exec)) return exec;
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, process.platform === "win32" ? "bun.exe" : "bun");
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

/** Throw when the bridge entry point or runtime is missing. */
export function assertHerdrBridgeAvailable(
	options: {
		env?: NodeJS.ProcessEnv;
		bridgeMainPath?: string;
		resolveRuntime?: (env: NodeJS.ProcessEnv) => string | undefined;
	} = {},
): void {
	const mainPath = options.bridgeMainPath ?? resolveHerdrBridgeMainPath();
	if (!existsSync(mainPath)) {
		throw new Error(`bridge entry point not found: ${mainPath}`);
	}
	const resolveRuntime = options.resolveRuntime ?? resolveHerdrBridgeRuntime;
	if (!resolveRuntime(options.env ?? process.env)) {
		throw new Error("the Bun runtime is required to launch the pane bridge, but none was found on PATH");
	}
}

export interface HerdrBridgeLauncherOptions {
	client: Pick<HerdrClient, "sendText" | "sendKeys">;
	env?: NodeJS.ProcessEnv;
	bridgeMainPath?: string;
	resolveRuntime?: (env: NodeJS.ProcessEnv) => string | undefined;
}

/**
 * Build the production launcher. It types the bridge bootstrap into the leased
 * pane and presses Enter; no task text or Pi arguments are ever part of it.
 */
export function createHerdrBridgeLauncher(options: HerdrBridgeLauncherOptions): HerdrBridgeLauncher {
	const env = options.env ?? process.env;
	const resolveRuntime = options.resolveRuntime ?? resolveHerdrBridgeRuntime;
	const mainPath = options.bridgeMainPath ?? resolveHerdrBridgeMainPath();
	return {
		assertAvailable() {
			assertHerdrBridgeAvailable({ env, bridgeMainPath: mainPath, resolveRuntime });
		},
		async launch(paneId, bootstrap) {
			const runtime = resolveRuntime(env);
			if (!runtime) throw new Error("the Bun runtime is required to launch the pane bridge");
			const command = [runtime, mainPath, "--socket", bootstrap.socketPath, "--token-file", bootstrap.tokenFile]
				.map(shellQuote)
				.join(" ");
			await options.client.sendText(paneId, command);
			await options.client.sendKeys(paneId, ["Enter"]);
		},
	};
}

/** POSIX single-quote a value so a temp path with spaces still runs. */
export function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function baseName(path: string): string {
	const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return index >= 0 ? path.slice(index + 1) : path;
}

function defaultIsExecutable(path: string): boolean {
	try {
		if (!isAbsolute(path) || !existsSync(path)) return false;
		if (!statSync(path).isFile()) return false;
		accessSync(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}
