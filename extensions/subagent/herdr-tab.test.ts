/**
 * Stage 3 tests for the parent-owned Herdr tab and pane lifecycle.
 *
 * A fake `HerdrClient` simulates tabs, panes, rectangles, labels, and
 * ownership tokens in memory, so allocation, pooling, retention, reload, and
 * cleanup behavior are exercised deterministically without a live Herdr server.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HerdrApiError,
	type HerdrClient,
	type HerdrCreateTabOptions,
	type HerdrEnvironment,
	type HerdrPaneInfo,
	type HerdrPaneLayoutSnapshot,
	type HerdrPaneMetadata,
	type HerdrPaneRead,
	type HerdrReadPaneOptions,
	type HerdrSplitPaneOptions,
	type HerdrTabInfo,
} from "./herdr-client.ts";
import {
	HerdrTabError,
	HerdrTabManager,
	createFileHerdrTabStateStore,
	createParentHerdrTab,
	herdrOwnershipIdentity,
	herdrOwnershipKey,
	herdrPaneLabel,
	herdrTabLabel,
	resolveHerdrTabStateDirectory,
	type HerdrOwnershipIdentity,
} from "./herdr-tab.ts";
import type { PreparedDispatchItem } from "./types.ts";

const WORKSPACE = "w1A";
const PARENT_PANE = "w1A:p1C";
const SESSION = "session-aaaaaaaa";

const baseEnv: HerdrEnvironment = {
	socketPath: "/tmp/herdr.sock",
	paneId: PARENT_PANE,
	workspaceId: WORKSPACE,
};

interface FakePane {
	paneId: string;
	terminalId: string;
	workspaceId: string;
	tabId: string;
	focused: boolean;
	agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
	revision: number;
	label?: string;
	title?: string;
	tokens?: Record<string, string>;
	rect: { x: number; y: number; width: number; height: number };
}

interface FakeTab {
	tabId: string;
	workspaceId: string;
	number: number;
	label: string;
	focused: boolean;
	agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
	panes: string[];
}

interface Call {
	method: string;
	params: Record<string, unknown>;
}

/** In-memory HerdrClient with real-ish geometry so balanced splitting is testable. */
class FakeHerdrClient implements HerdrClient {
	readonly environment: HerdrEnvironment;
	readonly calls: Call[] = [];
	failReportMetadata = false;
	failGetLayout = false;
	private readonly tabs = new Map<string, FakeTab>();
	private readonly panes = new Map<string, FakePane>();
	private tabCounter = 0;
	private paneCounter = 0;

	constructor(environment: HerdrEnvironment = baseEnv) {
		this.environment = environment;
	}

	private record(method: string, params: Record<string, unknown> = {}): void {
		this.calls.push({ method, params });
	}

	callCount(method: string): number {
		return this.calls.filter((call) => call.method === method).length;
	}

	tabCount(): number {
		return this.tabs.size;
	}

	alivePaneCount(tabId?: string): number {
		return [...this.panes.values()].filter((pane) => !tabId || pane.tabId === tabId).length;
	}

	pane(paneId: string): FakePane | undefined {
		return this.panes.get(paneId);
	}

	tab(tabId: string): FakeTab | undefined {
		return this.tabs.get(tabId);
	}

	/** Simulate a user closing a pane behind the manager's back. */
	forceClosePane(paneId: string): void {
		const pane = this.panes.get(paneId);
		if (!pane) return;
		this.panes.delete(paneId);
		const tab = this.tabs.get(pane.tabId);
		if (tab) {
			tab.panes = tab.panes.filter((id) => id !== paneId);
			if (tab.panes.length === 0) this.tabs.delete(tab.tabId);
		}
	}

	/** Simulate another owner writing tokens on a pane. */
	forceOwnership(paneId: string, tokens: Record<string, string> | undefined): void {
		const pane = this.panes.get(paneId);
		if (pane) pane.tokens = tokens;
	}

	async ping() {
		return { version: "0.9.1", protocol: 22 };
	}

	async assertCompatible() {
		return this.ping();
	}

	async listTabs(workspaceId?: string): Promise<HerdrTabInfo[]> {
		this.record("tab.list", { workspace_id: workspaceId ?? this.environment.workspaceId });
		return [...this.tabs.values()]
			.filter((tab) => tab.workspaceId === (workspaceId ?? this.environment.workspaceId))
			.map((tab) => this.tabInfo(tab));
	}

	async getTab(tabId: string): Promise<HerdrTabInfo> {
		this.record("tab.get", { tab_id: tabId });
		const tab = this.tabs.get(tabId);
		if (!tab) throw new HerdrApiError(`tab not found: ${tabId}`, { code: "not_found", method: "tab.get" });
		return this.tabInfo(tab);
	}

	async createTab(options: HerdrCreateTabOptions = {}) {
		this.record("tab.create", { workspace_id: options.workspaceId ?? WORKSPACE, focus: options.focus ?? false });
		this.tabCounter += 1;
		const tabId = `${WORKSPACE}:t${this.tabCounter}`;
		const paneId = `${WORKSPACE}:p${++this.paneCounter}`;
		const tab: FakeTab = {
			tabId,
			workspaceId: options.workspaceId ?? WORKSPACE,
			number: this.tabCounter,
			label: options.label ?? "",
			focused: options.focus ?? false,
			agentStatus: "idle",
			panes: [paneId],
		};
		this.tabs.set(tabId, tab);
		const pane: FakePane = {
			paneId,
			terminalId: `term_${this.paneCounter}`,
			workspaceId: tab.workspaceId,
			tabId,
			focused: options.focus ?? false,
			agentStatus: "idle",
			revision: 1,
			rect: { x: 0, y: 0, width: 80, height: 24 },
		};
		this.panes.set(paneId, pane);
		return { tab: this.tabInfo(tab), rootPane: this.paneInfo(pane) };
	}

	async renameTab(tabId: string, label: string): Promise<HerdrTabInfo> {
		this.record("tab.rename", { tab_id: tabId, label });
		const tab = this.tabs.get(tabId);
		if (!tab) throw new HerdrApiError("missing tab", { code: "not_found", method: "tab.rename" });
		tab.label = label;
		return this.tabInfo(tab);
	}

	async focusTab(tabId: string): Promise<HerdrTabInfo> {
		this.record("tab.focus", { tab_id: tabId });
		const tab = this.tabs.get(tabId);
		if (!tab) throw new HerdrApiError("missing tab", { code: "not_found", method: "tab.focus" });
		return this.tabInfo(tab);
	}

	async closeTab(tabId: string): Promise<void> {
		this.record("tab.close", { tab_id: tabId });
		const tab = this.tabs.get(tabId);
		if (!tab) throw new HerdrApiError("missing tab", { code: "not_found", method: "tab.close" });
		for (const paneId of tab.panes) this.panes.delete(paneId);
		this.tabs.delete(tabId);
	}

	async listPanes(workspaceId?: string): Promise<HerdrPaneInfo[]> {
		this.record("pane.list", { workspace_id: workspaceId ?? this.environment.workspaceId });
		return [...this.panes.values()]
			.filter((pane) => pane.workspaceId === (workspaceId ?? this.environment.workspaceId))
			.map((pane) => this.paneInfo(pane));
	}

	async getPane(paneId: string): Promise<HerdrPaneInfo> {
		this.record("pane.get", { pane_id: paneId });
		const pane = this.panes.get(paneId);
		if (!pane) throw new HerdrApiError(`pane not found: ${paneId}`, { code: "not_found", method: "pane.get" });
		return this.paneInfo(pane);
	}

	async splitPane(options: HerdrSplitPaneOptions): Promise<HerdrPaneInfo> {
		this.record("pane.split", {
			target_pane_id: options.targetPaneId,
			direction: options.direction,
			focus: options.focus ?? false,
			ratio: options.ratio ?? null,
		});
		const target = this.panes.get(options.targetPaneId);
		if (!target) throw new HerdrApiError("missing target", { code: "not_found", method: "pane.split" });
		const tab = this.tabs.get(target.tabId);
		if (!tab) throw new HerdrApiError("missing tab", { code: "not_found", method: "pane.split" });
		const ratio = options.ratio ?? 0.5;
		const newRect = { ...target.rect };
		if (options.direction === "right") {
			const leftWidth = Math.max(1, Math.floor(target.rect.width * ratio));
			const rightWidth = Math.max(1, target.rect.width - leftWidth);
			target.rect = { ...target.rect, width: leftWidth };
			newRect.x = target.rect.x + leftWidth;
			newRect.width = rightWidth;
		} else {
			const topHeight = Math.max(1, Math.floor(target.rect.height * ratio));
			const bottomHeight = Math.max(1, target.rect.height - topHeight);
			target.rect = { ...target.rect, height: topHeight };
			newRect.y = target.rect.y + topHeight;
			newRect.height = bottomHeight;
		}
		const paneId = `${WORKSPACE}:p${++this.paneCounter}`;
		const pane: FakePane = {
			paneId,
			terminalId: `term_${this.paneCounter}`,
			workspaceId: tab.workspaceId,
			tabId: tab.tabId,
			focused: options.focus ?? false,
			agentStatus: "idle",
			revision: 1,
			rect: newRect,
		};
		this.panes.set(paneId, pane);
		tab.panes.push(paneId);
		return this.paneInfo(pane);
	}

	async renamePane(paneId: string, label: string): Promise<HerdrPaneInfo> {
		this.record("pane.rename", { pane_id: paneId, label });
		const pane = this.panes.get(paneId);
		if (!pane) throw new HerdrApiError("missing pane", { code: "not_found", method: "pane.rename" });
		pane.label = label;
		return this.paneInfo(pane);
	}

	async closePane(paneId: string): Promise<void> {
		this.record("pane.close", { pane_id: paneId });
		const pane = this.panes.get(paneId);
		if (!pane) throw new HerdrApiError("missing pane", { code: "not_found", method: "pane.close" });
		this.forceClosePane(paneId);
	}

	async focusPane(paneId: string): Promise<HerdrPaneInfo> {
		this.record("pane.focus", { pane_id: paneId });
		const pane = this.panes.get(paneId);
		if (!pane) throw new HerdrApiError("missing pane", { code: "not_found", method: "pane.focus" });
		for (const other of this.panes.values()) {
			if (other.tabId === pane.tabId) other.focused = other.paneId === paneId;
		}
		return this.paneInfo(pane);
	}

	async focusPaneDirection(paneId: string, direction: "left" | "right" | "up" | "down") {
		this.record("pane.focus_direction", { pane_id: paneId, direction });
		return { changed: false, sourcePaneId: paneId };
	}

	async sendText(paneId: string, text: string): Promise<void> {
		this.record("pane.send_text", { pane_id: paneId, text });
	}

	async sendKeys(paneId: string, keys: string[]): Promise<void> {
		this.record("pane.send_keys", { pane_id: paneId, keys });
	}

	async sendInput(paneId: string, input: { text?: string; keys?: string[] }): Promise<void> {
		this.record("pane.send_input", { pane_id: paneId, ...input });
	}

	async readPane(options: HerdrReadPaneOptions): Promise<HerdrPaneRead> {
		this.record("pane.read", { pane_id: options.paneId });
		const pane = this.panes.get(options.paneId);
		if (!pane) throw new HerdrApiError("missing pane", { code: "not_found", method: "pane.read" });
		return {
			paneId: pane.paneId,
			workspaceId: pane.workspaceId,
			tabId: pane.tabId,
			source: "recent_unwrapped",
			format: "text",
			text: "",
			revision: pane.revision,
			truncated: false,
		};
	}

	async getPaneLayout(paneId: string): Promise<HerdrPaneLayoutSnapshot> {
		this.record("pane.layout", { pane_id: paneId });
		if (this.failGetLayout) throw new HerdrApiError("layout unavailable", { code: "unsupported", method: "pane.layout" });
		const pane = this.panes.get(paneId);
		if (!pane) throw new HerdrApiError("missing pane", { code: "not_found", method: "pane.layout" });
		const tab = this.tabs.get(pane.tabId);
		if (!tab) throw new HerdrApiError("missing tab", { code: "not_found", method: "pane.layout" });
		return {
			workspaceId: tab.workspaceId,
			tabId: tab.tabId,
			zoomed: false,
			focusedPaneId: pane.paneId,
			area: { x: 0, y: 0, width: 80, height: 24 },
			panes: tab.panes.map((id) => {
				const entry = this.panes.get(id) as FakePane;
				return { paneId: id, focused: entry.focused, rect: { ...entry.rect } };
			}),
			splits: [],
		};
	}

	async reportPaneMetadata(paneId: string, source: string, metadata: HerdrPaneMetadata): Promise<void> {
		this.record("pane.report_metadata", { pane_id: paneId, source, ...metadata });
		if (this.failReportMetadata) {
			throw new HerdrApiError("metadata failed", { code: "internal", method: "pane.report_metadata" });
		}
		const pane = this.panes.get(paneId);
		if (!pane) throw new HerdrApiError("missing pane", { code: "not_found", method: "pane.report_metadata" });
		if (metadata.title !== undefined) pane.title = metadata.title;
		if (metadata.tokens) pane.tokens = { ...(pane.tokens ?? {}), ...metadata.tokens };
	}

	async clearPaneDisplayMetadata(paneId: string, source: string): Promise<void> {
		this.record("pane.clear_metadata", { pane_id: paneId, source });
		const pane = this.panes.get(paneId);
		if (pane) pane.title = undefined;
	}

	private tabInfo(tab: FakeTab): HerdrTabInfo {
		return {
			tabId: tab.tabId,
			workspaceId: tab.workspaceId,
			number: tab.number,
			label: tab.label,
			focused: tab.focused,
			paneCount: tab.panes.length,
			agentStatus: tab.agentStatus,
		};
	}

	private paneInfo(pane: FakePane): HerdrPaneInfo {
		return {
			paneId: pane.paneId,
			terminalId: pane.terminalId,
			workspaceId: pane.workspaceId,
			tabId: pane.tabId,
			focused: pane.focused,
			agentStatus: pane.agentStatus,
			revision: pane.revision,
			...(pane.label ? { label: pane.label } : {}),
			...(pane.title ? { title: pane.title } : {}),
			...(pane.tokens ? { tokens: pane.tokens } : {}),
		};
	}
}

function run(id: string, agent = "worker", task = "do it"): PreparedDispatchItem {
	return { runId: id, agent, task };
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "herdr-tab-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function manager(
	client: FakeHerdrClient,
	options: { session?: string; store?: ReturnType<typeof createFileHerdrTabStateStore> } = {},
): HerdrTabManager {
	return new HerdrTabManager({
		client,
		piSessionId: options.session ?? SESSION,
		...(options.store ? { store: options.store } : {}),
	});
}

describe("ownership helpers", () => {
	test("identity key and label are stable and parent/session scoped", () => {
		const identity = herdrOwnershipIdentity(baseEnv, SESSION);
		expect(herdrOwnershipKey(identity)).toBe(herdrOwnershipKey(herdrOwnershipIdentity(baseEnv, SESSION)));
		expect(herdrOwnershipKey(identity)).toHaveLength(32);
		expect(herdrTabLabel(identity)).toBe(`Subagents · p1C · ${SESSION.slice(0, 8)}`);
		expect(herdrPaneLabel("worker", "sa-abc123-1-deadbeef")).toBe("worker · sa-abc123");
	});

	test("identity key changes with socket, parent pane, and session", () => {
		const base = herdrOwnershipKey(herdrOwnershipIdentity(baseEnv, SESSION));
		expect(herdrOwnershipKey(herdrOwnershipIdentity({ ...baseEnv, socketPath: "/other" }, SESSION))).not.toBe(base);
		expect(herdrOwnershipKey(herdrOwnershipIdentity({ ...baseEnv, paneId: "w1A:pX" }, SESSION))).not.toBe(base);
		expect(herdrOwnershipKey(herdrOwnershipIdentity(baseEnv, "other"))).not.toBe(base);
	});

	test("resolveHerdrTabStateDirectory sits under the agent dir", () => {
		expect(resolveHerdrTabStateDirectory("/home/pi/.pi/agent")).toBe(
			join("/home/pi/.pi/agent", "state", "herdr-tabs"),
		);
	});
});

describe("file state store", () => {
	let dir: string;
	beforeEach(() => {
		dir = tempDir();
	});

	test("round-trips a record and removes it", async () => {
		const store = createFileHerdrTabStateStore({ directory: dir });
		const identity = herdrOwnershipIdentity(baseEnv, SESSION);
		const record = {
			version: 1 as const,
			ownershipKey: herdrOwnershipKey(identity),
			socketPath: identity.socketPath,
			parentPaneId: identity.parentPaneId,
			piSessionId: identity.piSessionId,
			tabId: "w1A:t1",
			rootPaneId: "w1A:p1",
			label: "Subagents · p1C · session-",
			retainedPaneIds: ["w1A:p2"],
			updatedAt: 5,
		};
		await store.save(record);
		expect(await store.load(identity)).toEqual(record);
		await store.remove(identity);
		expect(await store.load(identity)).toBeUndefined();
	});

	test("rejects a record for a different identity and malformed files", async () => {
		const store = createFileHerdrTabStateStore({ directory: dir });
		const identity = herdrOwnershipIdentity(baseEnv, SESSION);
		const other = herdrOwnershipIdentity(baseEnv, "other-session");
		await store.save({
			version: 1,
			ownershipKey: herdrOwnershipKey(other),
			socketPath: other.socketPath,
			parentPaneId: other.parentPaneId,
			piSessionId: other.piSessionId,
			tabId: "w1A:t1",
			rootPaneId: "w1A:p1",
			label: "x",
			retainedPaneIds: [],
			updatedAt: 0,
		});
		expect(await store.load(identity)).toBeUndefined();

		writeFileSync(join(dir, `${herdrOwnershipKey(identity)}.json`), "{ not json");
		expect(await store.load(identity)).toBeUndefined();
	});

	test("writes the record with restrictive permissions", async () => {
		const store = createFileHerdrTabStateStore({ directory: dir });
		const identity = herdrOwnershipIdentity(baseEnv, SESSION);
		await store.save({
			version: 1,
			ownershipKey: herdrOwnershipKey(identity),
			socketPath: identity.socketPath,
			parentPaneId: identity.parentPaneId,
			piSessionId: identity.piSessionId,
			tabId: "w1A:t1",
			rootPaneId: "w1A:p1",
			label: "x",
			retainedPaneIds: [],
			updatedAt: 0,
		});
		const raw = readFileSync(join(dir, `${herdrOwnershipKey(identity)}.json`), "utf8");
		expect(JSON.parse(raw).tabId).toBe("w1A:t1");
	});

	test("createParentHerdrTab wires the default state store", async () => {
		const agentDir = tempDir();
		const client = new FakeHerdrClient();
		const tab = createParentHerdrTab({ client, agentDir, piSessionId: SESSION });
		const lease = await tab.acquire(run("sa-1"));
		await lease.release("failed");
		await tab.dispose({ reason: "reload" });
		const reloaded = createParentHerdrTab({ client, agentDir, piSessionId: SESSION });
		await reloaded.ensureTab();
		expect(reloaded.currentTabId).toBe(tab.currentTabId);
	});
});

describe("HerdrTabManager tab lifecycle", () => {
	test("creates one tab lazily and reuses it for later dispatches", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		await tab.ensureTab();
		await tab.ensureTab();
		expect(client.callCount("tab.create")).toBe(1);
		expect(tab.currentTabId).toBeDefined();
	});

	test("the first run uses the tab root pane", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const lease = await tab.acquire(run("sa-1"));
		expect(lease.paneId).toBe(tab.currentRootPaneId);
		expect(client.callCount("pane.split")).toBe(0);
		await lease.release("success");
	});

	test("splits use --no-focus and label panes with agent and short run id", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const first = await tab.acquire(run("sa-abc123-1-x", "worker"));
		await tab.acquire(run("sa-def456-2-y", "reviewer"));
		const split = client.calls.find((call) => call.method === "pane.split");
		expect(split?.params.focus).toBe(false);
		expect(client.pane(first.paneId)?.label).toBe("worker · sa-abc123");
	});

	test("parallel acquires allocate distinct panes in one tab", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const leases = await Promise.all([
			tab.acquire(run("sa-1")),
			tab.acquire(run("sa-2")),
			tab.acquire(run("sa-3")),
		]);
		const paneIds = leases.map((lease) => lease.paneId);
		expect(new Set(paneIds).size).toBe(3);
		expect(client.callCount("tab.create")).toBe(1);
		for (const lease of leases) await lease.release("success");
	});

	test("balanced splits use both right and down as panes shrink", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const leases = [];
		for (let i = 0; i < 5; i++) leases.push(await tab.acquire(run(`sa-${i}`)));
		const directions = client.calls.filter((call) => call.method === "pane.split").map((call) => call.params.direction);
		expect(directions).toContain("right");
		expect(directions).toContain("down");
		for (const lease of leases) await lease.release("success");
	});

	test("chain steps reuse one pane sequentially", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const first = await tab.acquire(run("sa-chain-1"), { chainKey: "dispatch-1" });
		await first.release("success");
		const second = await tab.acquire(run("sa-chain-2"), { chainKey: "dispatch-1" });
		expect(second.paneId).toBe(first.paneId);
		await second.release("success");
		expect(client.callCount("pane.split")).toBe(0);
	});

	test("reports ownership tokens on the root pane and each lease", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const lease = await tab.acquire(run("sa-1"));
		const root = client.pane(tab.currentRootPaneId as string);
		const leased = client.pane(lease.paneId);
		expect(root?.tokens?.px_owner).toBe(herdrOwnershipKey(herdrOwnershipIdentity(baseEnv, SESSION)));
		expect(leased?.tokens?.px_run).toBe("sa-1");
		expect(leased?.tokens?.px_retained).toBe("0");
		await lease.release("success");
	});
});

describe("HerdrTabManager retention and pooling", () => {
	test("successful default panes recycle into the single idle pane", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const first = await tab.acquire(run("sa-1"));
		await first.release("success");
		expect(tab.retainedPaneIds).toEqual([]);
		expect(tab.currentIdlePaneId).toBe(first.paneId);
		const second = await tab.acquire(run("sa-2"));
		expect(second.paneId).toBe(first.paneId);
		await second.release("success");
	});

	test("failed default panes are retained and never reused", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const first = await tab.acquire(run("sa-1"));
		await first.release("failed");
		expect(tab.retainedPaneIds).toContain(first.paneId);
		const second = await tab.acquire(run("sa-2"));
		expect(second.paneId).not.toBe(first.paneId);
		await second.release("success");
		expect(client.callCount("pane.split")).toBe(1);
	});

	test("aborted default panes are retained", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const lease = await tab.acquire(run("sa-1"));
		await lease.release("aborted");
		expect(tab.retainedPaneIds).toContain(lease.paneId);
		expect(lease.retained).toBe(true);
	});

	test("retain: always keeps successful panes and never reuses them", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const first = await tab.acquire(run("sa-1"), { retention: "always" });
		await first.release("success");
		expect(tab.retainedPaneIds).toContain(first.paneId);
		const second = await tab.acquire(run("sa-2"), { retention: "always" });
		expect(second.paneId).not.toBe(first.paneId);
		await second.release("success");
	});

	test("idle pool never exceeds one pane", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const first = await tab.acquire(run("sa-1"));
		const second = await tab.acquire(run("sa-2"));
		await first.release("success");
		await second.release("success");
		expect(tab.currentIdlePaneId).toBeDefined();
		expect(client.alivePaneCount(tab.currentTabId)).toBe(1);
		expect(client.callCount("pane.close")).toBe(1);
	});

	test("a manually closed idle pane is detected and replaced", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const first = await tab.acquire(run("sa-1"));
		const second = await tab.acquire(run("sa-2"));
		await first.release("success");
		client.forceClosePane(first.paneId);
		const third = await tab.acquire(run("sa-3"));
		expect(third.paneId).not.toBe(first.paneId);
		expect(client.pane(third.paneId)).toBeDefined();
		await second.release("success");
		await third.release("success");
	});

	test("releasing an already-closed pane does not throw", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const lease = await tab.acquire(run("sa-1"));
		client.forceClosePane(lease.paneId);
		await lease.release("success");
		expect(tab.currentIdlePaneId).toBeUndefined();
	});
});

describe("HerdrTabManager focus and retained panes", () => {
	test("focuses the exact pane for an active run", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const lease = await tab.acquire(run("sa-1"));
		await tab.focus("sa-1");
		expect(client.calls.some((call) => call.method === "pane.focus" && call.params.pane_id === lease.paneId)).toBe(
			true,
		);
		await lease.release("success");
	});

	test("focuses a retained completed pane", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const lease = await tab.acquire(run("sa-1"));
		await lease.release("failed");
		await tab.focus("sa-1");
		expect(client.calls.some((call) => call.method === "pane.focus" && call.params.pane_id === lease.paneId)).toBe(
			true,
		);
	});

	test("focus reports a missing pane and a not-owned pane", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const lease = await tab.acquire(run("sa-1"));
		client.forceClosePane(lease.paneId);
		await expect(tab.focus("sa-1")).rejects.toBeInstanceOf(HerdrTabError);
		await expect(tab.focus("missing")).rejects.toBeInstanceOf(HerdrTabError);
	});

	test("clears the live location for a recycled run but keeps it for a retained run", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const recycled = await tab.acquire(run("sa-1"));
		const retained = await tab.acquire(run("sa-2"));
		await recycled.release("success");
		await retained.release("failed");
		expect(tab.locationForRun("sa-1")).toBeUndefined();
		expect(tab.locationForRun("sa-2")?.retained).toBe(true);
	});

	test("closeRetainedPane closes only owned retained panes", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const lease = await tab.acquire(run("sa-1"));
		await lease.release("failed");
		// A foreign pane in the same tab must never be closed by the manager.
		expect(await tab.closeRetainedPane("w1A:foreign")).toBe(false);
		expect(await tab.closeRetainedPane(lease.paneId)).toBe(true);
		expect(tab.retainedPaneIds).not.toContain(lease.paneId);
		expect(client.callCount("tab.close")).toBe(0);
	});
});

describe("HerdrTabManager manager locations", () => {
	test("focusLocation focuses an exact active and retained pane", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const active = await tab.acquire(run("sa-1"));
		const retained = await tab.acquire(run("sa-2"));
		await retained.release("failed");

		await tab.focusLocation({ tabId: tab.currentTabId as string, paneId: active.paneId, retained: false });
		await tab.focusLocation({ tabId: tab.currentTabId as string, paneId: retained.paneId, retained: true });
		const focused = client.calls.filter((call) => call.method === "pane.focus").map((call) => call.params.pane_id);
		expect(focused).toEqual([active.paneId, retained.paneId]);
		await active.release("success");
	});

	test("focusLocation never creates a tab or pane", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		await expect(
			tab.focusLocation({ tabId: "w1A:t1", paneId: "w1A:p9", retained: true }),
		).rejects.toBeInstanceOf(HerdrTabError);
		expect(client.callCount("tab.create")).toBe(0);
		expect(client.callCount("pane.split")).toBe(0);
	});

	test("paneStatus reports active, retained, and missing", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const active = await tab.acquire(run("sa-1"));
		const retained = await tab.acquire(run("sa-2"));
		await retained.release("failed");
		const tabId = tab.currentTabId as string;

		expect(await tab.paneStatus({ tabId, paneId: active.paneId, retained: false })).toBe("active");
		expect(await tab.paneStatus({ tabId, paneId: retained.paneId, retained: true })).toBe("retained");
		expect(await tab.paneStatus({ tabId, paneId: "w1A:missing", retained: false })).toBe("missing");
		expect(await tab.paneStatus({ tabId: "w1A:other", paneId: retained.paneId, retained: true })).toBe("missing");
		await active.release("success");
	});

	test("focusLocation forgets a manually closed retained pane", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const first = await tab.acquire(run("sa-1"));
		const second = await tab.acquire(run("sa-2"));
		await first.release("failed");
		await second.release("failed");
		const tabId = tab.currentTabId as string;
		client.forceClosePane(first.paneId);

		await expect(
			tab.focusLocation({ tabId, paneId: first.paneId, retained: true }),
		).rejects.toBeInstanceOf(HerdrTabError);
		expect(tab.locationForRun("sa-1")).toBeUndefined();
		expect(tab.retainedPaneIds).not.toContain(first.paneId);
		expect(tab.retainedPaneIds).toContain(second.paneId);
	});

	test("closeRetainedLocation closes only the recorded owned pane", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const lease = await tab.acquire(run("sa-1"));
		await lease.release("failed");
		const tabId = tab.currentTabId as string;

		expect(await tab.closeRetainedLocation({ tabId: "w1A:other", paneId: lease.paneId, retained: true })).toBe(false);
		expect(await tab.closeRetainedLocation({ tabId, paneId: lease.paneId, retained: true })).toBe(true);
		expect(tab.locationForRun("sa-1")).toBeUndefined();
		expect(client.callCount("pane.close")).toBe(1);
	});
});

describe("HerdrTabManager reload and ownership", () => {
	test("reload rediscovers and reuses the matching owned tab", async () => {
		const dir = tempDir();
		const store = createFileHerdrTabStateStore({ directory: dir });
		const client = new FakeHerdrClient();
		const first = manager(client, { store });
		const lease = await first.acquire(run("sa-1"));
		const tabId = first.currentTabId as string;
		await lease.release("failed"); // retained, so the tab survives reload
		await first.dispose({ reason: "reload" });

		const reloaded = manager(client, { store });
		await reloaded.ensureTab();
		expect(reloaded.currentTabId).toBe(tabId);
		expect(client.callCount("tab.create")).toBe(1);
		expect(reloaded.retainedPaneIds).toContain(lease.paneId);
	});

	test("a new Pi session in the same parent pane does not adopt the old tab", async () => {
		const dir = tempDir();
		const store = createFileHerdrTabStateStore({ directory: dir });
		const client = new FakeHerdrClient();
		const first = manager(client, { store, session: "session-aaaaaaaa" });
		const lease = await first.acquire(run("sa-1"));
		const oldTab = first.currentTabId as string;
		await lease.release("failed");
		await first.dispose({ reason: "reload" });

		const second = manager(client, { store, session: "session-bbbbbbbb" });
		await second.ensureTab();
		expect(second.currentTabId).not.toBe(oldTab);
		expect(client.callCount("tab.create")).toBe(2);
	});

	test("removes a stale record when the stored tab no longer exists", async () => {
		const dir = tempDir();
		const store = createFileHerdrTabStateStore({ directory: dir });
		const client = new FakeHerdrClient();
		const first = manager(client, { store });
		await first.acquire(run("sa-1"));
		const tabId = first.currentTabId as string;
		await first.dispose({ reason: "reload" });
		client.forceClosePane(first.currentRootPaneId as string);
		// Closing the last pane also drops the tab.
		expect(client.tab(tabId)).toBeUndefined();

		const reloaded = manager(client, { store });
		await reloaded.ensureTab();
		expect(reloaded.currentTabId).not.toBe(tabId);
	});
});

describe("HerdrTabManager dispose", () => {
	test("closes the owned tab when nothing is retained", async () => {
		const dir = tempDir();
		const store = createFileHerdrTabStateStore({ directory: dir });
		const client = new FakeHerdrClient();
		const tab = manager(client, { store });
		const lease = await tab.acquire(run("sa-1"));
		await lease.release("success");
		await tab.dispose({ reason: "quit" });
		expect(client.callCount("tab.close")).toBe(1);
		expect(client.tabCount()).toBe(0);
	});

	test("leaves the tab when retained panes remain", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const lease = await tab.acquire(run("sa-1"));
		await lease.release("failed");
		await tab.dispose({ reason: "quit" });
		expect(client.callCount("tab.close")).toBe(0);
		expect(client.tabCount()).toBe(1);
	});

	test("reload keeps the tab even without retained panes", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		const lease = await tab.acquire(run("sa-1"));
		await lease.release("success");
		await tab.dispose({ reason: "reload" });
		expect(client.callCount("tab.close")).toBe(0);
	});

	test("never closes a tab whose ownership cannot be verified", async () => {
		const dir = tempDir();
		const store = createFileHerdrTabStateStore({ directory: dir });
		const client = new FakeHerdrClient();
		const first = manager(client, { store });
		const lease = await first.acquire(run("sa-1"));
		const tabId = first.currentTabId as string;
		await lease.release("success");
		await first.dispose({ reason: "reload" });

		const adopted = manager(client, { store });
		await adopted.ensureTab();
		// Simulate token loss: ownership can no longer be positively verified.
		client.forceOwnership(adopted.currentRootPaneId as string, undefined);
		await adopted.dispose({ reason: "quit" });
		expect(client.callCount("tab.close")).toBe(0);
		expect(client.tab(tabId)).toBeDefined();
	});

	test("rejects use after dispose", async () => {
		const client = new FakeHerdrClient();
		const tab = manager(client);
		await tab.acquire(run("sa-1"));
		await tab.dispose({ reason: "quit" });
		await expect(tab.acquire(run("sa-2"))).rejects.toBeInstanceOf(HerdrTabError);
	});
});

describe("HerdrTabManager fallbacks", () => {
	test("splits without geometry using alternating directions", async () => {
		const client = new FakeHerdrClient();
		client.failGetLayout = true;
		const tab = manager(client);
		const leases = [];
		for (let i = 0; i < 3; i++) leases.push(await tab.acquire(run(`sa-${i}`)));
		const directions = client.calls.filter((call) => call.method === "pane.split").map((call) => call.params.direction);
		expect(directions).toContain("right");
		expect(directions).toContain("down");
		for (const lease of leases) await lease.release("success");
	});

	test("metadata write failures do not break the lifecycle", async () => {
		const client = new FakeHerdrClient();
		client.failReportMetadata = true;
		const tab = manager(client);
		const lease = await tab.acquire(run("sa-1"));
		await lease.release("failed");
		expect(tab.retainedPaneIds).toContain(lease.paneId);
	});
});

describe("HerdrTabManager constructor", () => {
	test("requires a session id when no identity is supplied", () => {
		const client = new FakeHerdrClient();
		const previous = process.env.PI_SESSION_ID;
		delete process.env.PI_SESSION_ID;
		try {
			expect(() => new HerdrTabManager({ client })).toThrow(HerdrTabError);
		} finally {
			if (previous !== undefined) process.env.PI_SESSION_ID = previous;
		}
	});
});
