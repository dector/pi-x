/**
 * Backend boundary for subagent RPC children.
 *
 * Dispatch orchestration depends only on `SubagentBackend`; it never branches
 * on transport. `ProcessSubagentBackend` wraps the existing direct
 * `spawnRpcChild()` behavior unchanged. `HerdrSubagentBackend` acquires a pane
 * from the parent-owned tab manager, launches the authenticated pane bridge,
 * and returns an `RpcChild` backed by the bridge socket.
 *
 * This module has no Pi runtime imports so it stays loadable from `bun test`.
 */

import { spawnRpcChild, type RpcChild, type SpawnRpcChildOptions } from "./rpc-client.ts";
import {
	createHerdrBridgeChild,
	type HerdrBridgeChildOptions,
	type HerdrBridgeLauncher,
} from "./herdr-bridge.ts";
import type { HerdrPaneLease, ParentHerdrTab } from "./herdr-tab.ts";
import type {
	HerdrRetention,
	HerdrRunLocation,
	PreparedDispatchItem,
	SubagentBackendKind,
	SubagentRunOutcome,
} from "./types.ts";

/** Per-run identity and intent passed to a backend alongside the spawn options. */
export interface RunBackendContext {
	runId: string;
	dispatchId: string;
	agent: string;
	/** Task text; only used for the Herdr pane label/metadata, never for launch args. */
	task?: string;
	/** Herdr retention intent for this run's pane. */
	herdrRetention?: HerdrRetention;
	/**
	 * Stable key for a sequential chain; steps sharing it reuse one pane.
	 * Undefined for single/parallel runs, which always get distinct panes.
	 */
	chainKey?: string;
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

export interface HerdrSubagentBackendOptions {
	tab: ParentHerdrTab;
	launcher: HerdrBridgeLauncher;
	connectTimeoutMs?: number;
	handshakeTimeoutMs?: number;
	maxFrameBytes?: number;
	/** Injection seam for tests; defaults to the real socket bridge. */
	createChild?: (options: HerdrBridgeChildOptions) => Promise<RpcChild>;
}

/**
 * Herdr backend: lease a pane, launch the bridge, and expose the bridge RpcChild
 * plus the pane location. Releasing the child with an outcome returns the pane
 * to the idle pool, retains it, or closes it according to retention policy.
 */
export class HerdrSubagentBackend implements SubagentBackend {
	readonly kind = "herdr" as const;
	private readonly createChild: (options: HerdrBridgeChildOptions) => Promise<RpcChild>;

	constructor(private readonly options: HerdrSubagentBackendOptions) {
		this.createChild = options.createChild ?? createHerdrBridgeChild;
	}

	async spawn(options: SpawnRpcChildOptions, context: RunBackendContext): Promise<RpcChild> {
		const run: PreparedDispatchItem = {
			runId: context.runId,
			agent: context.agent,
			task: context.task ?? "",
		};
		const lease = await this.options.tab.acquire(run, {
			...(context.herdrRetention ? { retention: context.herdrRetention } : {}),
			...(context.chainKey ? { chainKey: context.chainKey } : {}),
		});
		let child: RpcChild;
		try {
			child = await this.createChild({
				spawn: options,
				launch: (bootstrap) => this.options.launcher.launch(lease.paneId, bootstrap),
				display: {
					agent: context.agent,
					runId: context.runId,
					...(context.dispatchId ? { dispatchId: context.dispatchId } : {}),
					...(context.herdrRetention ? { retention: context.herdrRetention } : {}),
				},
				...(this.options.connectTimeoutMs !== undefined ? { connectTimeoutMs: this.options.connectTimeoutMs } : {}),
				...(this.options.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: this.options.handshakeTimeoutMs } : {}),
				...(this.options.maxFrameBytes !== undefined ? { maxFrameBytes: this.options.maxFrameBytes } : {}),
			});
		} catch (error) {
			// A bridge that never launched leaves an empty pane. Force-recycle it so
			// a launch failure cannot strand an invisible retained pane; real run
			// failures still retain according to policy.
			await lease.release("failed", { retain: false }).catch(() => undefined);
			throw error;
		}
		return withLease(child, lease);
	}
}

/**
 * The location to record for a settled run. A recycled (non-retained) pane is
 * free for another run, so keeping its location would make Jump focus a pane
 * owned by a different run; only retained panes keep a persisted location.
 */
export function retainedHerdrLocation(location: HerdrRunLocation | undefined): HerdrRunLocation | undefined {
	return location?.retained ? location : undefined;
}

/** Wrap a bridge child so it also reports and releases its pane lease. */
function withLease(child: RpcChild, lease: HerdrPaneLease): RpcChild {
	return {
		get pid() {
			return child.pid;
		},
		get exited() {
			return child.exited;
		},
		get stderr() {
			return child.stderr;
		},
		get exit() {
			return child.exit;
		},
		get herdr(): HerdrRunLocation {
			return { tabId: lease.tabId, paneId: lease.paneId, retained: lease.retained };
		},
		request: (command, timeoutMs) => child.request(command, timeoutMs),
		send: (command) => child.send(command),
		respondUi: (response) => child.respondUi(response),
		terminate: (terminateOptions) => child.terminate(terminateOptions),
		release: (outcome: SubagentRunOutcome) => lease.release(outcome),
	};
}

export type { SubagentBackendKind } from "./types.ts";
export type { HerdrBridgeLauncher } from "./herdr-bridge.ts";
