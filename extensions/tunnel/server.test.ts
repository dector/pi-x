import { expect, test } from 'bun:test'
import { createTunnelServer, type TunnelAdapter, type TunnelEvent } from './server'

const port = 44000 + Math.floor(Math.random() * 10000)
const origin = `http://127.0.0.1:${port}`
const external = 'https://pi.example.ts.net'
const headers = { 'Content-Type': 'application/json', Origin: origin }

function fixture() {
  let emit!: (event: Omit<TunnelEvent, 'seq'>) => void
  const calls: unknown[] = []
  const adapter: TunnelAdapter = {
    snapshot: () => ({ sessionId: 's1', cwd: '/work', entries: [{ role: 'user', content: 'prior' }], busy: false }),
    subscribe: cb => { emit = cb; return () => { emit = () => {} } },
    prompt: (text, mode) => { calls.push([text, mode]) },
    abort: () => { calls.push('abort') }
  }
  const server = createTunnelServer(adapter, { port, externalOrigin: external })
  const send = (path: string, init?: RequestInit, base = origin) => fetch(base + path, init)
  return { server, send, calls, adapter, event: (kind: string) => emit({ sessionId: 's1', kind, data: { text: 'update' } }) }
}

test('pairing and authenticated routes, origin/CSRF, idempotency and rebind', async () => {
  const { server, send, calls, adapter, event } = fixture()
  try {
    expect((await send('/api/v1/session')).status).toBe(401)
    expect((await send('/api/v1/events')).status).toBe(401)
    let code = server.newPairCode().code
    expect((await send('/api/v1/pair', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify({ code }) })).status).toBe(403)
    const pair = await send('/api/v1/pair', { method: 'POST', headers, body: JSON.stringify({ code }) })
    expect(pair.status).toBe(200)
    const cookie = pair.headers.get('set-cookie')!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).not.toContain('Secure') // local HTTP only
    const proxyCode = server.newPairCode().code
    const proxyPair = await server.app.handle(new Request(origin + '/api/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: external }, body: JSON.stringify({ code: proxyCode }) }))
    expect(proxyPair.status).toBe(200)
    expect(proxyPair.headers.get('set-cookie')).toContain('Secure')
    expect((await send('/api/v1/pair', { method: 'POST', headers, body: JSON.stringify({ code }) })).status).toBe(401)
    const browser = { ...headers, Cookie: cookie }
    const snapshot = await (await send('/api/v1/session', { headers: browser })).json()
    expect(snapshot.entries[0].content).toBe('prior')
    expect(snapshot.sessionId).toBe('s1')
    expect((await send('/api/v1/prompts', { method: 'POST', headers: { ...browser, Origin: 'https://evil.example', 'Idempotency-Key': 'abc12345' }, body: JSON.stringify({ text: 'hi', mode: 'normal' }) })).status).toBe(403)
    const request = { method: 'POST', headers: { ...browser, 'Idempotency-Key': 'abc12345' }, body: JSON.stringify({ text: 'hi', mode: 'followUp' }) }
    expect((await send('/api/v1/prompts', request)).status).toBe(202)
    expect((await send('/api/v1/prompts', request)).status).toBe(202)
    expect(calls).toEqual([['hi', 'followUp']])
    server.setAdapter(null)
    expect((await send('/api/v1/prompts', { ...request, headers: { ...browser, 'Idempotency-Key': 'new12345' } })).status).toBe(503)
    server.setAdapter(adapter)
    expect((await send('/api/v1/abort', { method: 'POST', headers: { ...browser, 'Idempotency-Key': 'abort123' }, body: '{}' })).status).toBe(202)
    expect(calls).toEqual([['hi', 'followUp'], 'abort'])
    event('text')
    code = server.newPairCode().code
    const bearerPair = await send('/api/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, mode: 'client' }) })
    const { token } = await bearerPair.json()
    expect((await send('/api/v1/session', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
    server.close()
    expect(server.auth.pairedCount).toBe(0)
  } finally { server.close() }
})

test('Bun listener binds the requested port and releases it on close', async () => {
  const { server, send } = fixture()
  try {
    expect((await send('/api/v1/session')).status).toBe(401)
    expect(() => createTunnelServer(null, { port })).toThrow()
    expect((await server.app.handle(new Request(origin + '/api/v1/session'))).status).toBe(401)
  } finally { server.close() }
  expect((await server.app.handle(new Request(origin + '/api/v1/session'))).status).toBe(503)
  const replacement = createTunnelServer(null, { port })
  try { expect((await fetch(origin + '/api/v1/session')).status).toBe(401) }
  finally { replacement.close() }
})

test('SSE emits snapshot and updates, rejects unauthenticated access', async () => {
  const { server, send, event } = fixture()
  try {
    const code = server.newPairCode().code
    const paired = await send('/api/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, mode: 'client' }) })
    const { token } = await paired.json()
    const response = await send('/api/v1/events', { headers: { Authorization: `Bearer ${token}` } })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('event: snapshot')
    expect(first).toContain('prior')
    event('delta')
    const next = new TextDecoder().decode((await reader.read()).value)
    expect(next).toContain('event: delta')
    await reader.cancel()
  } finally { server.close() }
})
