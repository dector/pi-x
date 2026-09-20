/**
 * Herdr tab status symbols for the hub extension.
 *
 * Shows Pi's agent status as a leading symbol in the Herdr tab that hosts the
 * Pi pane. Herdr is the source of truth: this module subscribes to
 * `pane.agent_status_changed` and mirrors the reported status onto the tab
 * label. It never infers state from Pi events.
 *
 * Self-contained on purpose: no Pi runtime imports, so it loads from
 * `bun test`. It owns a minimal newline-delimited JSON socket client instead of
 * depending on another extension. See the hub README for the design.
 */

import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

/** Agent states Herdr reports per pane/tab. */
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Prefix style. `symbols` is Herdr's own symbol set; `dots` its collapsed set. */
export type HerdrTabStyle = "symbols" | "dots";

/** The subset of the Herdr environment this feature needs. */
export interface HerdrTabEnv {
	/** Endpoint to connect to (Windows named pipes are resolved). */
	socketPath: string;
	paneId: string;
	tabId: string;
}

/** Minimal `tab.get` view used to seed and rebase the base label. */
export interface HerdrTabInfo {
	tabId: string;
	label: string;
	agentStatus: HerdrAgentStatus;
}

/** One `events.subscribe` entry. */
export interface HerdrSubscription {
	type: string;
	pane_id?: string;
	tab_id?: string;
	workspace_id?: string;
	[key: string]: unknown;
}

/** One streamed event line after framing. */
export interface HerdrEvent {
	event: string;
	data: Record<string, unknown>;
}

const AGENT_STATUSES: readonly HerdrAgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

/**
 * Prefix mapping. `idle` and `unknown` are intentionally plain: the tab should
 * return to its base label when nothing needs attention.
 */
const SYMBOLS: Record<HerdrTabStyle, Partial<Record<HerdrAgentStatus, string>>> = {
	symbols: { blocked: "×", working: "◐", done: "✓" },
	dots: { blocked: "◉", working: "●", done: "●" },
};

/** Every symbol this module can write, used to recover a base label on start. */
const KNOWN_SYMBOLS: readonly string[] = ["×", "◐", "✓", "◉", "●"];

export function isHerdrAgentStatus(value: unknown): value is HerdrAgentStatus {
	return typeof value === "string" && (AGENT_STATUSES as readonly string[]).includes(value);
}

export function parseHerdrAgentStatus(value: unknown): HerdrAgentStatus | undefined {
	return isHerdrAgentStatus(value) ? value : undefined;
}

/** Leading symbol for a status, or `undefined` when the label stays plain. */
export function symbolFor(status: HerdrAgentStatus, style: HerdrTabStyle = "symbols"): string | undefined {
	return SYMBOLS[style]?.[status];
}

/**
 * Compose `<symbol> <base>`. Idle/unknown (and an empty base) produce no
 * leading space, so the result is always a clean label.
 */
export function composeLabel(base: string, status: HerdrAgentStatus, style: HerdrTabStyle = "symbols"): string {
	const symbol = symbolFor(status, style);
	if (!symbol) return base;
	return base.length > 0 ? `${symbol} ${base}` : symbol;
}

/**
 * Recover the base label from a possibly-prefixed label. Strips any symbol this
 * module can write, from either style, so a style change does not leak the old
 * prefix. Only `symbol` alone or `symbol ` are stripped; a user label that
 * merely starts with one of these characters followed by text is left alone.
 */
export function stripKnownPrefix(label: string): string {
	for (const symbol of KNOWN_SYMBOLS) {
		if (label === symbol) return "";
		if (label.startsWith(`${symbol} `)) return label.slice(symbol.length + 1);
	}
	return label;
}

/**
 * Resolve the connect endpoint. On Windows the managed integration prefixes a
 * bare socket name with `\\.\pipe\`; already-prefixed pipe/UNC paths are left
 * untouched so this is idempotent.
 */
export function resolveHerdrSocketEndpoint(
	socketPath: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform !== "win32") return socketPath;
	if (socketPath.startsWith("\\\\") || socketPath.startsWith("//")) return socketPath;
	return `\\\\.\\pipe\\${socketPath}`;
}

/**
 * Detect the Herdr tab environment. Requires `HERDR_ENV=1` plus socket, pane,
 * and tab ids. Returns `undefined` outside a Herdr-managed pane, which is the
 * gate that keeps the feature a no-op elsewhere.
 */
export function detectHerdrTabEnv(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): HerdrTabEnv | undefined {
	if (env.HERDR_ENV !== "1") return undefined;
	const socketPath = nonEmpty(env.HERDR_SOCKET_PATH);
	const paneId = nonEmpty(env.HERDR_PANE_ID);
	const tabId = nonEmpty(env.HERDR_TAB_ID);
	if (!socketPath || !paneId || !tabId) return undefined;
	return { socketPath: resolveHerdrSocketEndpoint(socketPath, platform), paneId, tabId };
}

/** Transport/protocol failure with a machine-readable code. */
export class HerdrSocketError extends Error {
	readonly code: string;
	readonly method?: string;

	constructor(message: string, options: { code: string; method?: string }) {
		super(message);
		this.name = "HerdrSocketError";
		this.code = options.code;
		this.method = options.method;
	}
}

export interface HerdrSocketOptions {
	/** Connect endpoint. Pass through `resolveHerdrSocketEndpoint` if unsure. */
	socketPath: string;
	/** Test seam; defaults to `net.connect`. */
	createConnection?: (endpoint: string) => Socket;
	/** Per-attempt request timeouts. Defaults to the managed integration's `[500, 1500]`. */
	requestTimeoutsMs?: readonly number[];
	/** Cap on one buffered stream line. Defaults to 1 MiB. */
	maxLineBytes?: number;
	/** Reconnect backoff base. Defaults to 500 ms. */
	backoffBaseMs?: number;
	/** Reconnect backoff cap. Defaults to 10 s. */
	backoffMaxMs?: number;
	logger?: (message: string) => void;
}

/**
 * Minimal newline-delimited JSON client for the Herdr socket API.
 *
 * `request` opens one connection per call (the server answers once and closes)
 * and retries the managed integration's 500 ms then 1500 ms pattern.
 * `subscribe` keeps one connection open, ignores the `subscription_started`
 * ack, dispatches subsequent lines, and reconnects with capped exponential
 * backoff. One-shot requests stay usable after the stream is destroyed.
 */
export class HerdrSocket {
	private readonly endpoint: string;
	private readonly createConnection: (endpoint: string) => Socket;
	private readonly requestTimeoutsMs: readonly number[];
	private readonly maxLineBytes: number;
	private readonly backoffBaseMs: number;
	private readonly backoffMaxMs: number;
	private readonly logger: ((message: string) => void) | undefined;

	private streamSocket: Socket | undefined;
	private streamGeneration = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	private attempt = 0;
	private subscriptions: HerdrSubscription[] = [];
	private onEvent: ((event: HerdrEvent) => void) | undefined;
	private onError: ((error: unknown) => void) | undefined;
	private onConnect: (() => void) | undefined;

	constructor(options: HerdrSocketOptions) {
		this.endpoint = options.socketPath;
		this.createConnection = options.createConnection ?? ((endpoint) => connect(endpoint));
		this.requestTimeoutsMs = options.requestTimeoutsMs ?? [500, 1500];
		this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
		this.backoffBaseMs = options.backoffBaseMs ?? 500;
		this.backoffMaxMs = options.backoffMaxMs ?? 10_000;
		this.logger = options.logger;
	}

	/** One-shot request with bounded retries. Resolves the response `result`. */
	async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		const timeouts = this.requestTimeoutsMs.length > 0 ? this.requestTimeoutsMs : [500, 1500];
		let lastError: unknown;
		for (const timeoutMs of timeouts) {
			try {
				return await this.requestOnce<T>(method, params, timeoutMs);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError instanceof Error
			? lastError
			: new HerdrSocketError(`Herdr request failed: ${method}`, { code: "request_failed", method });
	}

	private requestOnce<T>(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const socket = this.createConnection(this.endpoint);
			const id = randomUUID();
			let buffer = "";
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const finish = (action: () => void): void => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				socket.destroy();
				action();
			};

			timer = setTimeout(() => {
				finish(() => reject(new HerdrSocketError(`Herdr request timed out: ${method}`, { code: "timeout", method })));
			}, timeoutMs);
			timer.unref?.();

			socket.on("connect", () => {
				try {
					socket.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`);
				} catch (error) {
					finish(() =>
						reject(
							new HerdrSocketError(`Failed to write Herdr request: ${messageOf(error)}`, {
								code: "transport_error",
								method,
							}),
						),
					);
				}
			});

			socket.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				const newline = buffer.indexOf("\n");
				if (newline < 0) {
					if (buffer.length > this.maxLineBytes) {
						finish(() =>
							reject(new HerdrSocketError(`Herdr response too large: ${method}`, { code: "line_too_large", method })),
						);
					}
					return;
				}

				const line = buffer.slice(0, newline);
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					finish(() => reject(new HerdrSocketError(`Malformed Herdr response: ${method}`, { code: "protocol_error", method })));
					return;
				}

				if (!isRecord(parsed)) {
					finish(() => reject(new HerdrSocketError(`Malformed Herdr response: ${method}`, { code: "protocol_error", method })));
					return;
				}

				if (parsed.error !== undefined) {
					const error = isRecord(parsed.error) ? parsed.error : {};
					const code = typeof error.code === "string" ? error.code : "unknown_error";
					const message = typeof error.message === "string" ? error.message : `Herdr ${method} failed`;
					finish(() => reject(new HerdrSocketError(message, { code, method })));
					return;
				}

				const result = parsed.result !== undefined ? parsed.result : parsed;
				finish(() => resolve(result as T));
			});

			socket.on("error", (error: Error) => {
				finish(() =>
					reject(
						new HerdrSocketError(`Herdr socket error for ${method}: ${error.message}`, {
							code: "transport_error",
							method,
						}),
					),
				);
			});

			socket.on("close", () => {
				if (settled) return;
				finish(() => reject(new HerdrSocketError(`Herdr connection closed before responding: ${method}`, { code: "connection_closed", method })));
			});
		});
	}

	/**
	 * Open a persistent subscription stream. `onConnect` fires after the
	 * `subscription_started` ack (and after every successful reconnect) so the
	 * caller can re-seed state that may have changed while disconnected.
	 */
	subscribe(
		subscriptions: HerdrSubscription[],
		onEvent: (event: HerdrEvent) => void,
		onError?: (error: unknown) => void,
		onConnect?: () => void,
	): void {
		this.destroy();
		this.stopped = false;
		this.attempt = 0;
		this.subscriptions = subscriptions;
		this.onEvent = onEvent;
		this.onError = onError;
		this.onConnect = onConnect;
		this.openStream();
	}

	private openStream(): void {
		if (this.stopped) return;
		// Each stream owns a generation. Callbacks from a superseded socket (for
		// example the close event that fires after `subscribe`/`destroy` replaced
		// it) must not schedule a reconnect, or they open a duplicate stream.
		const generation = ++this.streamGeneration;
		const socket = this.createConnection(this.endpoint);
		this.streamSocket = socket;

		let buffer = "";
		let acked = false;
		let closed = false;

		const down = (error?: unknown): void => {
			if (closed) return;
			closed = true;
			if (generation !== this.streamGeneration) return;
			if (this.streamSocket === socket) this.streamSocket = undefined;
			if (this.stopped) return;
			try {
				this.onError?.(error);
			} catch (handlerError) {
				this.logger?.(`herdr socket onError threw: ${messageOf(handlerError)}`);
			}
			this.scheduleReconnect(generation);
		};

		socket.on("connect", () => {
			try {
				const request = {
					id: randomUUID(),
					method: "events.subscribe",
					params: { subscriptions: this.subscriptions },
				};
				socket.write(`${JSON.stringify(request)}\n`);
			} catch (error) {
				down(error);
				socket.destroy();
			}
		});

		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line.trim().length === 0) continue;

				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					continue;
				}
				if (!isRecord(parsed)) continue;

				if (!acked && isRecord(parsed.result) && parsed.result.type === "subscription_started") {
					acked = true;
					this.attempt = 0;
					try {
						this.onConnect?.();
					} catch (handlerError) {
						this.logger?.(`herdr socket onConnect threw: ${messageOf(handlerError)}`);
					}
					continue;
				}

				if (typeof parsed.event === "string") {
					const data = isRecord(parsed.data) ? parsed.data : {};
					try {
						this.onEvent?.({ event: parsed.event, data });
					} catch (handlerError) {
						this.logger?.(`herdr socket onEvent threw: ${messageOf(handlerError)}`);
					}
				}
			}

			if (buffer.length > this.maxLineBytes) {
				down(new HerdrSocketError("Herdr event stream exceeded the line limit", { code: "line_too_large" }));
				socket.destroy();
			}
		});

		socket.on("error", (error: Error) => down(error));
		socket.on("close", () => down());
	}

	private scheduleReconnect(generation: number): void {
		if (this.stopped || this.reconnectTimer) return;
		if (generation !== this.streamGeneration) return;
		const exponent = Math.min(this.attempt, 10);
		const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** exponent);
		this.attempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			if (generation !== this.streamGeneration) return;
			this.openStream();
		}, delay);
		this.reconnectTimer.unref?.();
	}

	/** Tear down the stream and stop reconnecting. One-shot requests still work. */
	destroy(): void {
		this.stopped = true;
		this.streamGeneration += 1;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		const socket = this.streamSocket;
		this.streamSocket = undefined;
		socket?.destroy();
	}
}

export interface HerdrTabStatusOptions {
	env: HerdrTabEnv;
	style?: HerdrTabStyle;
	/** Debounce before a rename, so rapid flips coalesce. Defaults to 150 ms. */
	debounceMs?: number;
	/** Best-effort restore bound on stop. Defaults to 2000 ms. */
	restoreTimeoutMs?: number;
	/** Test seam; defaults to a `HerdrSocket` for `env.socketPath`. */
	socket?: HerdrSocket;
	logger?: (message: string) => void;
	onError?: (error: unknown) => void;
	onStatusChange?: (status: HerdrAgentStatus) => void;
}

/**
 * Mirrors Herdr's per-pane agent status onto the hosting tab label.
 *
 * Lifecycle:
 *  - `start()` reads the tab once to recover the base label, writes the prefix
 *    for the current status, then subscribes.
 *  - Status events are coalesced: one rename may be in flight, the latest
 *    desired status wins, no-op writes are skipped, and a ~150 ms debounce
 *    keeps each rename (which triggers a session save in Herdr) from storming.
 *  - A user rename is detected on the next status event by re-reading the tab
 *    and comparing against the last label we wrote; the new base is adopted.
 *  - `stop()` destroys the stream and writes the base label back, best effort.
 *
 * All failures are contained: `start`/`stop` never throw into hub logic, and a
 * failed seed read disables the feature for the session.
 */
export class HerdrTabStatus {
	private readonly env: HerdrTabEnv;
	private readonly style: HerdrTabStyle;
	private readonly debounceMs: number;
	private readonly restoreTimeoutMs: number;
	private readonly socket: HerdrSocket;
	private readonly logger: ((message: string) => void) | undefined;
	private readonly onError: ((error: unknown) => void) | undefined;
	private readonly onStatusChange: ((status: HerdrAgentStatus) => void) | undefined;

	private baseLabel: string | undefined;
	private lastWrittenLabel: string | undefined;
	private desiredLabel: string | undefined;
	private current: HerdrAgentStatus | undefined;
	private writeTimer: ReturnType<typeof setTimeout> | undefined;
	private inFlight: Promise<void> | undefined;
	private generation = 0;
	private statusRevision = 0;
	private started = false;
	private disabled = false;
	private pendingStatus: HerdrAgentStatus | undefined;
	private processing = false;

	constructor(options: HerdrTabStatusOptions) {
		this.env = options.env;
		this.style = options.style ?? "symbols";
		this.debounceMs = options.debounceMs ?? 150;
		this.restoreTimeoutMs = options.restoreTimeoutMs ?? 2000;
		this.socket =
			options.socket ??
			new HerdrSocket({
				socketPath: options.env.socketPath,
				...(options.logger ? { logger: options.logger } : {}),
			});
		this.logger = options.logger;
		this.onError = options.onError;
		this.onStatusChange = options.onStatusChange;
	}

	get isActive(): boolean {
		return this.started && !this.disabled;
	}

	get status(): HerdrAgentStatus | undefined {
		return this.current;
	}

	get tabId(): string {
		return this.env.tabId;
	}

	/** `/px:hub` line body: `<status> (<tab_id>)`, or `off`. */
	describe(): string {
		if (!this.isActive) return "off";
		return `${this.current ?? "unknown"} (${this.env.tabId})`;
	}

	async start(): Promise<void> {
		if (this.started || this.disabled) return;
		this.started = true;
		const generation = ++this.generation;

		const tab = await this.readTab();
		// `stop()` may have run while the seed read was in flight; do not resurrect
		// the stream or disable the feature after a deliberate shutdown.
		if (generation !== this.generation || !this.started) return;
		if (!tab) {
			this.started = false;
			this.disabled = true;
			this.logger?.("herdr tab: seed tab.get failed; disabled for this session");
			return;
		}

		this.baseLabel = stripKnownPrefix(tab.label);
		this.lastWrittenLabel = tab.label;
		this.current = tab.agentStatus;

		this.socket.subscribe(
			[{ type: "pane.agent_status_changed", pane_id: this.env.paneId }],
			(event) => this.handleEvent(event),
			(error) => this.reportError(error),
			() => {
				void this.reseed();
			},
		);

		this.setStatus(tab.agentStatus);
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		this.generation += 1;
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
			this.writeTimer = undefined;
		}
		this.socket.destroy();

		// Serialize with any rename already in flight so the restore write is the
		// last one to land. The socket request has its own bounded retry timeouts,
		// so awaiting it cannot hang; the restore below is separately bounded.
		const inFlight = this.inFlight;
		if (inFlight) {
			try {
				await inFlight;
			} catch {
				// The in-flight rename is best effort; restore below still runs.
			}
			if (this.inFlight === inFlight) this.inFlight = undefined;
		}

		const base = this.baseLabel;
		if (base === undefined || base === this.lastWrittenLabel) return;
		try {
			await withTimeout(
				this.socket.request("tab.rename", { tab_id: this.env.tabId, label: base }),
				this.restoreTimeoutMs,
			);
			this.lastWrittenLabel = base;
		} catch (error) {
			this.logger?.(`herdr tab: restore failed: ${messageOf(error)}`);
		}
	}

	private handleEvent(event: HerdrEvent): void {
		if (event.event !== "pane.agent_status_changed") return;
		// Defensive: the subscription is already pane-scoped, but ignore a
		// mismatched pane id if Herdr ever fans events out.
		const paneId = event.data.pane_id;
		if (typeof paneId === "string" && paneId !== this.env.paneId) return;
		const status = parseHerdrAgentStatus(event.data.agent_status);
		if (!status) return;
		this.statusRevision += 1;
		this.enqueueStatus(status);
	}

	private enqueueStatus(status: HerdrAgentStatus): void {
		this.pendingStatus = status;
		if (this.processing) return;
		void this.processStatusQueue();
	}

	private async processStatusQueue(): Promise<void> {
		this.processing = true;
		try {
			while (this.pendingStatus !== undefined) {
				const status = this.pendingStatus;
				this.pendingStatus = undefined;
				await this.rebaseIfRenamed();
				this.setStatus(status);
			}
		} finally {
			this.processing = false;
		}
	}

	/** Adopt a user rename before applying the next status. */
	private async rebaseIfRenamed(): Promise<void> {
		if (this.lastWrittenLabel === undefined) return;
		const tab = await this.readTab();
		if (!tab) return;
		if (tab.label !== this.lastWrittenLabel) {
			this.baseLabel = stripKnownPrefix(tab.label);
		}
	}

	/** Re-read state after a reconnect; Herdr may have moved on while away. */
	private async reseed(): Promise<void> {
		if (!this.started || this.disabled) return;
		const revision = this.statusRevision;
		const tab = await this.readTab();
		if (!tab || !this.started || this.disabled) return;
		// A live event that arrived while the seed read was in flight is newer;
		// discard the stale seed so it cannot overwrite the event.
		if (this.statusRevision !== revision) return;
		if (this.lastWrittenLabel === undefined || tab.label !== this.lastWrittenLabel) {
			this.baseLabel = stripKnownPrefix(tab.label);
		}
		this.setStatus(tab.agentStatus);
	}

	private setStatus(status: HerdrAgentStatus): void {
		if (!this.started || this.disabled) return;
		this.current = status;
		this.desiredLabel = composeLabel(this.baseLabel ?? "", status, this.style);
		try {
			this.onStatusChange?.(status);
		} catch (error) {
			this.logger?.(`herdr tab: onStatusChange threw: ${messageOf(error)}`);
		}
		this.queueWrite();
	}

	private reportError(error: unknown): void {
		try {
			this.onError?.(error);
		} catch (handlerError) {
			this.logger?.(`herdr tab: onError threw: ${messageOf(handlerError)}`);
		}
	}

	private queueWrite(): void {
		if (!this.started || this.disabled || this.desiredLabel === undefined) return;
		if (this.desiredLabel === this.lastWrittenLabel) {
			if (this.writeTimer) {
				clearTimeout(this.writeTimer);
				this.writeTimer = undefined;
			}
			return;
		}
		// An in-flight rename re-runs the queue when it settles.
		if (this.inFlight || this.writeTimer) return;
		this.writeTimer = setTimeout(() => {
			this.writeTimer = undefined;
			void this.drain();
		}, this.debounceMs);
		this.writeTimer.unref?.();
	}

	private drain(): void {
		if (!this.started || this.disabled || this.inFlight) return;
		const label = this.desiredLabel;
		if (label === undefined || label === this.lastWrittenLabel) return;

		let ok = false;
		const promise = this.socket
			.request("tab.rename", { tab_id: this.env.tabId, label })
			.then(
				() => {
					ok = true;
					this.lastWrittenLabel = label;
				},
				(error) => {
					this.logger?.(`herdr tab: rename failed: ${messageOf(error)}`);
					this.reportError(error);
				},
			);
		this.inFlight = promise;

		void promise.then(() => {
			if (this.inFlight === promise) this.inFlight = undefined;
			if (!this.started || this.disabled) return;
			// Coalesce anything that arrived while in flight; do not hot-loop on failure.
			if (ok && this.desiredLabel !== undefined && this.desiredLabel !== this.lastWrittenLabel) {
				this.drain();
			}
		});
	}

	private async readTab(): Promise<HerdrTabInfo | undefined> {
		try {
			const result = await this.socket.request<unknown>("tab.get", { tab_id: this.env.tabId });
			return parseHerdrTabInfo(result);
		} catch (error) {
			this.logger?.(`herdr tab: tab.get failed: ${messageOf(error)}`);
			return undefined;
		}
	}
}

function parseHerdrTabInfo(value: unknown): HerdrTabInfo | undefined {
	if (!isRecord(value)) return undefined;
	// Accept both `{ type: "tab_info", tab: {...} }` and a bare TabInfo.
	const source = isRecord(value.tab) ? value.tab : value;
	const label = typeof source.label === "string" ? source.label : undefined;
	const agentStatus = parseHerdrAgentStatus(source.agent_status);
	if (label === undefined || agentStatus === undefined) return undefined;
	const tabId = typeof source.tab_id === "string" ? source.tab_id : "";
	return { tabId, label, agentStatus };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new HerdrSocketError(`Timed out after ${timeoutMs} ms`, { code: "timeout" }));
		}, timeoutMs);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: string | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
