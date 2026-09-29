import { randomInt, randomBytes, timingSafeEqual } from 'node:crypto'

export type PairMode = 'browser' | 'client'
export type Client = { id: string; token: string; mode: PairMode }

/** In-process credentials only. Never serialize this object or expose codes/tokens in logs. */
export class TunnelAuth {
  private challenge: { code: string; expires: number; failures: number } | null = null
  private clients = new Map<string, Client>()
  private attempts = new Map<string, { count: number; until: number }>()

  get pairedCount() { return this.clients.size }
  get pairingExpiresAt() { return this.challenge?.expires ?? null }

  newCode(): { code: string; expiresAt: number } {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
    const expiresAt = Date.now() + 300_000
    this.challenge = { code, expires: expiresAt, failures: 0 }
    return { code, expiresAt }
  }

  exchange(code: unknown, mode: PairMode, address: string): Client | null {
    const now = Date.now()
    // Bounded rate-limit state. This also limits guesses when no challenge exists.
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key)
    if (this.attempts.size > 1024) this.attempts.clear()
    const limit = this.attempts.get(address) ?? { count: 0, until: now + 60_000 }
    limit.count++
    this.attempts.set(address, limit)
    if (limit.count > 10) return null
    const challenge = this.challenge
    if (!challenge || challenge.expires <= now) { this.challenge = null; return null }
    const validFormat = typeof code === 'string' && /^\d{6}$/.test(code)
    const valid = validFormat && timingSafeEqual(Buffer.from(code), Buffer.from(challenge.code))
    if (!valid) {
      if (++challenge.failures >= 5) this.challenge = null
      return null
    }
    this.challenge = null
    const token = randomBytes(32).toString('base64url')
    const client = { id: randomBytes(16).toString('hex'), token, mode }
    this.clients.set(token, client)
    return client
  }

  authenticate(token: string | undefined, mode: PairMode): Client | null {
    if (!token) return null
    const client = this.clients.get(token)
    return client?.mode === mode ? client : null
  }

  revokeAll() { this.challenge = null; this.clients.clear(); this.attempts.clear() }
}
