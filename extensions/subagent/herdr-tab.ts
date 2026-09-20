/**
 * Parent-owned Herdr tab and pane lifecycle.
 *
 * One Herdr tab is created lazily per parent Pi session and reused for every
 * Herdr-backed dispatch. Ownership is bound to
 * `HERDR_SOCKET_PATH + HERDR_PANE_ID + PI_SESSION_ID` and recorded both as
 * machine-readable Herdr pane tokens and as a small state record under Pi's
 * state directory, so `/reload` can rediscover the same tab while `/new` or
 * `/resume` cannot adopt it.
 *
 * Panes are leased to runs. Concurrent runs split balanced leaves in the same
 * tab, a sequential chain can reuse one pane, successful non-retained panes
 * return to a pool of at most one idle pane, and failed/aborted panes are
 * retained by default. A retained pane is never reused automatically.
 *
 * This module has no Pi runtime imports so it stays loadable from `bun test`.
 * It depends only on the typed `HerdrClient`; dispatch/bridge integration is
 * Stage 4 and is deliberately absent here.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HerdrClient, HerdrEnvironment, HerdrPaneInfo, HerdrPaneRect } from "./herdr-client.ts";
import type { HerdrRetention, HerdrRunLocation, PreparedDispatchItem } from "./types.ts";

/** Outcome passed to `HerdrPaneLease.release()`. */
export type HerdrLeaseOutcome = "success" | "failed" | "aborted";

/** Why the parent tab manager is being disposed. */
export type HerdrDisposeReason = "quit" | "reload" | "new" | "resume" | "fork" | "manual";

/** Stable ownership identity for one parent Pi session inside one Herdr pane. */
export interface HerdrOwnershipIdentity {
	socketPath: string;
	parentPaneId: string;
	piSessionId: string;
}

/** Persisted ownership record. Written atomically, validated before reuse. */
export interface HerdrTabStateRecord {
	version: 1;
	ownershipKey: string;
	socketPath: string;
	parentPaneId: string;
	piSessionId: string;
	tabId: string;
	rootPaneId: string;
	label: string;
	retainedPaneIds: string[];
	updatedAt: number;
}

/** Pluggable persistence for ownership records (file-backed in production). */
export interface HerdrTabStateStore {
	load(identity: HerdrOwnershipIdentity): Promise<HerdrTabStateRecord | undefined>;
	save(record: HerdrTabStateRecord): Promise<void>;
	remove(identity: HerdrOwnershipIdentity): Promise<void>;
}

/** Per-acquire intent. Retention is a per-dispatch user choice. */
export interface HerdrAcquireOptions {
	/** Defaults to `"failed"`: recycle success, retain failures/aborts. */
	retention?: HerdrRetention;
	/** Stable key for a sequential chain; steps sharing it reuse one pane. */
	chainKey?: string;
	/** Override the pane label (defaults to `<agent> · <short-run-id>`). */
	label?: string;
}

/** A leased pane handed to one run. */
export interface HerdrPaneLease {
	readonly tabId: string;
	readonly paneId: string;
	readonly runId: string;
	/** True once the lease settled with retention. */
	readonly retained: boolean;
	release(outcome: HerdrLeaseOutcome): Promise<void>;
}

/** The parent-owned tab surface used by the backend and manager UI. */
export interface ParentHerdrTab {
	ensureTab(): Promise<string>;
	acquire(run: PreparedDispatchItem, options?: HerdrAcquireOptions): Promise<HerdrPaneLease>;
	focus(runId: string): Promise<void>;
	dispose(options?: { reason?: HerdrDisposeReason }): Promise<void>;
}

/** Ownership/lifecycle failure with a machine-readable code. */
export class HerdrTabError extends Error {
	readonly code: string;

	constructor(message: string, options: { code: string }) {
		super(message);
		this.name = "HerdrTabError";
		this.code = options.code;
	}
}

export interface HerdrTabManagerOptions {
	client: HerdrClient;
	/** Defaults to `client.environment` + `PI_SESSION_ID` from `env`. */
	identity?: HerdrOwnershipIdentity;
	/** Defaults to `process.env.PI_SESSION_ID`. Required when identity is absent. */
	piSessionId?: string;
	store?: HerdrTabStateStore;
	label?: string;
	now?: () => number;
	logger?: (message: string) => void;
}

/** Build the ownership identity from a Herdr environment and Pi session ID. */
export function herdrOwnershipIdentity(environment: HerdrEnvironment, piSessionId: string): HerdrOwnershipIdentity {
	return {
		socketPath: environment.socketPath,
		parentPaneId: environment.paneId,
		piSessionId,
	};
}

/** Short, stable, filesystem-safe key for an ownership identity. */
export function herdrOwnershipKey(identity: HerdrOwnershipIdentity): string {
	return createHash("sha256")
		.update(`${identity.socketPath}\u0000${identity.parentPaneId}\u0000${identity.piSessionId}`)
		.digest("hex")
		.slice(0, 32);
}

/** Human-readable tab label: `Subagents · <short-pane> · <short-session>`. */
export function herdrTabLabel(identity: HerdrOwnershipIdentity): string {
	return `Subagents · ${shortPaneId(identity.parentPaneId)} · ${shortSessionId(identity.piSessionId)}`;
}

/** `worker · sa-abc123` style pane label. */
export function herdrPaneLabel(agent: string, runId: string): string {
	return `${agent} · ${shortRunId(runId)}`;
}

function shortPaneId(paneId: string): string {
	const index = paneId.lastIndexOf(":");
	return index >= 0 ? paneId.slice(index + 1) : paneId;
}

function shortSessionId(sessionId: string): string {
	return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

function shortRunId(runId: string): string {
	const parts = runId.split("-");
	if (parts.length >= 2 && parts[0].length > 0 && parts[1].length > 0) return `${parts[0]}-${parts[1]}`;
	return runId.length > 12 ? runId.slice(0, 12) : runId;
}

/** Default state directory under Pi's agent directory. */
export function resolveHerdrTabStateDirectory(agentDir: string): string {
	return join(agentDir, "state", "herdr-tabs");
}

/**
 * Build a manager with the default file-backed state store. Stage 4 calls this
 * with `getAgentDir()`; the module itself stays free of Pi runtime imports.
 */
export function createParentHerdrTab(options: {
	client: HerdrClient;
	agentDir: string;
	piSessionId?: string;
	store?: HerdrTabStateStore;
	label?: string;
	now?: () => number;
	logger?: (message: string) => void;
}): HerdrTabManager {
	return new HerdrTabManager({
		client: options.client,
		store: options.store ?? createFileHerdrTabStateStore({ directory: resolveHerdrTabStateDirectory(options.agentDir) }),
		...(options.piSessionId ? { piSessionId: options.piSessionId } : {}),
		...(options.label ? { label: options.label } : {}),
		...(options.now ? { now: options.now } : {}),
		...(options.logger ? { logger: options.logger } : {}),
	});
}

/** File-backed ownership store. Records are written `0600` inside a `0700` dir. */
export function createFileHerdrTabStateStore(options: { directory: string }): HerdrTabStateStore {
	const directory = options.directory;
	const fileFor = (identity: HerdrOwnershipIdentity): string => join(directory, `${herdrOwnershipKey(identity)}.json`);

	return {
		async load(identity) {
			let raw: string;
			try {
				raw = await readFile(fileFor(identity), "utf8");
			} catch {
				return undefined;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return undefined;
			}
			return parseStateRecord(parsed, identity);
		},
		async save(record) {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const file = fileFor(record);
			const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
			await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
			await rename(temp, file);
		},
		async remove(identity) {
			await rm(fileFor(identity), { force: true });
		},
	};
}

function parseStateRecord(value: unknown, identity: HerdrOwnershipIdentity): HerdrTabStateRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.version !== 1) return undefined;
	if (record.ownershipKey !== herdrOwnershipKey(identity)) return undefined;
	if (record.socketPath !== identity.socketPath) return undefined;
	if (record.parentPaneId !== identity.parentPaneId) return undefined;
	if (record.piSessionId !== identity.piSessionId) return undefined;
	if (typeof record.tabId !== "string" || typeof record.rootPaneId !== "string" || typeof record.label !== "string") {
		return undefined;
	}
	const retainedPaneIds = Array.isArray(record.retainedPaneIds)
		? record.retainedPaneIds.filter((id): id is string => typeof id === "string")
		: [];
	const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : 0;
	return {
		version: 1,
		ownershipKey: record.ownershipKey,
		socketPath: record.socketPath,
		parentPaneId: record.parentPaneId,
		piSessionId: record.piSessionId,
		tabId: record.tabId,
		rootPaneId: record.rootPaneId,
		label: record.label,
		retainedPaneIds,
		updatedAt,
	};
}

interface ActiveLease {
	runId: string;
	paneId: string;
	chainKey?: string;
	retention: HerdrRetention;
	released: boolean;
	retained: boolean;
}

interface SplitTarget {
	paneId: string;
	rect: HerdrPaneRect;
}

/**
 * Parent-scoped Herdr tab/pane manager. All allocation and release work is
 * serialized through a promise queue so concurrent dispatches cannot race on
 * the same idle pane or split the same leaf twice.
 */
export class HerdrTabManager implements ParentHerdrTab {
	private readonly client: HerdrClient;
	private readonly identity: HerdrOwnershipIdentity;
	private readonly ownershipKey: string;
	private readonly label: string;
	private readonly store: HerdrTabStateStore | undefined;
	private readonly now: () => number;
	private readonly logger: ((message: string) => void) | undefined;

	private tabId: string | undefined;
	private rootPaneId: string | undefined;
	private createdThisSession = false;
	private disposed = false;
	private queue: Promise<void> = Promise.resolve();

	private readonly activeLeases = new Map<string, ActiveLease>();
	private readonly locations = new Map<string, HerdrRunLocation>();
	private readonly retainedPanes = new Set<string>();
	private readonly trackedPaneIds = new Set<string>();
	private readonly panesInUse = new Set<string>();
	private idlePaneId: string | undefined;
	private idleChainKey: string | undefined;
	private allocationCounter = 0;

	constructor(options: HerdrTabManagerOptions) {
		this.client = options.client;
		const piSessionId = options.piSessionId ?? process.env.PI_SESSION_ID;
		if (!options.identity && !piSessionId) {
			throw new HerdrTabError("Cannot own a Herdr tab without PI_SESSION_ID", { code: "missing_session_id" });
		}
		this.identity = options.identity ?? herdrOwnershipIdentity(options.client.environment, piSessionId as string);
		this.ownershipKey = herdrOwnershipKey(this.identity);
		this.label = options.label ?? herdrTabLabel(this.identity);
		this.store = options.store;
		this.now = options.now ?? Date.now;
		this.logger = options.logger;
	}

	/** Current tab id once `ensureTab()` has run, for diagnostics and tests. */
	get currentTabId(): string | undefined {
		return this.tabId;
	}

	/** Root pane id once `ensureTab()` has run. */
	get currentRootPaneId(): string | undefined {
		return this.rootPaneId;
	}

	/** The single idle pane, if any. */
	get currentIdlePaneId(): string | undefined {
		return this.idlePaneId;
	}

	/** Retained pane ids, never reused automatically. */
	get retainedPaneIds(): readonly string[] {
		return [...this.retainedPanes];
	}

	/** Live location for a run, whether active or retained. */
	locationForRun(runId: string): HerdrRunLocation | undefined {
		const location = this.locations.get(runId);
		return location ? { ...location } : undefined;
	}

	ensureTab(): Promise<string> {
		return this.runExclusive(() => this.ensureTabLocked());
	}

	acquire(run: PreparedDispatchItem, options: HerdrAcquireOptions = {}): Promise<HerdrPaneLease> {
		return this.runExclusive(() => this.acquireLocked(run, options));
	}

	focus(runId: string): Promise<void> {
		return this.runExclusive(async () => {
			const location = this.locations.get(runId);
			if (!location) {
				throw new HerdrTabError(`No Herdr pane recorded for run ${runId}`, { code: "missing_location" });
			}
			await this.focusOwnedPane(location.paneId, location.tabId);
		});
	}

	/** Focus an exact owned pane (used by the manager UI in Stage 5). */
	focusPane(paneId: string): Promise<void> {
		return this.runExclusive(async () => {
			if (!this.tabId) throw new HerdrTabError("No Herdr tab has been created", { code: "missing_tab" });
			await this.focusOwnedPane(paneId, this.tabId);
		});
	}

	/** Close one explicitly retained pane. Returns false when it is not ours. */
	closeRetainedPane(paneId: string): Promise<boolean> {
		return this.runExclusive(async () => {
			if (!this.retainedPanes.has(paneId)) return false;
			if (!this.tabId) return false;
			let pane: HerdrPaneInfo;
			try {
				pane = await this.client.getPane(paneId);
			} catch {
				// Already closed manually; drop the stale record.
				this.retainedPanes.delete(paneId);
				this.trackedPaneIds.delete(paneId);
				await this.persistState();
				return true;
			}
			if (pane.tabId !== this.tabId || !this.isOwnedPane(pane)) return false;
			try {
				await this.client.closePane(paneId);
			} catch (error) {
				this.log(`failed to close retained pane ${paneId}: ${messageOf(error)}`);
				return false;
			}
			this.retainedPanes.delete(paneId);
			this.trackedPaneIds.delete(paneId);
			for (const [runId, location] of [...this.locations]) {
				if (location.paneId === paneId) this.locations.delete(runId);
			}
			await this.persistState();
			return true;
		});
	}

	dispose(options: { reason?: HerdrDisposeReason } = {}): Promise<void> {
		return this.runExclusive(async () => {
			if (this.disposed) return;
			this.disposed = true;
			const reason = options.reason ?? "manual";

			// `/reload` keeps the tab so the same session can rediscover it.
			if (reason === "reload") {
				await this.persistState();
				return;
			}
			if (!this.tabId) return;

			// Retained panes are the user's evidence; leave the tab in Herdr.
			if (this.retainedPanes.size > 0) {
				await this.persistState();
				return;
			}

			if (!(await this.verifyOwnershipForClose())) {
				this.log(`refusing to close tab ${this.tabId}: ownership not verified`);
				await this.store?.remove(this.identity);
				return;
			}

			try {
				await this.client.closeTab(this.tabId);
			} catch (error) {
				this.log(`failed to close owned tab ${this.tabId}: ${messageOf(error)}`);
			} finally {
				await this.store?.remove(this.identity);
				this.tabId = undefined;
				this.rootPaneId = undefined;
			}
		});
	}

	private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private assertNotDisposed(): void {
		if (this.disposed) throw new HerdrTabError("Herdr tab manager has been disposed", { code: "disposed" });
	}

	private async ensureTabLocked(): Promise<string> {
		this.assertNotDisposed();
		if (this.tabId && this.rootPaneId) {
			if (await this.validateCurrentTab()) return this.tabId;
			this.tabId = undefined;
			this.rootPaneId = undefined;
		}

		const adopted = await this.tryAdoptStoredTab();
		if (adopted) return adopted;

		const created = await this.client.createTab({ label: this.label, focus: false });
		this.tabId = created.tab.tabId;
		this.rootPaneId = created.rootPane.paneId;
		this.createdThisSession = true;
		this.trackedPaneIds.add(created.rootPane.paneId);
		await this.markPaneMetadata(created.rootPane.paneId, { runId: undefined, retained: false, title: this.label });
		await this.persistState();
		return this.tabId;
	}

	private async validateCurrentTab(): Promise<boolean> {
		if (!this.tabId) return false;
		try {
			const tab = await this.client.getTab(this.tabId);
			if (tab.workspaceId !== this.client.environment.workspaceId) return false;
		} catch {
			return false;
		}
		const owned = await this.findOwnedTab(this.tabId, this.rootPaneId);
		if (owned) {
			this.rootPaneId = owned.rootPaneId;
			return true;
		}
		// Metadata may be unavailable; keep the tab while a tracked pane is alive.
		if (this.rootPaneId && (await this.paneAlive(this.rootPaneId))) return true;
		return false;
	}

	private async tryAdoptStoredTab(): Promise<string | undefined> {
		if (!this.store) return undefined;
		const record = await this.store.load(this.identity).catch(() => undefined);
		if (!record) return undefined;
		if (record.ownershipKey !== this.ownershipKey) {
			await this.store.remove(this.identity).catch(() => undefined);
			return undefined;
		}

		const found = await this.findOwnedTab(record.tabId, record.rootPaneId);
		if (found) {
			this.tabId = found.tabId;
			this.rootPaneId = found.rootPaneId;
			await this.adoptExistingPanes(found.tabId, record);
			await this.markPaneMetadata(found.rootPaneId, { runId: undefined, retained: false, title: this.label });
			await this.persistState();
			return this.tabId;
		}

		// Metadata unavailable: fall back to the exact persisted record + label.
		try {
			const tab = await this.client.getTab(record.tabId);
			if (tab.workspaceId === this.client.environment.workspaceId && tab.label === record.label) {
				this.tabId = record.tabId;
				this.rootPaneId = record.rootPaneId;
				await this.adoptExistingPanes(record.tabId, record);
				await this.markPaneMetadata(record.rootPaneId, { runId: undefined, retained: false, title: this.label });
				await this.persistState();
				return this.tabId;
			}
		} catch {
			// Missing tab; fall through to a fresh create.
		}
		await this.store.remove(this.identity).catch(() => undefined);
		return undefined;
	}

	private async adoptExistingPanes(tabId: string, record: HerdrTabStateRecord): Promise<void> {
		const recordedRetained = new Set(record.retainedPaneIds);
		let panes: HerdrPaneInfo[] = [];
		try {
			panes = (await this.client.listPanes(this.client.environment.workspaceId)).filter(
				(pane) => pane.tabId === tabId && this.isOwnedPane(pane),
			);
		} catch {
			panes = [];
		}
		for (const pane of panes) {
			this.trackedPaneIds.add(pane.paneId);
			if (pane.tokens?.px_retained === "1" || recordedRetained.has(pane.paneId)) {
				this.retainedPanes.add(pane.paneId);
			}
		}
		const idle = panes.find((pane) => !this.retainedPanes.has(pane.paneId));
		if (idle) this.idlePaneId = idle.paneId;
	}

	private async acquireLocked(run: PreparedDispatchItem, options: HerdrAcquireOptions): Promise<HerdrPaneLease> {
		this.assertNotDisposed();
		const retention = options.retention ?? "failed";
		await this.ensureTabLocked();
		const paneId = await this.allocatePaneLocked(options.chainKey);
		this.panesInUse.add(paneId);
		this.trackedPaneIds.add(paneId);
		await this.renamePane(paneId, options.label ?? herdrPaneLabel(run.agent, run.runId));
		await this.markPaneMetadata(paneId, { runId: run.runId, retained: false });

		const tabId = this.tabId as string;
		const location: HerdrRunLocation = { tabId, paneId, retained: false };
		this.locations.set(run.runId, location);
		const state: ActiveLease = {
			runId: run.runId,
			paneId,
			...(options.chainKey ? { chainKey: options.chainKey } : {}),
			retention,
			released: false,
			retained: false,
		};
		this.activeLeases.set(run.runId, state);

		const lease: HerdrPaneLease = {
			tabId,
			paneId,
			runId: run.runId,
			get retained() {
				return state.retained;
			},
			release: (outcome) => this.releaseLease(state, outcome),
		};
		return lease;
	}

	private releaseLease(state: ActiveLease, outcome: HerdrLeaseOutcome): Promise<void> {
		return this.runExclusive(async () => {
			if (state.released) return;
			state.released = true;
			this.activeLeases.delete(state.runId);
			this.panesInUse.delete(state.paneId);
			const retain = state.retention === "always" || outcome !== "success";
			state.retained = retain;

			const location = this.locations.get(state.runId);
			if (location) location.retained = retain;

			if (retain) {
				this.retainedPanes.add(state.paneId);
				await this.markPaneMetadata(state.paneId, { runId: state.runId, retained: true });
				await this.persistState();
				return;
			}

			// Recycled panes can be leased by another run, so drop the stale location.
			this.locations.delete(state.runId);
			this.retainedPanes.delete(state.paneId);
			await this.markPaneMetadata(state.paneId, { runId: state.runId, retained: false });
			await this.returnToIdleLocked(state.paneId, state.chainKey);
			await this.persistState();
		});
	}

	private async allocatePaneLocked(chainKey?: string): Promise<string> {
		// 1. Reuse the single idle pane, respecting chain affinity.
		if (this.idlePaneId) {
			const idle = this.idlePaneId;
			const affinity = this.idleChainKey;
			const affinityOk = !chainKey || affinity === undefined || affinity === chainKey;
			if (affinityOk) {
				this.idlePaneId = undefined;
				this.idleChainKey = undefined;
				if (await this.paneAlive(idle)) return idle;
			}
		}

		// 2. First run uses the tab's root pane when it is free (and not an idle
		// pane already reserved for a different chain).
		if (
			this.rootPaneId &&
			this.idlePaneId !== this.rootPaneId &&
			!this.panesInUse.has(this.rootPaneId) &&
			!this.retainedPanes.has(this.rootPaneId) &&
			(await this.paneAlive(this.rootPaneId))
		) {
			return this.rootPaneId;
		}

		// 3. Split the best available leaf.
		const target = await this.chooseSplitTarget();
		const direction = this.chooseSplitDirection(target);
		const created = await this.client.splitPane({
			targetPaneId: target.paneId,
			direction,
			ratio: 0.5,
			focus: false,
		});
		this.allocationCounter += 1;
		return created.paneId;
	}

	private async chooseSplitTarget(): Promise<SplitTarget> {
		const live = await this.liveOwnedPanes();
		if (live.length === 0) {
			throw new HerdrTabError("Owned Herdr tab has no live panes", { code: "missing_tab" });
		}

		let geometry: Map<string, HerdrPaneRect> | undefined;
		try {
			const snapshot = await this.client.getPaneLayout(live[0].paneId);
			geometry = new Map(snapshot.panes.map((pane) => [pane.paneId, pane.rect]));
		} catch {
			geometry = undefined;
		}

		const candidates: SplitTarget[] = live.map((pane) => ({
			paneId: pane.paneId,
			rect: geometry?.get(pane.paneId) ?? { x: 0, y: 0, width: 1, height: 1 },
		}));
		const nonRetained = candidates.filter((candidate) => !this.retainedPanes.has(candidate.paneId));
		const pool = nonRetained.length > 0 ? nonRetained : candidates;
		pool.sort((a, b) => area(b.rect) - area(a.rect));
		return pool[0];
	}

	private chooseSplitDirection(target: SplitTarget): "right" | "down" {
		const { width, height } = target.rect;
		if (width === 1 && height === 1) {
			// No geometry available; alternate so we never build one long column.
			return this.allocationCounter % 2 === 0 ? "right" : "down";
		}
		// Split along the longer axis, and prefer a downward split on square
		// panes so concurrent work does not form a row of narrow columns.
		return width > height ? "right" : "down";
	}

	private async returnToIdleLocked(paneId: string, chainKey?: string): Promise<void> {
		if (!(await this.paneAlive(paneId))) {
			if (this.idlePaneId === paneId) {
				this.idlePaneId = undefined;
				this.idleChainKey = undefined;
			}
			this.trackedPaneIds.delete(paneId);
			return;
		}

		if (this.idlePaneId && this.idlePaneId !== paneId) {
			const keep = this.preferIdle(this.idlePaneId, paneId);
			const close = keep === this.idlePaneId ? paneId : this.idlePaneId;
			this.idlePaneId = keep;
			this.idleChainKey = keep === paneId ? chainKey : this.idleChainKey;
			await this.safeClosePane(close);
			return;
		}
		this.idlePaneId = paneId;
		this.idleChainKey = chainKey;
	}

	private preferIdle(existing: string, candidate: string): string {
		if (existing === this.rootPaneId) return existing;
		if (candidate === this.rootPaneId) return candidate;
		return existing;
	}

	private async liveOwnedPanes(): Promise<HerdrPaneInfo[]> {
		if (!this.tabId) return [];
		try {
			const panes = await this.client.listPanes(this.client.environment.workspaceId);
			return panes.filter((pane) => pane.tabId === this.tabId && this.isOwnedPane(pane));
		} catch {
			return [];
		}
	}

	private async findOwnedTab(
		tabId: string,
		preferredRootPaneId?: string,
	): Promise<{ tabId: string; rootPaneId: string } | undefined> {
		try {
			const tab = await this.client.getTab(tabId);
			if (tab.workspaceId !== this.client.environment.workspaceId) return undefined;
		} catch {
			return undefined;
		}
		let panes: HerdrPaneInfo[];
		try {
			panes = await this.client.listPanes(this.client.environment.workspaceId);
		} catch {
			return undefined;
		}
		const owned = panes.filter((pane) => pane.tabId === tabId && this.isOwnedPane(pane));
		if (owned.length === 0) return undefined;
		const root =
			(preferredRootPaneId && owned.find((pane) => pane.paneId === preferredRootPaneId)) ?? owned[0];
		return { tabId, rootPaneId: root.paneId };
	}

	private isOwnedPane(pane: HerdrPaneInfo): boolean {
		if (pane.tokens?.px_owner === this.ownershipKey && pane.tokens?.px_tab === pane.tabId) return true;
		return pane.tabId === this.tabId && this.trackedPaneIds.has(pane.paneId);
	}

	private async paneAlive(paneId: string): Promise<boolean> {
		try {
			const pane = await this.client.getPane(paneId);
			return pane.tabId === this.tabId;
		} catch {
			return false;
		}
	}

	private async focusOwnedPane(paneId: string, tabId: string): Promise<void> {
		let pane: HerdrPaneInfo;
		try {
			pane = await this.client.getPane(paneId);
		} catch {
			throw new HerdrTabError(`Herdr pane ${paneId} no longer exists`, { code: "missing_pane" });
		}
		if (pane.tabId !== tabId || !this.isOwnedPane(pane)) {
			throw new HerdrTabError(`Herdr pane ${paneId} is not owned by this parent tab`, { code: "not_owned" });
		}
		await this.client.focusPane(paneId);
	}

	private async verifyOwnershipForClose(): Promise<boolean> {
		if (!this.tabId) return false;
		try {
			const tab = await this.client.getTab(this.tabId);
			if (tab.workspaceId !== this.client.environment.workspaceId) return false;
		} catch {
			return false;
		}
		if (this.createdThisSession) return true;
		// Adopted tab: require a live ownership token, not just in-memory tracking.
		try {
			const panes = await this.client.listPanes(this.client.environment.workspaceId);
			return panes.some(
				(pane) =>
					pane.tabId === this.tabId &&
					pane.tokens?.px_owner === this.ownershipKey &&
					pane.tokens?.px_tab === pane.tabId,
			);
		} catch {
			return false;
		}
	}

	private async renamePane(paneId: string, label: string): Promise<void> {
		try {
			await this.client.renamePane(paneId, label);
		} catch (error) {
			this.log(`failed to rename pane ${paneId}: ${messageOf(error)}`);
		}
	}

	private async markPaneMetadata(
		paneId: string,
		options: { runId: string | undefined; retained: boolean; title?: string },
	): Promise<void> {
		const tabId = this.tabId;
		if (!tabId) return;
		const tokens: Record<string, string> = {
			px_owner: this.ownershipKey,
			px_tab: tabId,
			px_retained: options.retained ? "1" : "0",
		};
		if (options.runId) tokens.px_run = options.runId;
		try {
			await this.client.reportPaneMetadata(paneId, "px-subagent-tab", {
				...(options.title ? { title: options.title } : {}),
				tokens,
			});
		} catch (error) {
			this.log(`failed to mark pane ${paneId} metadata: ${messageOf(error)}`);
		}
	}

	private async safeClosePane(paneId: string): Promise<void> {
		let pane: HerdrPaneInfo;
		try {
			pane = await this.client.getPane(paneId);
		} catch {
			this.trackedPaneIds.delete(paneId);
			return;
		}
		if (pane.tabId !== this.tabId || !this.isOwnedPane(pane)) {
			this.log(`refusing to close unowned pane ${paneId}`);
			return;
		}
		try {
			await this.client.closePane(paneId);
		} catch (error) {
			this.log(`failed to close idle pane ${paneId}: ${messageOf(error)}`);
		} finally {
			this.trackedPaneIds.delete(paneId);
		}
	}

	private async persistState(): Promise<void> {
		if (!this.store || !this.tabId || !this.rootPaneId) return;
		const record: HerdrTabStateRecord = {
			version: 1,
			ownershipKey: this.ownershipKey,
			socketPath: this.identity.socketPath,
			parentPaneId: this.identity.parentPaneId,
			piSessionId: this.identity.piSessionId,
			tabId: this.tabId,
			rootPaneId: this.rootPaneId,
			label: this.label,
			retainedPaneIds: [...this.retainedPanes],
			updatedAt: this.now(),
		};
		try {
			await this.store.save(record);
		} catch (error) {
			this.log(`failed to persist Herdr tab state: ${messageOf(error)}`);
		}
	}

	private log(message: string): void {
		this.logger?.(message);
	}
}

function area(rect: HerdrPaneRect): number {
	return rect.width * rect.height;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
