import { afterEach, expect, test } from 'bun:test'
import tunnelExtension from './index'
import { createPiBridge, type PiContext } from './bridge'

function harness() {
  const handlers = new Map<string, Array<(event: any, ctx: PiContext) => void>>()
  const sent: Array<{ text: string; options?: object }> = []
  const messages: string[] = []
  let context = makeContext('one')
  const pi = {
    on(name: string, handler: (event: any, ctx: PiContext) => void) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
    },
    sendUserMessage(text: string, options?: object) { sent.push({ text, options }) },
    registerCommand(_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { this.command = command.handler },
    command: undefined as undefined | ((args: string, ctx: any) => Promise<void>),
    fire(name: string, payload: any = {}, ctx = context) { for (const handler of handlers.get(name) ?? []) handler(payload, ctx) },
    async run(args: string, ctx = context) { await this.command?.(args, { ...ctx, ui: { notify: (text: string) => messages.push(text) } }) },
    get context() { return context },
    set context(ctx: PiContext) { context = ctx },
    sent, messages,
  }
  return pi
}
function makeContext(id: string) {
  let idle = true
  let aborted = 0
  const branch = [{ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'why' }, { type: 'toolCall', arguments: { x: 1 } }] } }]
  return {
    cwd: `/repo/${id}`, isIdle: () => idle, abort: () => { aborted++ },
    sessionManager: { getSessionId: () => id, getSessionName: () => id, getLeafId: () => `${id}-leaf`, getBranch: () => branch },
    setIdle(value: boolean) { idle = value }, get aborted() { return aborted }, branch,
  }
}

test('native branch, busy modes, abort and stale adapter fail closed', () => {
  const pi = harness()
  const first = makeContext('one')
  const bridge = createPiBridge(pi, first)
  const events: any[] = []
  const detach = bridge.adapter.subscribe(event => events.push(event))
  expect(bridge.adapter.snapshot().entries).toBe(first.branch)
  expect(bridge.adapter.snapshot().name).toBe('one')
  bridge.adapter.prompt('hello', 'normal')
  pi.fire('agent_start', {}, first)
  expect(() => bridge.adapter.prompt('hello', 'normal')).toThrow('busy')
  bridge.adapter.prompt('queue', 'followUp')
  bridge.adapter.prompt('steer', 'steer')
  expect(pi.sent).toEqual([{ text: 'hello', options: undefined }, { text: 'queue', options: { deliverAs: 'followUp' } }, { text: 'steer', options: { deliverAs: 'steer' } }])
  pi.fire('message_update', { assistantMessageEvent: { type: 'thinking', text: 'secret' } }, first)
  expect(events.at(-1)).toMatchObject({ sessionId: 'one', kind: 'message_update' })
  pi.fire('message_start', { message: { role: 'user', content: 'terminal-origin' } }, first)
  expect(events.at(-1).data.message.content).toBe('terminal-origin')
  bridge.adapter.abort()
  expect(first.aborted).toBe(1)
  const second = makeContext('two')
  bridge.bind(second)
  pi.fire('message_end', { old: true }, first)
  expect(events.at(-1).kind).toBe('session_change')
  expect(bridge.adapter.snapshot().sessionId).toBe('two')
  expect(bridge.adapter.snapshot().branchId).toBe('two-leaf')
  bridge.invalidate()
  detach()
  expect(() => bridge.adapter.snapshot()).toThrow('rebinding')
  expect(() => bridge.adapter.prompt('stale', 'normal')).toThrow('rebinding')
  expect(() => bridge.adapter.abort()).toThrow('rebinding')
  pi.fire('agent_end', {}, second)
  expect(pi.sent).toHaveLength(3)
})

// No HTTP requests: test process owner and extension lifecycle in-process only.
const KEY = Symbol.for('px:tunnel:process-owner:v1')
afterEach(() => {
  const global = globalThis as any
  global[KEY]?.server.close()
  delete global[KEY]
  delete process.env.PI_TUNNEL_PORT
})

test('on is idempotent; shutdown unbinds old Pi, new instance rebinds; quit/off revoke', async () => {
  process.env.PI_TUNNEL_PORT = String(48000 + Math.floor(Math.random() * 10000))
  const first = harness()
  tunnelExtension(first as any)
  first.fire('session_start')
  await first.run('on')
  const owner = (globalThis as any)[KEY]
  expect(owner).toBeDefined()
  const server = owner.server
  await first.run('on')
  expect((globalThis as any)[KEY].server).toBe(server)
  first.fire('session_shutdown', { reason: 'reload' })
  expect(() => server.getStatus()).not.toThrow()
  expect(owner.bridge).toBeNull()
  await first.run('pair')
  expect(first.messages.at(-1)).toContain('shutting down')
  const second = harness()
  second.context = makeContext('new')
  tunnelExtension(second as any)
  second.fire('session_start')
  expect(owner.bridge.adapter.snapshot().sessionId).toBe('new')
  // Delayed shutdown of the previous instance must not unbind the new one.
  first.fire('session_shutdown', { reason: 'reload' })
  expect(owner.bridge.adapter.snapshot().sessionId).toBe('new')
  const tree = makeContext('branch')
  second.fire('session_tree', {}, tree)
  expect(owner.bridge.adapter.snapshot().sessionId).toBe('branch')
  second.fire('session_shutdown', { reason: 'quit' })
  expect((globalThis as any)[KEY]).toBeUndefined()
})

test('off revokes credentials and closes owner', async () => {
  process.env.PI_TUNNEL_PORT = String(48000 + Math.floor(Math.random() * 10000))
  const pi = harness()
  tunnelExtension(pi as any)
  await pi.run('on')
  const owner = (globalThis as any)[KEY]
  expect(owner).toBeDefined()
  await pi.run('off')
  expect((globalThis as any)[KEY]).toBeUndefined()
  expect(owner.server.auth.pairedCount).toBe(0)
})

test('invalid port fails closed without owner', async () => {
  process.env.PI_TUNNEL_PORT = '0'
  const pi = harness()
  tunnelExtension(pi as any)
  await pi.run('on')
  expect(pi.messages.at(-1)).toContain('PI_TUNNEL_PORT')
  expect((globalThis as any)[KEY]).toBeUndefined()
})
