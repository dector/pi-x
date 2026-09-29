import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createPiBridge, type PiApi, type PiContext } from './bridge'
import { createTunnelServer } from './server'

type Server = ReturnType<typeof createTunnelServer>
type Bridge = ReturnType<typeof createPiBridge>
type Owner = { server: Server; bridge: Bridge | null; lease: symbol; port: number; origin?: string }
const KEY = Symbol.for('px:tunnel:process-owner:v1')
const globalOwner = globalThis as typeof globalThis & { [KEY]?: Owner }

function config() {
  const raw = process.env.PI_TUNNEL_PORT ?? '43821'
  if (!/^[1-9]\d*$/.test(raw) || !Number.isInteger(Number(raw)) || Number(raw) > 65535) throw new Error('PI_TUNNEL_PORT must be an integer from 1 to 65535')
  return { port: Number(raw), origin: process.env.PI_TUNNEL_ORIGIN || undefined }
}

export default function tunnelExtension(pi: ExtensionAPI): void {
  const lease = Symbol('tunnel extension instance')
  const api = pi as unknown as PiApi
  let active = true

  function bind(ctx: PiContext) {
    if (!active) return
    const owner = globalOwner[KEY]
    if (!owner) return
    // Always detach the old Pi API before handing the server to this instance.
    if (owner.lease !== lease || !owner.bridge) {
      owner.bridge?.invalidate()
      owner.server.setAdapter(null)
      owner.bridge = createPiBridge(api, ctx)
      owner.lease = lease
    } else owner.bridge.bind(ctx)
    // Forces connected clients to resnapshot on branch/tree navigation.
    owner.server.setAdapter(owner.bridge.adapter)
  }

  for (const event of ['session_start', 'session_switch', 'session_fork', 'session_tree'] as const) {
    pi.on(event, (_payload, ctx) => bind(ctx as unknown as PiContext))
  }
  pi.on('session_shutdown', (event) => {
    active = false
    const owner = globalOwner[KEY]
    if (!owner || owner.lease !== lease) return
    owner.bridge?.invalidate()
    owner.bridge = null
    owner.server.setAdapter(null)
    if (event.reason === 'quit') {
      owner.server.close()
      delete globalOwner[KEY]
    }
  })

  pi.registerCommand('px:tunnel', {
    description: 'Phone tunnel: on, off, pair, status',
    getArgumentCompletions: prefix => ['on', 'off', 'pair', 'status'].filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = (args ?? '').trim().toLowerCase()
      const notify = (text: string, type: 'info' | 'error' = 'info') => ctx.ui.notify(text, type)
      if (!active) { notify('Tunnel Pi instance is shutting down; retry.', 'error'); return }
      let owner = globalOwner[KEY]
      if (action === 'on') {
        if (!owner) {
          try {
            const { port, origin } = config()
            // app.listen is synchronous; port conflicts are reported, never remapped.
            const server = createTunnelServer(null, { port, externalOrigin: origin })
            owner = { server, bridge: null, lease, port, origin }
            globalOwner[KEY] = owner
          } catch (error) {
            notify(`Tunnel failed to start: ${error instanceof Error ? error.message : String(error)}`, 'error')
            return
          }
        }
        bind(ctx as unknown as PiContext)
        const code = owner.server.newPairCode()
        notify(`Tunnel: http://127.0.0.1:${owner.port}${owner.origin ? ` · ${owner.origin}` : ''}\nPair code: ${code.code} (expires ${new Date(code.expiresAt).toLocaleTimeString()}).`)
        return
      }
      if (action === 'off') {
        if (owner) {
          owner.bridge?.invalidate()
          owner.server.close()
          delete globalOwner[KEY]
        }
        notify('Tunnel off; all paired clients revoked.')
        return
      }
      if (!owner) { notify('Tunnel is off. Run /px:tunnel on first.'); return }
      if (action === 'pair') {
        const code = owner.server.newPairCode()
        notify(`Pair code: ${code.code} (expires ${new Date(code.expiresAt).toLocaleTimeString()}).`)
      } else if (action === 'status') {
        const status = owner.server.getStatus()
        const session = await owner.bridge?.adapter.snapshot()
        notify(`Tunnel: http://127.0.0.1:${status.port}${owner.origin ? ` · ${owner.origin}` : ''}\nSession: ${session?.sessionId ?? 'Pi rebinding'}${session ? ` (${session.cwd})` : ''}\nPair code expires: ${status.pairingExpiresAt ? new Date(status.pairingExpiresAt).toLocaleTimeString() : 'none'} · Paired clients: ${status.pairedClients}`)
      } else notify('Usage: /px:tunnel on|off|pair|status', 'error')
    },
  })
}
