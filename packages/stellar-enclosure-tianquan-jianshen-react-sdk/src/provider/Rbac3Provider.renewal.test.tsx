import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { type PropsWithChildren, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionSnapshot } from '../types'
import { snapshotContext } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import { Rbac3RequestError } from '../errors'
import { useRbac3Authorization } from '../hooks/useRbac3Authorization'
import { fixture, snapshot, about } from '../test/permissionFixtures'
import { PermissionGuard } from '../guards/PermissionGuard'
import { Rbac3Provider } from './Rbac3Provider'

const NOW = Date.parse('2026-11-22T12:00:00Z')
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { await act(async () => { await Promise.resolve() }) }
const advance = async (milliseconds: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}
const expiry = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString()

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('Rbac3Provider natural snapshot renewal', () => {
  it('renews fifteen seconds early and preserves a mounted draft and READY view while the server expiry is valid', async () => {
    const renewed = deferred<PermissionSnapshot>()
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const props = fixture({ getPermissionSnapshot: vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(renewed.promise) }, first)
    const Draft = () => {
      const [text, setText] = useState('')
      return <input aria-label="draft" value={text} onChange={event => setText(event.target.value)} />
    }
    const Host = () => {
      const [binding, setBinding] = useState(props.binding)
      return <Rbac3Provider {...props} binding={binding} onContextChange={setBinding}>
        <PermissionGuard requirement={{ mode: 'ALL', codes: ['order:read'] }}><Draft /></PermissionGuard>
      </Rbac3Provider>
    }
    render(<Host />)
    await flush()
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'unsaved draft' } })
    await advance(14_999)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(2)
    expect(props.client.getAbout).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText<HTMLInputElement>('draft').value).toBe('unsaved draft')
    await act(async () => renewed.resolve(snapshot({ snapshotExpiresAt: expiry(30_000) })))
    expect(screen.getByLabelText<HTMLInputElement>('draft').value).toBe('unsaved draft')
    expect(props.client.replaceActiveRoles).not.toHaveBeenCalled()
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(2)
  })

  it('immediately renews a snapshot received with 4.9 seconds left, closes on expiry, and recovers from a valid late response', async () => {
    const pending = deferred<PermissionSnapshot>()
    const first = snapshot({ snapshotExpiresAt: expiry(4_900) })
    const props = fixture({ getPermissionSnapshot: vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise) }, first)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(0)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(2)
    expect(result.current.status).toBe('READY')
    await advance(4_900)
    expect(result.current.snapshot).toBeNull()
    expect(result.current.status).toBe('ERROR_RETRYABLE')
    await act(async () => pending.resolve(snapshot({ snapshotExpiresAt: expiry(30_000) })))
    expect(result.current.status).toBe('READY')
    expect(result.current.snapshot?.snapshotExpiresAt).toBe(expiry(30_000))
  })

  it('throttles an unchanged server expiry and stops bounded 503 retries without extending the old snapshot', async () => {
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const unavailable = new Rbac3RequestError({ status: 503, code: 'INVALID_RESPONSE', message: 'unavailable', retryable: true })
    const props = fixture({ getPermissionSnapshot: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(first).mockRejectedValue(unavailable) }, first)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(15_000)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(2)
    expect(result.current.snapshot?.snapshotExpiresAt).toBe(first.snapshotExpiresAt)
    await advance(999)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(2)
    await advance(60_000)
    const calls = vi.mocked(props.client.getPermissionSnapshot).mock.calls.length
    expect(calls).toBeGreaterThan(2)
    expect(calls).toBeLessThanOrEqual(7)
    expect(result.current.snapshot).toBeNull()
    await advance(60_000)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(calls)
    expect(props.client.replaceActiveRoles).not.toHaveBeenCalled()
  })

  it.each([401, 403])('immediately revokes the view on renewal %s and does not retry', async status => {
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const props = fixture({ getPermissionSnapshot: vi.fn().mockResolvedValueOnce(first).mockRejectedValue(
      new Rbac3RequestError({ status, code: 'PERMISSION_DENIED', message: 'denied', retryable: false })) }, first)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(15_000)
    expect(result.current.snapshot).toBeNull()
    expect(result.current.status).toBe(status === 401 ? 'AUTHENTICATION_REQUIRED' : 'FORBIDDEN_NO_ROUTE')
    await advance(60_000)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(2)
  })

  it('aborts an in-flight renewal on logout and ignores late old-session responses', async () => {
    const pending = deferred<PermissionSnapshot>()
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const fetch = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise)
    const props = fixture({ getPermissionSnapshot: fetch }, first)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result, unmount } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(15_000)
    const signal = fetch.mock.calls[1]?.[0] as AbortSignal
    act(() => props.requestContext.invalidate())
    expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve(snapshot({ snapshotExpiresAt: expiry(30_000) })))
    expect(result.current.snapshot).toBeNull()
    await advance(60_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    unmount()
  })

  it.each([
    { subject: 'bob' },
    { issuer: 'https://other.example/tenants/1001' },
    { authVersion: '10' },
    { policyVersion: '12' },
    { catalogVersion: '6' },
    { catalogScope: { ...snapshot().catalogScope, namespaceCode: 'other' } },
    { activeRoleContext: { applicationCode: 'orders', rootRoleIds: ['21'], effectiveRoleIds: ['21'] } },
  ])('rejects a renewed snapshot with untrusted identity, scope, version, or unfenced roles: %j', async overrides => {
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const props = fixture({ getPermissionSnapshot: vi.fn().mockResolvedValueOnce(first)
      .mockImplementation(async () => snapshot({ snapshotExpiresAt: expiry(30_000), ...overrides })) }, first)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(15_000)
    expect(result.current.snapshot).toBeNull()
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(2)
  })

  it('accepts monotone facts with a matching About and handles the host echo without clearing READY', async () => {
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const next = () => snapshot({ snapshotExpiresAt: expiry(30_000), authVersion: '12', policyVersion: '14', catalogVersion: '8' })
    const props = fixture({ getPermissionSnapshot: vi.fn().mockResolvedValueOnce(first).mockImplementation(async () => next()),
      getAbout: vi.fn().mockResolvedValueOnce(about).mockImplementation(async () => ({ ...about, authVersion: 12, policyVersion: 14 })) }, first)
    const wrapper = ({ children }: PropsWithChildren) => {
      const [binding, setBinding] = useState(props.binding)
      return <Rbac3Provider {...props} binding={binding} onContextChange={setBinding}>{children}</Rbac3Provider>
    }
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(15_000)
    expect(result.current.status).toBe('READY')
    expect(result.current.binding).toEqual(snapshotContext(next(), 0))
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(2)
  })

  it('rejects About/snapshot version skew', async () => {
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const props = fixture({ getPermissionSnapshot: vi.fn().mockResolvedValueOnce(first)
      .mockImplementation(async () => snapshot({ snapshotExpiresAt: expiry(30_000), authVersion: '12' })) }, first)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(15_000)
    expect(result.current.snapshot).toBeNull()
  })

  it('does not install a response that expires while the parallel About read is still pending', async () => {
    const pendingAbout = deferred<typeof about>()
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const props = fixture({ getAbout: vi.fn().mockResolvedValueOnce(about).mockReturnValueOnce(pendingAbout.promise),
      getPermissionSnapshot: vi.fn().mockResolvedValueOnce(first)
        .mockImplementation(async () => snapshot({ snapshotExpiresAt: expiry(5_000) })) }, first)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(20_001)
    await act(async () => pendingAbout.resolve(about))
    expect(result.current.snapshot).toBeNull()
    expect(result.current.errorCode).toBe('INVALID_RESPONSE')
    await advance(60_000)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(2)
  })

  it('aborts on unmount and removes both renewal and retry timers', async () => {
    const pending = deferred<PermissionSnapshot>()
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const fetch = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise)
    const props = fixture({ getPermissionSnapshot: fetch }, first)
    const onContextChange = vi.fn()
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props} onContextChange={onContextChange}>{children}</Rbac3Provider>
    const { unmount } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(15_000)
    const signal = fetch.mock.calls[1]?.[0] as AbortSignal
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve(snapshot({ snapshotExpiresAt: expiry(30_000) })))
    await advance(60_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(onContextChange).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a queued transient retry on logout without crossing into a new login', async () => {
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const props = fixture({ getPermissionSnapshot: vi.fn().mockResolvedValueOnce(first).mockRejectedValue(
      new Rbac3RequestError({ status: 503, code: 'INVALID_RESPONSE', message: 'unavailable', retryable: true })) }, first)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(15_000)
    expect(result.current.status).toBe('READY')
    act(() => props.requestContext.invalidate())
    await advance(60_000)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(2)
    expect(result.current.snapshot).toBeNull()
  })

  it('cancels a renewal before an explicit role mutation and never replays the write', async () => {
    const pending = deferred<PermissionSnapshot>()
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const fetch = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(first)
    const props = fixture({ getPermissionSnapshot: fetch }, first)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(15_000)
    const signal = fetch.mock.calls[1]?.[0] as AbortSignal
    await act(async () => { await result.current.replaceActiveRoles({ roleIds: ['22'], expectedAuthVersion: 11 }) })
    expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve(snapshot({ permissionCodes: ['untrusted:late'], snapshotExpiresAt: expiry(30_000) })))
    expect(result.current.snapshot?.permissionCodes).toEqual(['order:read'])
    expect(props.client.replaceActiveRoles).toHaveBeenCalledTimes(1)
  })


  it('stops slow 503 retries when the thirty-second renewal budget is spent', async () => {
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const props = fixture({ getPermissionSnapshot: vi.fn().mockResolvedValueOnce(first).mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 10_000))
      throw new Rbac3RequestError({ status: 503, code: 'INVALID_RESPONSE', message: 'slow unavailable', retryable: true })
    }) }, first)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(60_000)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(4)
    expect(result.current.snapshot).toBeNull()
    await advance(60_000)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(4)
  })

  it('does not cancel a slow renewal when the host rerenders with equivalent binding props', async () => {
    const pending = deferred<PermissionSnapshot>()
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const fetch = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise)
    const props = fixture({ getPermissionSnapshot: fetch }, first)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props} binding={{ ...props.binding }}>{children}</Rbac3Provider>
    const { result, rerender } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(15_000)
    const signal = fetch.mock.calls[1]?.[0] as AbortSignal
    rerender()
    await advance(1_000)
    expect(signal.aborted).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => pending.resolve(snapshot({ snapshotExpiresAt: expiry(30_000) })))
    expect(result.current.status).toBe('READY')
  })


  it('installs authoritative revocation even when server expiry is unchanged, and continues throttled reads across the host echo', async () => {
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const revoked = { ...first, authVersion: '12', permissionCodes: [] }
    const props = fixture({ getPermissionSnapshot: vi.fn().mockResolvedValueOnce(first).mockResolvedValue(revoked),
      getAbout: vi.fn().mockResolvedValueOnce(about).mockResolvedValue({ ...about, authVersion: 12 }) }, first)
    const wrapper = ({ children }: PropsWithChildren) => {
      const [binding, setBinding] = useState(props.binding)
      return <Rbac3Provider {...props} binding={binding} onContextChange={setBinding}>{children}</Rbac3Provider>
    }
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(15_000)
    expect(result.current.snapshot?.permissionCodes).toEqual([])
    expect(result.current.binding?.authVersion).toBe('12')
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(2)
    await advance(999)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(3)
    expect(result.current.snapshot?.snapshotExpiresAt).toBe(first.snapshotExpiresAt)
  })

  it('honors an earlier authoritative expiry instead of retaining the old longer TTL', async () => {
    const first = snapshot({ snapshotExpiresAt: expiry(30_000) })
    const props = fixture({ getPermissionSnapshot: vi.fn().mockResolvedValueOnce(first)
      .mockImplementation(async () => snapshot({ snapshotExpiresAt: new Date(NOW + 20_000).toISOString() })) }, first)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await flush()
    await advance(15_000)
    expect(result.current.snapshot?.snapshotExpiresAt).toBe(new Date(NOW + 20_000).toISOString())
    await advance(5_000)
    expect(result.current.snapshot).toBeNull()
  })

})
