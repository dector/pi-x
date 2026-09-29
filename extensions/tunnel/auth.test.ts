import { expect, test } from 'bun:test'
import { TunnelAuth } from './auth'

test('six-digit single-use codes, new pairing preserves clients, revoke clears', () => {
  const auth = new TunnelAuth()
  const first = auth.newCode()
  expect(first.code).toMatch(/^\d{6}$/)
  const a = auth.exchange(first.code, 'client', 'a')!
  expect(a.token.length).toBeGreaterThan(30)
  expect(auth.exchange(first.code, 'client', 'a')).toBeNull()
  const b = auth.exchange(auth.newCode().code, 'browser', 'b')!
  expect(auth.authenticate(a.token, 'client')).toEqual(a)
  expect(auth.authenticate(b.token, 'client')).toBeNull()
  auth.revokeAll()
  expect(auth.authenticate(a.token, 'client')).toBeNull()
})

test('five guesses invalidate a challenge and rate limit guesses', () => {
  const auth = new TunnelAuth()
  const code = auth.newCode().code
  const wrong = code === '000000' ? '111111' : '000000'
  for (let i = 0; i < 5; i++) expect(auth.exchange(wrong, 'client', 'ip')).toBeNull()
  expect(auth.exchange(code, 'client', 'ip')).toBeNull()
  const second = auth.newCode().code
  for (let i = 0; i < 11; i++) auth.exchange('bad', 'client', 'other')
  expect(auth.exchange(second, 'client', 'other')).toBeNull()
})

test('expired codes cannot pair', () => {
  const auth = new TunnelAuth()
  const code = auth.newCode().code
  const original = Date.now
  Date.now = () => original() + 300_001
  try { expect(auth.exchange(code, 'client', 'ip')).toBeNull() }
  finally { Date.now = original }
})
