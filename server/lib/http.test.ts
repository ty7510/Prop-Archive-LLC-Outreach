import { describe, expect, it } from 'vitest'
import { LoginLimiter, passwordMatches } from './http.ts'

describe('passwordMatches', () => {
  it('accepts the exact password and nothing else', () => {
    expect(passwordMatches('correct horse', 'correct horse')).toBe(true)
    expect(passwordMatches('correct horse ', 'correct horse')).toBe(false)
    expect(passwordMatches('Correct horse', 'correct horse')).toBe(false)
    expect(passwordMatches('short', 'a much longer password')).toBe(false)
  })

  it('never matches when the server has no password or the client sent none', () => {
    expect(passwordMatches('', '')).toBe(false)
    expect(passwordMatches('anything', '')).toBe(false)
    expect(passwordMatches('', 'secret')).toBe(false)
  })
})

describe('LoginLimiter', () => {
  it('blocks after max failures inside the window and frees up when the window passes', () => {
    const limiter = new LoginLimiter(3, 1000)
    const t0 = 1_000_000
    expect(limiter.allowed('ip', t0)).toBe(true)
    limiter.recordFailure('ip', t0)
    limiter.recordFailure('ip', t0 + 10)
    expect(limiter.allowed('ip', t0 + 20)).toBe(true)
    limiter.recordFailure('ip', t0 + 30)
    expect(limiter.allowed('ip', t0 + 40)).toBe(false)
    expect(limiter.allowed('other-ip', t0 + 40)).toBe(true)
    expect(limiter.allowed('ip', t0 + 1001)).toBe(true)
  })

  it('reset clears one key and resetAll clears everything', () => {
    const limiter = new LoginLimiter(1, 60_000)
    limiter.recordFailure('a', 1)
    limiter.recordFailure('b', 1)
    expect(limiter.allowed('a', 2)).toBe(false)
    limiter.reset('a')
    expect(limiter.allowed('a', 2)).toBe(true)
    expect(limiter.allowed('b', 2)).toBe(false)
    limiter.resetAll()
    expect(limiter.allowed('b', 2)).toBe(true)
  })
})
