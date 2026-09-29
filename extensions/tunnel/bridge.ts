import type { TunnelAdapter, TunnelEvent, TunnelSnapshot } from './server'

export type PiContext = {
  cwd: string
  isIdle(): boolean
  abort(): void | Promise<void>
  sessionManager: {
    getSessionId(): string
    getSessionName?(): string | undefined
    getBranch(): unknown[]
    getLeafId?(): string | null
  }
}
export type PiApi = {
  on(name: string, handler: (event: any, ctx: PiContext) => void): void
  sendUserMessage(text: string, options?: { deliverAs: 'followUp' | 'steer' }): void | Promise<void>
  getSessionName?(): string | undefined
}

/** Adapter lifetime is tied to the current Pi extension instance, not the server.
 * invalidate() synchronously disables every handler and pending write from this instance.
 */
export function createPiBridge(pi: PiApi, initialContext: PiContext) {
  let context: PiContext | null = initialContext
  let live = true
  let busy = !initialContext.isIdle()
  const listeners = new Set<(event: Omit<TunnelEvent, 'seq'>) => void>()
  const identity = (ctx: PiContext) => ctx.sessionManager.getSessionId()
  const publish = (kind: string, data: unknown) => {
    if (!live || !context) return
    const event = { sessionId: identity(context), kind, data }
    for (const listener of listeners) listener(event)
  }
  const bind = (next: PiContext) => {
    if (!live) return
    context = next
    busy = !next.isIdle()
    publish('session_change', { sessionId: identity(next), branchId: next.sessionManager.getLeafId?.(), cwd: next.cwd, name: pi.getSessionName?.() ?? next.sessionManager.getSessionName?.() })
  }
  const invalidate = () => {
    live = false
    context = null
    listeners.clear()
  }
  const requireContext = () => {
    if (!live || !context) throw new Error('Pi is rebinding; retry')
    return context
  }
  const adapter: TunnelAdapter = {
    snapshot(): TunnelSnapshot {
      const ctx = requireContext()
      return {
        sessionId: identity(ctx), branchId: ctx.sessionManager.getLeafId?.() ?? null, cwd: ctx.cwd,
        name: pi.getSessionName?.() ?? ctx.sessionManager.getSessionName?.(),
        // Native branch entries retain message roles, thinking, tools and tool results.
        entries: ctx.sessionManager.getBranch(), busy: busy || !ctx.isIdle(),
      }
    },
    subscribe(emit) {
      if (!live) throw new Error('Pi is rebinding; retry')
      listeners.add(emit)
      return () => { listeners.delete(emit) }
    },
    prompt(text, mode) {
      const ctx = requireContext()
      if (typeof text !== 'string' || !text.trim() || text.length > 12_000 || !['normal', 'followUp', 'steer'].includes(mode)) throw new Error('Invalid prompt')
      if (mode === 'normal' && (busy || !ctx.isIdle())) throw new Error('Pi is busy; queue or steer instead')
      // No asynchronous gap between the guard and Pi's native send.
      if (mode === 'normal') return pi.sendUserMessage(text)
      return pi.sendUserMessage(text, { deliverAs: mode })
    },
    abort() {
      const ctx = requireContext()
      return ctx.abort()
    },
  }
  const event = (name: string) => pi.on(name, (payload, ctx) => {
    if (!live || !context || ctx.sessionManager.getSessionId() !== identity(context)) return
    if (name === 'agent_start') busy = true
    if (name === 'agent_end') busy = false
    // Pi event payloads are native, not a tunnel-specific chat schema.
    publish(name, payload)
  })
  for (const name of ['message_start', 'message_update', 'message_end', 'agent_start', 'agent_end', 'turn_start', 'turn_end', 'tool_execution_start', 'tool_execution_end']) event(name)
  return { adapter, bind, invalidate }
}
