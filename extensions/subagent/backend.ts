/**
 * Backend boundary for subagent RPC children.
 *
 * Dispatch orchestration depends only on `SubagentBackend`; it never branches
 * on transport. `ProcessSubagentBackend` wraps the existing direct
 * `spawnRpcChild()` behavior unchanged. The Herdr backend (Stage 3+) will
 * implement the same interface by acquiring a pane and returning an `RpcChild`
 * backed by the authenticated socket bridge.
 *
 * This module has no Pi runtime imports so it stays loadable from `bun test`.
 */

import { spawnRpcChild, type RpcChild, type SpawnRpcChildOptions } from "./rpc-client.ts";
import type { SubagentBackendKind } from "./types.ts";

/** Per-run identity passed to a backend alongside the spawn options. */
export interface RunBackendContext {
	runId: string;
	dispatchId: string;
	agent: string;
}

export interface SubagentBackend {
	readonly kind: SubagentBackendKind;
	spawn(options: SpawnRpcChildOptions, context: RunBackendContext): Promise<RpcChild>;
}

/** Default backend: a direct `pi --mode rpc` child over stdin/stdout pipes. */
export class ProcessSubagentBackend implements SubagentBackend {
	readonly kind = "process" as const;

	async spawn(options: SpawnRpcChildOptions, _context: RunBackendContext): Promise<RpcChild> {
		return spawnRpcChild(options);
	}
}

export type { SubagentBackendKind } from "./types.ts";
