import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, createElement, type PropsWithChildren } from 'react'
import { AuthRequestContext } from '../auth/authRequestContext'
import { permissionBinding, permissionSnapshot } from '../test/permissionFixtures'
import type { PermissionSnapshot } from './permissionSnapshot'
import { createPermissionSnapshotCache } from './permissionSnapshotCache'
import { usePermissionSnapshot } from './usePermissionSnapshot'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('permission snapshot cache', () => {
  it('deduplicates the same complete binding and expires at the server deadline', async () => {
    vi.useFakeTimers()
    const pending = deferred<PermissionSnapshot>()
    const fetcher = vi.fn().mockReturnValue(pending.promise)
    const cache = createPermissionSnapshotCache(fetcher)
    const binding = permissionBinding()
    const first = cache.load(binding); const second = cache.load(binding)
    expect(cache.getState().snapshot).toBeNull()
    pending.resolve(permissionSnapshot({ snapshotExpiresAt: new Date(Date.now() + 1000).toISOString() }))
    expect(await second).toEqual(await first)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(cache.getState().status).toBe('READY')
    await vi.advanceTimersByTimeAsync(1001)
    expect(cache.getState().snapshot).toBeNull()
    cache.dispose()
  })

  it.each(['issuer', 'subject', 'tenant', 'scopeId', 'business', 'application', 'namespace', 'environment', 'catalog', 'auth', 'policy', 'roles', 'epoch'])('cancels and rejects a late response when %s changes', async field => {
      const first = deferred<PermissionSnapshot>(); const second = deferred<PermissionSnapshot>()
      const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      const cache = createPermissionSnapshotCache(fetcher)
      const old = permissionBinding()
      const next = structuredClone(old)
      const mutable = next as unknown as Record<string, any>
      if (field === 'issuer') mutable.issuer = 'https://idp-b.example/tenants/1001'
      if (field === 'subject') mutable.subject = 'bob'
      if (field === 'tenant') mutable.catalogScope.tenantId = '1002'
      if (field === 'scopeId') mutable.catalogScope.catalogScopeId = '501'
      if (field === 'business') mutable.catalogScope.businessCode = 'other'
      if (field === 'application') { mutable.catalogScope.applicationCode = 'other'; mutable.activeRoleContext.applicationCode = 'other' }
      if (field === 'namespace') mutable.catalogScope.namespaceCode = 'other'
      if (field === 'environment') mutable.catalogScope.environment = 'stage'
      if (field === 'catalog') mutable.catalogVersion = '8'
      if (field === 'auth') mutable.authVersion = '12'
      if (field === 'policy') mutable.policyVersion = '14'
      if (field === 'roles') mutable.activeRoleContext.rootRoleIds = ['22']
      if (field === 'epoch') mutable.requestEpoch = 1
      const stale = cache.load(old).catch(error => error)
      await Promise.resolve()
      const current = cache.load(next)
      await Promise.resolve()
      second.resolve(permissionSnapshot({ ...next })); await current
      first.resolve(permissionSnapshot())
      expect(await stale).toMatchObject({ name: 'AbortError' })
      expect(cache.getState().snapshot?.subject).toBe(next.subject)
      expect(cache.getState().snapshot?.catalogVersion).toBe(next.catalogVersion)
      expect((fetcher.mock.calls[0][0] as AbortSignal).aborted).toBe(true)
      cache.dispose()
    })

  it.each([401, 403, 503])('clears cached grants on %s without a positive fallback or automatic retry', async status => {
    const fetcher = vi.fn().mockResolvedValueOnce(permissionSnapshot()).mockRejectedValueOnce({ status })
    const cache = createPermissionSnapshotCache(fetcher)
    await cache.load(permissionBinding())
    const failed = cache.load(permissionBinding(), undefined, true)
    expect(cache.getState().snapshot).toBeNull()
    await expect(failed).rejects.toMatchObject({ status })
    expect(cache.getState().status).toBe('ERROR')
    expect(fetcher).toHaveBeenCalledTimes(2)
    cache.dispose()
  })

  it('invalidates an already-ready view immediately when the auth request epoch is cancelled', async () => {
    const context = new AuthRequestContext()
    const cache = createPermissionSnapshotCache(async () => permissionSnapshot())
    await cache.load(permissionBinding(), context.capture().signal)
    context.invalidate()
    expect(cache.getState().snapshot).toBeNull()
    expect(cache.getState().status).toBe('EMPTY')
    cache.dispose()
  })

  it('never accepts a mismatched or already expired server snapshot', async () => {
    for (const snapshot of [permissionSnapshot({ authVersion: '10' }), permissionSnapshot({ snapshotExpiresAt: new Date(Date.now() - 1).toISOString() })]) {
      const cache = createPermissionSnapshotCache(async () => snapshot)
      await expect(cache.load(permissionBinding())).rejects.toThrow('CONTEXT_MISMATCH_OR_EXPIRED')
      expect(cache.getState().snapshot).toBeNull(); cache.dispose()
    }
  })

  it('survives React StrictMode and does not loop authentication requests after logout', async () => {
    const requestContext = new AuthRequestContext()
    const fetchSnapshot = vi.fn(async () => permissionSnapshot())
    const binding = permissionBinding()
    const wrapper = ({ children }: PropsWithChildren) => createElement(StrictMode, null, children)
    const { result, unmount } = renderHook(() => usePermissionSnapshot({ binding, requestContext, fetchSnapshot }), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('READY'))
    const calls = fetchSnapshot.mock.calls.length
    act(() => requestContext.invalidate())
    await waitFor(() => expect(result.current.snapshot).toBeNull())
    expect(fetchSnapshot).toHaveBeenCalledTimes(calls)
    unmount()
  })
})
