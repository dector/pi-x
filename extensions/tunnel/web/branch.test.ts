import { describe, expect, test } from 'bun:test'
import { isBranchSwitch } from './branch.js'

const entries = (...ids: string[]) => ids.map(id => ({ id, type: 'message', message: { role: 'assistant', content: id } }))
const snapshot = (ids: string[], branchId = ids.at(-1) ?? null, sessionId = 'session') => ({ sessionId, branchId, entries: entries(...ids) })

describe('conversation navigation', () => {
  test('a response advancing the leaf does not reset scroll', () => {
    expect(isBranchSwitch(snapshot(['a']), snapshot(['a', 'b']))).toBe(false)
  })
  test('reconnecting to the same branch does not reset scroll', () => {
    expect(isBranchSwitch(snapshot(['a', 'b']), snapshot(['a', 'b']))).toBe(false)
  })
  test('a different session resets scroll', () => {
    expect(isBranchSwitch(snapshot(['a']), snapshot(['a', 'b'], 'b', 'other'))).toBe(true)
  })
  test('forking or navigating back resets scroll', () => {
    expect(isBranchSwitch(snapshot(['a', 'b']), snapshot(['a', 'c']))).toBe(true)
    expect(isBranchSwitch(snapshot(['a', 'b']), snapshot(['a']))).toBe(true)
  })
  test('same-length leaf navigation resets scroll', () => {
    expect(isBranchSwitch(snapshot(['a'], 'first'), snapshot(['a'], 'second'))).toBe(true)
  })
})
