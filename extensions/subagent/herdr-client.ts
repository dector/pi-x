/**
 * Typed adapter for the Herdr socket API.
 *
 * Herdr exposes a newline-delimited JSON API over a Unix domain socket
 * (`HERDR_SOCKET_PATH`). Each connection handles a single request: the server
 * writes one `{id, result}` (or `{id, error}`) line and closes. The transport
 * therefore opens a fresh connection per call rather than pooling sockets.
 *
 * This module deliberately has no Pi runtime imports so it can be loaded from
 * `bun test` and reused by the future bridge/backend. It parses structured
 * responses instead of scraping the human-readable CLI output, and it never
 * uses the ambient focused pane: callers pass explicit pane IDs.
 *
 * Stage 1 scope: detection, structured tab/pane operations, and exact
 * `pane.focus`. Higher-level ownership/leasing policy lives in `herdr-tab.ts`
 * (Stage 3).
 */

import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, isAbsolute, join } from "node:path";

/** Protocol version verified during Stage 1 feasibility work (Herdr 0.9.x). */
export const SUPPORTED_HERDR_PROTOCOL = 22;

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type HerdrSplitDirection = "right" | "down";
export type HerdrPaneDirection = "left" | "right" | "up" | "down";
export type HerdrReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";
export type HerdrReadFormat = "text" | "ansi";

/** Identity of the parent terminal Herdr injected into this process. */
export interface HerdrEnvironment {
	socketPath: string;
	paneId: string;
	workspaceId: string;
	tabId?: string;
	binPath?: string;
}

export interface HerdrServerInfo {
	version: string;
	protocol: number;
	capabilities?: Record<string, unknown>;
}

export interface HerdrPaneInfo {
	paneId: string;
	terminalId: string;
	workspaceId: string;
	tabId: string;
	focused: boolean;
	agentStatus: HerdrAgentStatus;
	revision: number;
	cwd?: string;
	foregroundCwd?: string;
	label?: string;
	title?: string;
	agent?: string;
	displayAgent?: string;
	tokens?: Record<string, string>;
	stateLabels?: Record<string, string>;
}

export interface HerdrTabInfo {
	tabId: string;
	workspaceId: string;
	number: number;
	label: string;
	focused: boolean;
	paneCount: number;
	agentStatus: HerdrAgentStatus;
}

export interface HerdrCreatedTab {
	tab: HerdrTabInfo;
	rootPane: HerdrPaneInfo;
}

export interface HerdrPaneRead {
	paneId: string;
	workspaceId: string;
	tabId: string;
	source: HerdrReadSource;
	format: HerdrReadFormat;
	text: string;
	revision: number;
	truncated: boolean;
}

export interface HerdrPaneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface HerdrPaneLayoutPane {
	paneId: string;
	focused: boolean;
	rect: HerdrPaneRect;
}

export interface HerdrPaneLayoutSplit {
	id: string;
	direction: HerdrSplitDirection;
	ratio: number;
	rect: HerdrPaneRect;
}

/**
 * `pane.layout` snapshot. The parent tab manager uses pane rectangles to pick
 * the largest leaf to split, so concurrent panes stay balanced instead of
 * forming narrow columns.
 */
export interface HerdrPaneLayoutSnapshot {
	workspaceId: string;
	tabId: string;
	zoomed: boolean;
	focusedPaneId: string;
	area: HerdrPaneRect;
	panes: HerdrPaneLayoutPane[];
	splits: HerdrPaneLayoutSplit[];
}

export interface HerdrFocusDirectionResult {
	changed: boolean;
	sourcePaneId: string;
	focusedPaneId?: string;
	reason?: string;
}

export interface HerdrPaneMetadata {
	/** Display-only title shown in the Herdr UI. */
	title?: string;
	/** Short display agent label. */
	displayAgent?: string;
	/** Machine-readable ownership/state markers (max 16, key pattern `[A-Za-z0-9_-]{1,32}`). */
	tokens?: Record<string, string>;
	/** Named status labels (for example `pane_status=active`). */
	stateLabels?: Record<string, string>;
	/** Optional token lifetime; Herdr caps this at 24h. */
	ttlMs?: number;
	/** Monotonic sequence guard; later reports win. */
	seq?: number;
}

export interface HerdrCreateTabOptions {
	workspaceId?: string;
	cwd?: string;
	label?: string;
	/** Defaults to false so background work never steals focus. */
	focus?: boolean;
	env?: Record<string, string>;
}

export interface HerdrSplitPaneOptions {
	/** Explicit target; required so the ambient focused pane is never used. */
	targetPaneId: string;
	direction: HerdrSplitDirection;
	cwd?: string;
	ratio?: number;
	/** Defaults to false (`--no-focus`). */
	focus?: boolean;
	env?: Record<string, string>;
}

export interface HerdrReadPaneOptions {
	paneId: string;
	source?: HerdrReadSource;
	lines?: number;
	format?: HerdrReadFormat;
	stripAnsi?: boolean;
}

/** The single method the transport must implement. */
export interface HerdrTransport {
	request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface HerdrClient {
	readonly environment: HerdrEnvironment;
	ping(): Promise<HerdrServerInfo>;
	/** Ping the server and reject when the protocol is older than supported. */
	assertCompatible(): Promise<HerdrServerInfo>;
	listTabs(workspaceId?: string): Promise<HerdrTabInfo[]>;
	getTab(tabId: string): Promise<HerdrTabInfo>;
	createTab(options?: HerdrCreateTabOptions): Promise<HerdrCreatedTab>;
	renameTab(tabId: string, label: string): Promise<HerdrTabInfo>;
	focusTab(tabId: string): Promise<HerdrTabInfo>;
	closeTab(tabId: string): Promise<void>;
	listPanes(workspaceId?: string): Promise<HerdrPaneInfo[]>;
	getPane(paneId: string): Promise<HerdrPaneInfo>;
	splitPane(options: HerdrSplitPaneOptions): Promise<HerdrPaneInfo>;
	renamePane(paneId: string, label: string): Promise<HerdrPaneInfo>;
	closePane(paneId: string): Promise<void>;
	/** Exact pane focus through the `pane.focus` socket method. */
	focusPane(paneId: string): Promise<HerdrPaneInfo>;
	focusPaneDirection(paneId: string, direction: HerdrPaneDirection): Promise<HerdrFocusDirectionResult>;
	sendText(paneId: string, text: string): Promise<void>;
	sendKeys(paneId: string, keys: string[]): Promise<void>;
	sendInput(paneId: string, input: { text?: string; keys?: string[] }): Promise<void>;
	readPane(options: HerdrReadPaneOptions): Promise<HerdrPaneRead>;
	/** `pane.layout` for the tab that contains `paneId`; returns live pane rectangles. */
	getPaneLayout(paneId: string): Promise<HerdrPaneLayoutSnapshot>;
	reportPaneMetadata(paneId: string, source: string, metadata: HerdrPaneMetadata): Promise<void>;
	/** Clears display-only metadata (title/labels); token keys must be cleared explicitly. */
	clearPaneDisplayMetadata(paneId: string, source: string): Promise<void>;
}

/** An error envelope returned by the Herdr server, or a transport failure. */
export class HerdrApiError extends Error {
	readonly code: string;
	readonly method: string;

	constructor(message: string, options: { code: string; method: string }) {
		super(message);
		this.name = "HerdrApiError";
		this.code = options.code;
		this.method = options.method;
	}
}

/** A malformed or unexpected response, as opposed to a server-reported error. */
export class HerdrProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HerdrProtocolError";
	}
}

const AGENT_STATUSES: readonly HerdrAgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];
const READ_SOURCES: readonly HerdrReadSource[] = ["visible", "recent", "recent_unwrapped", "detection"];

/**
 * Read and validate the Herdr environment injected into this process.
 * Returns `undefined` when not running inside a Herdr-managed pane.
 */
export function readHerdrEnvironment(env: NodeJS.ProcessEnv = process.env): HerdrEnvironment | undefined {
	if (env.HERDR_ENV !== "1") return undefined;
	const socketPath = nonEmpty(env.HERDR_SOCKET_PATH);
	const paneId = nonEmpty(env.HERDR_PANE_ID);
	const workspaceId = nonEmpty(env.HERDR_WORKSPACE_ID);
	if (!socketPath || !paneId || !workspaceId) return undefined;
	const tabId = nonEmpty(env.HERDR_TAB_ID);
	const binPath = nonEmpty(env.HERDR_BIN_PATH);
	return { socketPath, paneId, workspaceId, ...(tabId ? { tabId } : {}), ...(binPath ? { binPath } : {}) };
}

/**
 * Resolve the `herdr` executable without trusting `HERDR_BIN_PATH` blindly:
 * an upgrade can leave that variable pointing at a deleted path. Prefers an
 * executable `HERDR_BIN_PATH`, then `PATH`, then the configured value.
 */
export function resolveHerdrExecutable(
	env: NodeJS.ProcessEnv = process.env,
	options: { isExecutable?: (path: string) => boolean } = {},
): string | undefined {
	const isExecutable = options.isExecutable ?? defaultIsExecutable;
	const explicit = nonEmpty(env.HERDR_BIN_PATH);
	if (explicit && isExecutable(explicit)) return explicit;
	const pathValue = env.PATH ?? "";
	for (const dir of pathValue.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, process.platform === "win32" ? "herdr.exe" : "herdr");
		if (isExecutable(candidate)) return candidate;
	}
	if (explicit) return explicit;
	return undefined;
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

function nonEmpty(value: string | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Unix-socket transport for the Herdr API. One request per connection, because
 * the server writes one response and closes.
 */
export function createUnixSocketTransport(options: {
	socketPath: string;
	timeoutMs?: number;
	maxResponseBytes?: number;
}): HerdrTransport {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
	return {
		request(method, params) {
			return new Promise<unknown>((resolve, reject) => {
				const socket = connect(options.socketPath);
				const id = randomUUID();
				let buffer = "";
				let received = 0;
				let settled = false;

				const finish = (action: () => void): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					socket.destroy();
					action();
				};

				const timer = setTimeout(() => {
					finish(() => reject(new HerdrApiError(`Herdr request timed out: ${method}`, { code: "timeout", method })));
				}, timeoutMs);

				socket.on("connect", () => {
					try {
						socket.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`);
					} catch (error) {
						finish(() =>
							reject(
								new HerdrApiError(`Failed to write Herdr request: ${messageOf(error)}`, {
									code: "transport_error",
									method,
								}),
							),
						);
					}
				});

				socket.on("data", (chunk: Buffer) => {
					received += chunk.length;
					if (received > maxResponseBytes) {
						finish(() =>
							reject(new HerdrProtocolError(`Herdr response exceeded ${maxResponseBytes} bytes for ${method}`)),
						);
						return;
					}
					buffer += chunk.toString("utf8");
					const newline = buffer.indexOf("\n");
					if (newline < 0) return;
					const line = buffer.slice(0, newline);
					let parsed: unknown;
					try {
						parsed = JSON.parse(line);
					} catch {
						finish(() => reject(new HerdrProtocolError(`Malformed Herdr response for ${method}`)));
						return;
					}
					const envelope = asRecord(parsed, `Herdr response for ${method}`);
					if (envelope.error !== undefined) {
						const error = asRecord(envelope.error, `Herdr error for ${method}`);
						const code = optionalString(error.code) ?? "unknown_error";
						const message = optionalString(error.message) ?? "Herdr request failed";
						finish(() => reject(new HerdrApiError(message, { code, method })));
						return;
					}
					if (envelope.result === undefined) {
						finish(() => reject(new HerdrProtocolError(`Herdr response for ${method} had no result`)));
						return;
					}
					const result = envelope.result;
					finish(() => resolve(result));
				});

				socket.on("error", (error: Error) => {
					finish(() =>
						reject(
							new HerdrApiError(`Herdr socket error for ${method}: ${error.message}`, {
								code: "transport_error",
								method,
							}),
						),
					);
				});

				socket.on("close", () => {
					if (settled) return;
					finish(() => reject(new HerdrApiError(`Herdr connection closed before responding to ${method}`, { code: "connection_closed", method })));
				});
			});
		},
	};
}

/** Build a client bound to one Herdr environment and transport. */
export function createHerdrClient(options: {
	environment: HerdrEnvironment;
	transport: HerdrTransport;
}): HerdrClient {
	const { environment, transport } = options;

	const call = (method: string, params?: Record<string, unknown>): Promise<unknown> => transport.request(method, params);

	const expectType = (result: unknown, type: string, method: string): Record<string, unknown> => {
		const record = asRecord(result, `Herdr result for ${method}`);
		if (record.type !== type) {
			throw new HerdrProtocolError(`Expected Herdr ${type} for ${method}, received ${String(record.type)}`);
		}
		return record;
	};

	const ping = async (): Promise<HerdrServerInfo> => {
		const result = expectType(await call("ping"), "pong", "ping");
		return parseServerInfo(result);
	};

	return {
		environment,
		ping,
		async assertCompatible() {
			const info = await ping();
			if (info.protocol < SUPPORTED_HERDR_PROTOCOL) {
				throw new HerdrApiError(
					`Herdr protocol ${info.protocol} is older than the supported ${SUPPORTED_HERDR_PROTOCOL}`,
					{ code: "incompatible_protocol", method: "ping" },
				);
			}
			return info;
		},
		async listTabs(workspaceId) {
			const result = expectType(
				await call("tab.list", { workspace_id: workspaceId ?? environment.workspaceId }),
				"tab_list",
				"tab.list",
			);
			return asArray(result.tabs, "tab.list tabs").map(parseTabInfo);
		},
		async getTab(tabId) {
			const result = expectType(await call("tab.get", { tab_id: tabId }), "tab_info", "tab.get");
			return parseTabInfo(result.tab);
		},
		async createTab(options = {}) {
			const params: Record<string, unknown> = {
				workspace_id: options.workspaceId ?? environment.workspaceId,
				focus: options.focus ?? false,
			};
			if (options.cwd !== undefined) params.cwd = options.cwd;
			if (options.label !== undefined) params.label = options.label;
			if (options.env !== undefined) params.env = options.env;
			const result = expectType(await call("tab.create", params), "tab_created", "tab.create");
			return { tab: parseTabInfo(result.tab), rootPane: parsePaneInfo(result.root_pane) };
		},
		async renameTab(tabId, label) {
			const result = expectType(await call("tab.rename", { tab_id: tabId, label }), "tab_info", "tab.rename");
			return parseTabInfo(result.tab);
		},
		async focusTab(tabId) {
			const result = expectType(await call("tab.focus", { tab_id: tabId }), "tab_info", "tab.focus");
			return parseTabInfo(result.tab);
		},
		async closeTab(tabId) {
			expectType(await call("tab.close", { tab_id: tabId }), "ok", "tab.close");
		},
		async listPanes(workspaceId) {
			const result = expectType(
				await call("pane.list", { workspace_id: workspaceId ?? environment.workspaceId }),
				"pane_list",
				"pane.list",
			);
			return asArray(result.panes, "pane.list panes").map(parsePaneInfo);
		},
		async getPane(paneId) {
			const result = expectType(await call("pane.get", { pane_id: paneId }), "pane_info", "pane.get");
			return parsePaneInfo(result.pane);
		},
		async splitPane(options) {
			const params: Record<string, unknown> = {
				target_pane_id: options.targetPaneId,
				direction: options.direction,
				focus: options.focus ?? false,
			};
			if (options.cwd !== undefined) params.cwd = options.cwd;
			if (options.ratio !== undefined) params.ratio = options.ratio;
			if (options.env !== undefined) params.env = options.env;
			const result = expectType(await call("pane.split", params), "pane_info", "pane.split");
			return parsePaneInfo(result.pane);
		},
		async renamePane(paneId, label) {
			const result = expectType(await call("pane.rename", { pane_id: paneId, label }), "pane_info", "pane.rename");
			return parsePaneInfo(result.pane);
		},
		async closePane(paneId) {
			expectType(await call("pane.close", { pane_id: paneId }), "ok", "pane.close");
		},
		async focusPane(paneId) {
			const result = expectType(await call("pane.focus", { pane_id: paneId }), "pane_info", "pane.focus");
			return parsePaneInfo(result.pane);
		},
		async focusPaneDirection(paneId, direction) {
			const result = expectType(
				await call("pane.focus_direction", { pane_id: paneId, direction }),
				"pane_focus_direction",
				"pane.focus_direction",
			);
			const focus = asRecord(result.focus, "pane.focus_direction focus");
			const focusedPaneId = optionalString(focus.focused_pane_id);
			const reason = optionalString(focus.reason);
			return {
				changed: asBoolean(focus.changed, "focus.changed"),
				sourcePaneId: asString(focus.source_pane_id, "focus.source_pane_id"),
				...(focusedPaneId ? { focusedPaneId } : {}),
				...(reason ? { reason } : {}),
			};
		},
		async sendText(paneId, text) {
			expectType(await call("pane.send_text", { pane_id: paneId, text }), "ok", "pane.send_text");
		},
		async sendKeys(paneId, keys) {
			expectType(await call("pane.send_keys", { pane_id: paneId, keys }), "ok", "pane.send_keys");
		},
		async sendInput(paneId, input) {
			const params: Record<string, unknown> = { pane_id: paneId };
			if (input.text !== undefined) params.text = input.text;
			if (input.keys !== undefined) params.keys = input.keys;
			expectType(await call("pane.send_input", params), "ok", "pane.send_input");
		},
		async readPane(options) {
			const params: Record<string, unknown> = {
				pane_id: options.paneId,
				source: options.source ?? "recent_unwrapped",
			};
			if (options.lines !== undefined) params.lines = options.lines;
			if (options.format !== undefined) params.format = options.format;
			if (options.stripAnsi !== undefined) params.strip_ansi = options.stripAnsi;
			const result = expectType(await call("pane.read", params), "pane_read", "pane.read");
			const read = asRecord(result.read, "pane.read read");
			return {
				paneId: asString(read.pane_id, "read.pane_id"),
				workspaceId: asString(read.workspace_id, "read.workspace_id"),
				tabId: asString(read.tab_id, "read.tab_id"),
				source: parseReadSource(read.source),
				format: read.format === "ansi" ? "ansi" : "text",
				text: asString(read.text, "read.text"),
				revision: asNumber(read.revision, "read.revision"),
				truncated: asBoolean(read.truncated, "read.truncated"),
			};
		},
		async getPaneLayout(paneId) {
			const result = expectType(await call("pane.layout", { pane_id: paneId }), "pane_layout", "pane.layout");
			return parsePaneLayoutSnapshot(result.layout);
		},
		async reportPaneMetadata(paneId, source, metadata) {
			const params: Record<string, unknown> = { pane_id: paneId, source };
			if (metadata.title !== undefined) params.title = metadata.title;
			if (metadata.displayAgent !== undefined) params.display_agent = metadata.displayAgent;
			if (metadata.tokens !== undefined) params.tokens = metadata.tokens;
			if (metadata.stateLabels !== undefined) params.state_labels = metadata.stateLabels;
			if (metadata.ttlMs !== undefined) params.ttl_ms = metadata.ttlMs;
			if (metadata.seq !== undefined) params.seq = metadata.seq;
			expectType(await call("pane.report_metadata", params), "ok", "pane.report_metadata");
		},
		async clearPaneDisplayMetadata(paneId, source) {
			expectType(
				await call("pane.report_metadata", {
					pane_id: paneId,
					source,
					clear_title: true,
					clear_display_agent: true,
					clear_state_labels: true,
				}),
				"ok",
				"pane.report_metadata",
			);
		},
	};
}

function parseServerInfo(result: Record<string, unknown>): HerdrServerInfo {
	return {
		version: asString(result.version, "pong.version"),
		protocol: asNumber(result.protocol, "pong.protocol"),
		...(result.capabilities !== undefined
			? { capabilities: asRecord(result.capabilities, "pong.capabilities") }
			: {}),
	};
}

function parseTabInfo(value: unknown): HerdrTabInfo {
	const tab = asRecord(value, "tab");
	return {
		tabId: asString(tab.tab_id, "tab.tab_id"),
		workspaceId: asString(tab.workspace_id, "tab.workspace_id"),
		number: asNumber(tab.number, "tab.number"),
		label: asString(tab.label, "tab.label"),
		focused: asBoolean(tab.focused, "tab.focused"),
		paneCount: asNumber(tab.pane_count, "tab.pane_count"),
		agentStatus: parseAgentStatus(tab.agent_status),
	};
}

function parsePaneInfo(value: unknown): HerdrPaneInfo {
	const pane = asRecord(value, "pane");
	return {
		paneId: asString(pane.pane_id, "pane.pane_id"),
		terminalId: asString(pane.terminal_id, "pane.terminal_id"),
		workspaceId: asString(pane.workspace_id, "pane.workspace_id"),
		tabId: asString(pane.tab_id, "pane.tab_id"),
		focused: asBoolean(pane.focused, "pane.focused"),
		agentStatus: parseAgentStatus(pane.agent_status),
		revision: asNumber(pane.revision, "pane.revision"),
		...(optionalString(pane.cwd) ? { cwd: optionalString(pane.cwd) } : {}),
		...(optionalString(pane.foreground_cwd) ? { foregroundCwd: optionalString(pane.foreground_cwd) } : {}),
		...(optionalString(pane.label) ? { label: optionalString(pane.label) } : {}),
		...(optionalString(pane.title) ? { title: optionalString(pane.title) } : {}),
		...(optionalString(pane.agent) ? { agent: optionalString(pane.agent) } : {}),
		...(optionalString(pane.display_agent) ? { displayAgent: optionalString(pane.display_agent) } : {}),
		...(pane.tokens !== undefined ? { tokens: parseStringMap(pane.tokens, "pane.tokens") } : {}),
		...(pane.state_labels !== undefined ? { stateLabels: parseStringMap(pane.state_labels, "pane.state_labels") } : {}),
	};
}

function parsePaneLayoutSnapshot(value: unknown): HerdrPaneLayoutSnapshot {
	const layout = asRecord(value, "pane.layout layout");
	return {
		workspaceId: asString(layout.workspace_id, "layout.workspace_id"),
		tabId: asString(layout.tab_id, "layout.tab_id"),
		zoomed: asBoolean(layout.zoomed, "layout.zoomed"),
		focusedPaneId: asString(layout.focused_pane_id, "layout.focused_pane_id"),
		area: parsePaneRect(layout.area, "layout.area"),
		panes: asArray(layout.panes, "layout.panes").map((pane, index) => parsePaneLayoutPane(pane, `layout.panes[${index}]`)),
		splits: asArray(layout.splits, "layout.splits").map((split, index) => parsePaneLayoutSplit(split, `layout.splits[${index}]`)),
	};
}

function parsePaneLayoutPane(value: unknown, context: string): HerdrPaneLayoutPane {
	const pane = asRecord(value, context);
	return {
		paneId: asString(pane.pane_id, `${context}.pane_id`),
		focused: asBoolean(pane.focused, `${context}.focused`),
		rect: parsePaneRect(pane.rect, `${context}.rect`),
	};
}

function parsePaneLayoutSplit(value: unknown, context: string): HerdrPaneLayoutSplit {
	const split = asRecord(value, context);
	const direction = split.direction === "down" ? "down" : "right";
	return {
		id: asString(split.id, `${context}.id`),
		direction,
		ratio: asNumber(split.ratio, `${context}.ratio`),
		rect: parsePaneRect(split.rect, `${context}.rect`),
	};
}

function parsePaneRect(value: unknown, context: string): HerdrPaneRect {
	const rect = asRecord(value, context);
	return {
		x: asNumber(rect.x, `${context}.x`),
		y: asNumber(rect.y, `${context}.y`),
		width: asNumber(rect.width, `${context}.width`),
		height: asNumber(rect.height, `${context}.height`),
	};
}

function parseAgentStatus(value: unknown): HerdrAgentStatus {
	if (typeof value === "string" && (AGENT_STATUSES as readonly string[]).includes(value)) {
		return value as HerdrAgentStatus;
	}
	throw new HerdrProtocolError(`Unexpected Herdr agent status: ${String(value)}`);
}

function parseReadSource(value: unknown): HerdrReadSource {
	if (typeof value === "string" && (READ_SOURCES as readonly string[]).includes(value)) {
		return value as HerdrReadSource;
	}
	throw new HerdrProtocolError(`Unexpected Herdr read source: ${String(value)}`);
}

function parseStringMap(value: unknown, context: string): Record<string, string> {
	const record = asRecord(value, context);
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (typeof entry !== "string") throw new HerdrProtocolError(`${context}.${key} must be a string`);
		result[key] = entry;
	}
	return result;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HerdrProtocolError(`${context} must be an object`);
	}
	return value as Record<string, unknown>;
}

function asArray(value: unknown, context: string): unknown[] {
	if (!Array.isArray(value)) throw new HerdrProtocolError(`${context} must be an array`);
	return value;
}

function asString(value: unknown, context: string): string {
	if (typeof value !== "string") throw new HerdrProtocolError(`${context} must be a string`);
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown, context: string): boolean {
	if (typeof value !== "boolean") throw new HerdrProtocolError(`${context} must be a boolean`);
	return value;
}

function asNumber(value: unknown, context: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new HerdrProtocolError(`${context} must be a number`);
	return value;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
