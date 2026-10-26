import { describe, expect, it } from 'vitest'
import { appendApiPath, AuthRequestContext } from './authRequestContext'

describe('AuthRequestContext', () => {
  it('cancels every previous generation without storing a server session', () => {
    const context = new AuthRequestContext()
    const previous = context.capture()
    context.invalidate()
    expect(previous.signal.aborted).toBe(true)
    expect(() => previous.assertCurrent()).toThrow(expect.objectContaining({ name: 'AbortError' }))
    expect(() => context.capture().assertCurrent()).not.toThrow()
    expect(context.epoch).toBe(1)
  })

  it('advances on identity or fact-version changes and honours caller cancellation', () => {
    const context = new AuthRequestContext()
    context.acceptIdentity('issuer/alice/version1')
    const old = context.capture()
    context.acceptIdentity('issuer/alice/version1')
    expect(old.signal.aborted).toBe(false)
    context.acceptIdentity('issuer/bob/version2')
    expect(old.signal.aborted).toBe(true)
    const controller = new AbortController()
    const current = context.capture(controller.signal)
    controller.abort()
    expect(() => current.assertCurrent()).toThrow()
  })

  it('preserves app prefixes and rejects traversal or endpoint injection', () => {
    expect(appendApiPath('https://edge.example/apps/one', '/api/value?q=1')).toBe('https://edge.example/apps/one/api/value?q=1')
    expect(appendApiPath('/apps/one', '/api/value')).toBe('/apps/one/api/value')
    for (const path of ['//evil.example', '/../auth/logout', '/%2e%2e/auth/logout', '/api\\other', 'https://evil.example']) {
      expect(() => appendApiPath('/apps/one', path)).toThrow()
    }
    expect(() => appendApiPath('https://user@evil.example', '/api/value')).toThrow()
  })
})
