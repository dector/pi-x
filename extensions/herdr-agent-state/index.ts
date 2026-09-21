// FORK of the official Herdr Pi integration.
// Upstream: herdrdev/herdr src/integration/assets/pi/herdr-agent-state.ts
// (HERDR_INTEGRATION_ID=pi, HERDR_INTEGRATION_VERSION=9, v0.9.1 == master).
//
// Why: the official integration only knows `agentActive`, so it reports `idle`
// on `agent_settled`. A Pi session that detaches background work (for example a
// `subagent` async dispatch) therefore looks done while the work is still
// running. This fork adds the `herdr:background` lease: while any producer
// keeps an id active, the pane stays `working`.
//
// Transfer: re-vendor the official file and re-apply the hunks marked
// `FORK: background` (see README.md). Everything else stays upstream so the
// diff is small and rebasable.
//
// HERDR_INTEGRATION_ID=pi
// HERDR_INTEGRATION_VERSION=9
// @ts-nocheck

import net from "node:net";
import path from "node:path";

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
  process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const paneId = process.env.HERDR_PANE_ID;
const source = "herdr:pi";

function enabled() {
  return HERDR_ENV === "1" && !!socketPath && !!paneId;
}

function sendRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
  if (!enabled()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      socket.destroy();
      resolve(delivered);
    };

    const socket = net.createConnection(socketEndpoint!);
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
  });
}

async function sendRequest(request: unknown): Promise<void> {
  if (await sendRequestAttempt(request, 500)) {
    return;
  }
  await sendRequestAttempt(request, 1500);
}

type AgentState = "working" | "blocked" | "idle";

type QueuedState = {
  state: AgentState;
  message?: string;
  seq: number;
};

let reportSeq = Date.now() * 1000;
let currentAgentSessionId: string | undefined;
let currentAgentSessionPath: string | undefined;

function nextReportSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

function updateSessionRef(ctx: any): void {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    currentAgentSessionPath =
      typeof file === "string" &&
      (path.posix.isAbsolute(file) || path.win32.isAbsolute(file))
        ? file
        : undefined;
  } catch {
    currentAgentSessionPath = undefined;
  }

  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    currentAgentSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    currentAgentSessionId = undefined;
  }
}

function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
  if (currentAgentSessionPath) {
    return { ...params, agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { ...params, agent_session_id: currentAgentSessionId };
  }
  return params;
}

function currentSessionRef(): Record<string, unknown> | undefined {
  if (currentAgentSessionPath) {
    return { agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { agent_session_id: currentAgentSessionId };
  }
  return undefined;
}

function reportSession(sessionStartSource?: string): Promise<void> {
  const sessionRef = currentSessionRef();
  if (!sessionRef) {
    return Promise.resolve();
  }

  return sendRequest({
    id: `${source}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent_session",
    params: {
      pane_id: paneId,
      source,
      agent: "pi",
      seq: nextReportSeq(),
      session_start_source: sessionStartSource,
      ...sessionRef,
    },
  });
}

function sendState(state: AgentState, message?: string, seq = nextReportSeq()): Promise<void> {
  return sendRequest({
    id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent",
    params: withSessionRef({
      pane_id: paneId,
      source,
      agent: "pi",
      state,
      message,
      seq,
    }),
  });
}

let sendInFlight = false;
let queuedState: QueuedState | undefined;

function queueState(state: AgentState, message?: string): void {
  queuedState = { state, message, seq: nextReportSeq() };
  if (!sendInFlight) {
    void drainStateQueue();
  }
}

async function drainStateQueue(): Promise<void> {
  if (sendInFlight) {
    return;
  }

  sendInFlight = true;
  try {
    while (queuedState) {
      const next = queuedState;
      queuedState = undefined;
      await sendState(next.state, next.message, next.seq);
    }
  } finally {
    sendInFlight = false;
    if (queuedState) {
      void drainStateQueue();
    }
  }
}

// FORK: background-work lease helpers.

const MAX_BACKGROUND_ID_LENGTH = 128;

/** Event other extensions emit to hold the pane `working` while they run work. */
export const HERDR_BACKGROUND_EVENT = "herdr:background";

export function parseBackgroundId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_BACKGROUND_ID_LENGTH
    ? value
    : undefined;
}

/** Apply one `herdr:background` payload. Returns true when the set changed. */
export function applyBackgroundEvent(background: Set<string>, data: unknown): boolean {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const id = parseBackgroundId((data as { id?: unknown }).id);
  if (!id) {
    return false;
  }
  const active = (data as { active?: unknown }).active;
  if (active === true) {
    if (background.has(id)) {
      return false;
    }
    background.add(id);
    return true;
  }
  if (active === false) {
    return background.delete(id);
  }
  return false;
}

export interface AgentStateInput {
  blockedCount: number;
  blockedMessage?: string;
  agentActive: boolean;
  /** Number of active `herdr:background` leases. */
  backgroundCount: number;
}

/**
 * Semantic state for one pane. A blocked user wait always wins over working;
 * background work keeps the pane working after the accepting turn settles.
 */
export function desiredAgentState(input: AgentStateInput): { state: AgentState; message?: string } {
  if (input.blockedCount > 0) {
    return { state: "blocked", message: input.blockedMessage };
  }
  if (input.agentActive || input.backgroundCount > 0) {
    return { state: "working", message: undefined };
  }
  return { state: "idle", message: undefined };
}

export default function (pi) {
  if (!enabled()) {
    return;
  }

  let agentActive = false;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let rootSession = false;
  // FORK: background ids currently holding the pane in `working`.
  const background = new Set<string>();

  function desiredState() {
    // FORK: background work keeps the pane working after a settled turn.
    return desiredAgentState({ blockedCount, blockedMessage, agentActive, backgroundCount: background.size });
  }

  function publishState(force = false) {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) {
      return;
    }
    lastState = next.state;
    lastMessage = next.message;
    queueState(next.state, next.message);
  }

  pi.events.on("herdr:blocked", (data) => {
    if (!rootSession) {
      return;
    }
    if (!data?.active) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) {
        blockedMessage = undefined;
      }
      publishState();
      return;
    }

    blockedCount += 1;
    blockedMessage = data.label;
    publishState();
  });

  // FORK: `herdr:background` lease. Producers (for example the `subagent`
  // extension) mark an id active while detached work is running and clear it
  // when that work settles. Events that arrive before `session_start` are
  // buffered in the set and published once `rootSession` is set, so producer
  // and integration startup order does not matter.
  pi.events.on(HERDR_BACKGROUND_EVENT, (data) => {
    if (!applyBackgroundEvent(background, data)) {
      return;
    }
    if (rootSession) {
      publishState();
    }
  });

  pi.on("session_start", async (event, ctx) => {
    // TUI only: RPC/JSON/print modes are headless (no PTY herdr can display),
    // and RPC still reports hasUI=true, so mode is the reliable gate.
    if (ctx?.mode !== "tui") {
      return;
    }
    rootSession = true;
    updateSessionRef(ctx);
    await reportSession(event?.reason);
    // A reload can replace this extension mid-run without emitting another agent_start.
    agentActive = ctx?.isIdle?.() === false;
    publishState(true);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) {
      return;
    }
    updateSessionRef(ctx);
    void reportSession();
    agentActive = true;
    publishState();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || ctx?.isIdle?.() !== true) {
      return;
    }

    agentActive = false;
    publishState();
  });

  // FORK: a replacement session must not inherit background ids.
  pi.on("session_shutdown", () => {
    background.clear();
  });
}
