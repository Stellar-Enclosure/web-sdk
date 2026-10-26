import { act, renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { snapshotContext, type PermissionSnapshot } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import { Rbac3RequestError } from '../errors'
import { fixture, snapshot, about } from '../test/permissionFixtures'
import { useRbac3Authorization } from '../hooks/useRbac3Authorization'
import { Rbac3Provider } from './Rbac3Provider'

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('Rbac3Provider version-bound authority view', () => {
  it('requires about and a matching permission snapshot before READY', async () => {
    const permissions = deferred<PermissionSnapshot>()
    const props = fixture({ getPermissionSnapshot: vi.fn(() => permissions.promise) })
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('LOADING_ABOUT'))
    expect(result.current.snapshot).toBeNull()
    act(() => permissions.resolve(snapshot()))
    await waitFor(() => expect(result.current.status).toBe('READY'))
    expect(result.current.snapshot?.permissionCodes).toEqual(['order:read'])
  })

  it('opens role selection from the limited snapshot without interpreting legacy About permissions', async () => {
    const limited = snapshot({ catalogScope: { ...snapshot().catalogScope, applicationCode: 'tianquan-jianshen' },
      activeRoleContext: { applicationCode: 'tianquan-jianshen', rootRoleIds: [], effectiveRoleIds: [] }, permissionCodes: ['system:role-activation:use'] })
    const props = fixture({}, limited)
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('ACTIVATION_REQUIRED'))
    expect(result.current.snapshot).toBeNull()
    expect(props.client.getActivationCandidates).toHaveBeenCalledTimes(1)
  })

  it('fetches a new authoritative context after role replacement and never restores old grants', async () => {
    const next = snapshot({ authVersion: '12', activeRoleContext: { applicationCode: 'orders', rootRoleIds: ['22'], effectiveRoleIds: ['22'] }, permissionCodes: ['order:write'] })
    const props = fixture({ getPermissionSnapshot: vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(next) })
    const onContextChange = vi.fn()
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props} onContextChange={onContextChange}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('READY'))
    await act(async () => { await result.current.replaceActiveRoles({ roleIds: ['22'], expectedAuthVersion: 11 }) })
    expect(result.current.snapshot?.permissionCodes).toEqual(['order:write'])
    expect(result.current.binding?.authVersion).toBe('12')
    expect(onContextChange).toHaveBeenCalledWith(snapshotContext(next, 0), next)
  })

  it('does not accept a late old-user response after the host binding changes', async () => {
    const delayed = deferred<PermissionSnapshot>()
    const props = fixture({ getPermissionSnapshot: vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(snapshot({ subject: 'bob' })) })
    const bob = snapshotContext(snapshot({ subject: 'bob' }), 0)
    const wrapper = ({ children, binding }: PropsWithChildren<{ binding: typeof props.binding }>) => <Rbac3Provider {...props} binding={binding}>{children}</Rbac3Provider>
    // renderHook's wrapper does not receive hook props; use a host variable and rerender the same tree.
    let current = props.binding
    const host = ({ children }: PropsWithChildren) => wrapper({ children, binding: current })
    const { result, rerender } = renderHook(() => useRbac3Authorization(), { wrapper: host })
    await waitFor(() => expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(1))
    current = bob
    vi.mocked(props.client.getAbout).mockResolvedValue({ ...about, user: { ...about.user, subject: 'bob' } })
    rerender()
    await waitFor(() => expect(result.current.snapshot?.subject).toBe('bob'))
    act(() => delayed.resolve(snapshot()))
    await act(async () => { await Promise.resolve() })
    expect(result.current.snapshot?.subject).toBe('bob')
  })

  it.each([401, 403, 503])('clears grants on %s and never auto-replays a role mutation', async status => {
    const props = fixture({ replaceActiveRoles: vi.fn().mockRejectedValue(new Rbac3RequestError({ status, code: 'PERMISSION_DENIED', message: 'rejected', retryable: status === 503 })) })
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('READY'))
    await act(async () => { await expect(result.current.replaceActiveRoles({ roleIds: ['22'], expectedAuthVersion: 11 })).rejects.toBeDefined() })
    expect(result.current.snapshot).toBeNull()
    expect(props.client.replaceActiveRoles).toHaveBeenCalledTimes(1)
  })

  it('immediately masks an old view on logout and does not requery with its stale epoch', async () => {
    const props = fixture()
    const wrapper = ({ children }: PropsWithChildren) => <Rbac3Provider {...props}>{children}</Rbac3Provider>
    const { result } = renderHook(() => useRbac3Authorization(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('READY'))
    const calls = vi.mocked(props.client.getPermissionSnapshot).mock.calls.length
    act(() => props.requestContext.invalidate())
    expect(result.current.snapshot).toBeNull()
    expect(props.client.getPermissionSnapshot).toHaveBeenCalledTimes(calls)
  })
})
