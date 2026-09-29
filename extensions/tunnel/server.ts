import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, sep } from 'node:path'
import { TunnelAuth, type Client } from './auth'

/** Wire types: data/entries are native Pi JSON values (including thinking and tool content).
 * The adapter must expose ONLY the currently active branch and must detach its event
 * handler when unsubscribe is called. Calls may be async; never retain a stale Pi context
 * across /reload: call setAdapter(null) before rebinding the new adapter.
 * emit() must be called for all Pi producers, not just tunnel-origin prompts.
 */
export type TunnelEvent = { seq: number; sessionId: string; kind: string; data: unknown }
export type TunnelSnapshot = { sessionId: string; branchId?: string | null; cwd: string; name?: string; entries: unknown[]; busy: boolean }
export interface TunnelAdapter {
  snapshot(): TunnelSnapshot | Promise<TunnelSnapshot>
  subscribe(emit: (event: Omit<TunnelEvent, 'seq'>) => void): () => void
  /** Must use pi.sendUserMessage(text, { deliverAs }) for followUp/steer. */
  prompt(text: string, mode: 'normal' | 'followUp' | 'steer'): void | Promise<void>
  /** Abort the active Pi run. */
  abort(): void | Promise<void>
}
export type TunnelOptions = { port?: number; host?: string; externalOrigin?: string }

const json = (value: unknown, status = 200, headers?: HeadersInit) => Response.json(value, { status, headers })
const error = (status: number, message: string) => json({ error: message }, status)
const webRoot = resolve(fileURLToPath(new URL('./web/', import.meta.url)))
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
const MAX_BODY = 16_384
const MAX_EVENT = 256_000
const MAX_QUEUE = 32

/** Start one in-memory HTTP server (default 127.0.0.1:55555; throws on port conflict).
 * Browser: POST /api/v1/pair {code,mode:"browser"} with Origin; receives HttpOnly
 * SameSite=Strict cookie (Secure for HTTPS/external HTTPS proxy). Client: pair
 * {code,mode:"client"} receives bearer token. No credentials belong in URLs.
 * GET /api/v1/session returns {version:1,seq,...snapshot}; GET /api/v1/events
 * sends SSE snapshot, then {seq,sessionId,kind,data} events; resync means fetch
 * a fresh snapshot and reconnect. No replay journal. GET / serves ./web assets.
 * POST /api/v1/prompts {text,mode} and POST /api/v1/abort {} require JSON,
 * Origin for cookie callers and Idempotency-Key (8-128 URL-safe chars).
 * Writes return 202 {accepted:true}, invalid input 400, unauthenticated 401,
 * forbidden Origin/Host 403, unavailable Pi 503. Tokens are process-only.
 * externalOrigin is the configured Tailscale Serve HTTPS origin; no forwarding
 * headers are trusted. Direct HTTP on an untrusted network is unsupported.
 */
export function createTunnelServer(initialAdapter: TunnelAdapter | null, options: TunnelOptions = {}) {
  const port = options.port ?? 55555
  const host = options.host ?? '127.0.0.1'
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid tunnel port')
  const external = options.externalOrigin ? new URL(options.externalOrigin) : null
  if (external && (external.protocol !== 'https:' || external.pathname !== '/' || external.search || external.hash || external.username || external.password)) throw new Error('externalOrigin must be an HTTPS origin')
  const localOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  // Serve terminates HTTPS and preserves the original Host over HTTP.
  // Accept tailnet hosts without requiring a process-level origin setting.
  const origins = new Set([...(host === '127.0.0.1' || host === 'localhost' ? localOrigins : []), ...(external ? [external.origin, `http://${external.host}`] : [])])
  const tailnetHost = (url: URL) => url.hostname.endsWith('.ts.net') && url.hostname.length > '.ts.net'.length && (url.protocol === 'http:' || url.protocol === 'https:')
  if (!origins.size) throw new Error('Configure an external HTTPS origin for non-loopback binding')
  const auth = new TunnelAuth()
  let adapter: TunnelAdapter | null = null
  let detach: (() => void) | null = null
  let generation = 0
  let seq = 0
  let closed = false
  type Stream = { push: (event: TunnelEvent | { kind: 'resync'; seq: number }) => void; close: () => void }
  const streams = new Set<Stream>()
  const dedup = new Map<string, Map<string, { generation: number; sessionId: string; payload: string; response: Promise<Response> }>>()

  function emit(event: Omit<TunnelEvent, 'seq'>) {
    const wire = { ...event, seq: ++seq }
    for (const stream of streams) stream.push(wire)
  }
  function setAdapter(next: TunnelAdapter | null) {
    if (closed) throw new Error('Tunnel is closed')
    generation++
    detach?.()
    detach = null
    adapter = next
    const current = generation
    if (next) detach = next.subscribe(event => { if (generation === current && adapter === next) emit(event) })
    const resync = { kind: 'resync' as const, seq: ++seq }
    for (const stream of streams) stream.push(resync)
  }
  setAdapter(initialAdapter)

  async function body(request: Request): Promise<any> {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new Error('JSON content type required')
    if (Number(request.headers.get('content-length')) > MAX_BODY) throw new Error('Body too large')
    const text = await request.text()
    if (Buffer.byteLength(text) > MAX_BODY) throw new Error('Body too large')
    return JSON.parse(text)
  }
  function credentials(request: Request): Client | null {
    const bearer = request.headers.get('authorization')
    if (bearer) return /^Bearer [A-Za-z0-9_-]+$/.test(bearer) ? auth.authenticate(bearer.slice(7), 'client') : null
    const cookie = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('tunnel_session='))?.slice(15)
    return auth.authenticate(cookie, 'browser')
  }
  function originAllowed(request: Request, write: boolean, client?: Client | null): boolean {
    const origin = request.headers.get('origin')
    const url = new URL(request.url)
    // A browser writing through Serve must come from this exact HTTPS host and port,
    // not merely another subdomain on the same tailnet.
    const tailnetOrigin = tailnetHost(url) && origin === `https://${url.host}`
    if (tailnetHost(url) && origin && !tailnetOrigin) return false
    if (origin && !localOrigins.has(origin) && origin !== external?.origin && !tailnetOrigin) return false
    if (write && client?.mode === 'browser' && (!origin || (!origins.has(origin) && !tailnetOrigin))) return false
    return true
  }
  async function serveStatic(path: string): Promise<Response> {
    const target = resolve(webRoot, '.' + (path === '/' ? '/index.html' : path))
    if (!target.startsWith(webRoot + sep) && target !== resolve(webRoot, 'index.html')) return error(404, 'Not found')
    try {
      const content = await readFile(target)
      const extension = target.slice(target.lastIndexOf('.'))
      return new Response(content, { headers: { 'Content-Type': mime[extension] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
    } catch { return error(404, 'Not found') }
  }
  async function handle(request: Request): Promise<Response> {
    if (closed) return error(503, 'Unavailable')
    const url = new URL(request.url)
    if (!origins.has(url.origin) && !tailnetHost(url)) return error(403, 'Forbidden host')
    if (request.method === 'OPTIONS') return error(405, 'Method not allowed') // no permissive CORS
    if (url.pathname === '/' || (!url.pathname.startsWith('/api/') && request.method === 'GET')) return serveStatic(url.pathname)
    if (!url.pathname.startsWith('/api/v1/')) return error(404, 'Not found')
    if (url.pathname === '/api/v1/pair' && request.method === 'POST') {
      if (!originAllowed(request, true)) return error(403, 'Forbidden')
      try {
        const data = await body(request)
        const mode = data?.mode === 'client' ? 'client' : data?.mode === 'browser' || data?.mode === undefined ? 'browser' : null
        if (!mode) return error(400, 'Invalid request')
        // Do not trust X-Forwarded-For: proxy-provided client IP is attacker-controlled.
        if (mode === 'browser' && !request.headers.get('origin')) return error(403, 'Origin required')
        const client = auth.exchange(data?.code, mode, 'global')
        if (!client) return error(401, 'Invalid pairing code')
        if (mode === 'client') return json({ token: client.token, tokenType: 'Bearer' }, 200, { 'Cache-Control': 'no-store' })
        const secure = request.headers.get('origin')?.startsWith('https://') || url.protocol === 'https:'
        return json({ paired: true }, 200, { 'Set-Cookie': `tunnel_session=${client.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`, 'Cache-Control': 'no-store' })
      } catch { return error(400, 'Invalid request') }
    }
    const client = credentials(request)
    if (!client) return error(401, 'Unauthorized')
    if (!originAllowed(request, request.method !== 'GET', client)) return error(403, 'Forbidden')
    if (url.pathname === '/api/v1/session' && request.method === 'GET') {
      const current = adapter, stamp = generation
      if (!current) return error(503, 'Pi unavailable')
      try {
        // A snapshot must never be labelled with a sequence newer than its contents.
        // Retry if an event lands while the (possibly async) snapshot is captured.
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = seq
          const snapshot = await current.snapshot()
          if (generation !== stamp) return error(503, 'Pi rebinding; retry')
          if (seq === before) return json({ version: 1, seq: before, ...snapshot }, 200, { 'Cache-Control': 'no-store' })
        }
        return error(503, 'Session changing; retry')
      } catch { return error(503, 'Pi unavailable') }
    }
    if (url.pathname === '/api/v1/events' && request.method === 'GET') {
      const cursor = request.headers.get('last-event-id')
      let drain: (() => void) | undefined
      let cancelStream: (() => void) | undefined
      return new Response(new ReadableStream({
        start(controller) {
          const queue: string[] = []
          let pending = false, ended = false, snapshotReady = false
          function close() { if (ended) return; ended = true; clearInterval(heartbeat); streams.delete(stream); queue.length = 0; try { controller.close() } catch {} }
          cancelStream = close
          function flush() {
            if (pending || ended || !snapshotReady) return
            pending = true
            queueMicrotask(() => {
              pending = false
              try { while (queue.length && (controller.desiredSize ?? 0) > 0) controller.enqueue(new TextEncoder().encode(queue.shift()!)) }
              catch { close() }
            })
          }
          drain = flush
          function push(event: TunnelEvent | { kind: 'resync'; seq: number }) {
            if (ended) return
            const line = `id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`
            if (Buffer.byteLength(line) > MAX_EVENT || queue.length >= MAX_QUEUE) {
              try { controller.enqueue(new TextEncoder().encode('event: resync\ndata: {"kind":"resync","reason":"stream_limit"}\n\n')) } catch {}
              close(); return
            }
            queue.push(line); flush()
          }
          const stream: Stream = { push, close }
          const heartbeat = setInterval(() => { if (!ended) { if (queue.length >= MAX_QUEUE) close(); else { queue.push(': keepalive\n\n'); flush() } } }, 15_000)
          streams.add(stream)
          if (cursor !== null && cursor !== String(seq)) push({ kind: 'resync', seq })
          const current = adapter, stamp = generation
          if (!current) { snapshotReady = true; push({ kind: 'resync', seq }) }
          else {
            const before = seq
            Promise.resolve().then(() => current.snapshot()).then(snapshot => {
            if (ended) return
            if (stamp !== generation || seq !== before) { snapshotReady = true; push({ kind: 'resync', seq }); return }
            const line = `id: ${before}\nevent: snapshot\ndata: ${JSON.stringify({ kind: 'snapshot', seq: before, snapshot })}\n\n`
            // Full history is always available via GET /session. Avoid an unbounded
            // duplicate SSE frame for very large existing branches.
            if (Buffer.byteLength(line) > 2_000_000) {
              queue.unshift(`id: ${before}\nevent: snapshot_omitted\ndata: ${JSON.stringify({ kind: 'snapshot_omitted', seq: before, reason: 'snapshot_too_large', sessionId: snapshot.sessionId })}\n\n`)
            } else queue.unshift(line)
            snapshotReady = true; flush()
          }).catch(() => { snapshotReady = true; push({ kind: 'resync', seq }) })
          }
          request.signal.addEventListener('abort', close, { once: true })
        },
        pull() { drain?.() },
        cancel() { cancelStream?.() }
      }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' } })
    }
    if ((url.pathname === '/api/v1/prompts' || url.pathname === '/api/v1/abort') && request.method === 'POST') {
      const current = adapter, stamp = generation
      if (!current) return error(503, 'Pi unavailable')
      let data: any
      try { data = await body(request) } catch { return error(400, 'Invalid JSON request') }
      if (generation !== stamp) return error(503, 'Pi rebinding; retry')
      const key = request.headers.get('idempotency-key')
      if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) return error(400, 'Idempotency-Key required')
      if (url.pathname.endsWith('/prompts') && (typeof data?.text !== 'string' || !data.text.trim() || data.text.length > 12_000 || !['normal', 'followUp', 'steer'].includes(data.mode))) return error(400, 'Invalid prompt')
      const cache = dedup.get(client.id) ?? new Map<string, Promise<Response>>()
      dedup.set(client.id, cache)
      let sessionId: string
      try { sessionId = (await current.snapshot()).sessionId } catch { return error(503, 'Pi unavailable') }
      if (generation !== stamp) return error(503, 'Pi rebinding; retry')
      const payload = JSON.stringify([url.pathname, data])
      const existing = cache.get(key)
      if (existing) {
        if (existing.generation !== stamp || existing.sessionId !== sessionId || existing.payload !== payload) return error(409, 'Idempotency key belongs to a different request or session')
        return (await existing.response).clone()
      }
      const result = (async () => {
        try {
          if (generation !== stamp) return error(503, 'Pi rebinding; retry')
          if (url.pathname.endsWith('/prompts')) await current.prompt(data.text, data.mode)
          else await current.abort()
          return json({ accepted: true }, 202)
        } catch { return json({ accepted: false, error: 'Pi operation failed; acceptance unknown' }, 503) }
      })()
      cache.set(key, { generation: stamp, sessionId, payload, response: result })
      if (cache.size > 256) cache.delete(cache.keys().next().value!)
      return (await result).clone()
    }
    return error(404, 'Not found')
  }
  // Keep the test-facing handle interface while avoiding Elysia's TypeBox imports:
  // Pi's bundled runtime resolves those imports to incompatible virtual modules.
  const listener = Bun.serve({ port, hostname: host, fetch: handle })
  const app = { handle, stop: () => listener.stop(true) }
  return {
    app, port, host, auth,
    newPairCode: () => auth.newCode(),
    setAdapter,
    getStatus: () => ({ port, host, pairingExpiresAt: auth.pairingExpiresAt, pairedClients: auth.pairedCount }),
    close() { if (closed) return; closed = true; generation++; detach?.(); adapter = null; for (const stream of streams) stream.close(); auth.revokeAll(); dedup.clear(); app.stop() }
  }
}
