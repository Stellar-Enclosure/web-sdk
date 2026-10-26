import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionGate } from './PermissionGate'
import { usePermission } from '../hooks/usePermission'
import { permissionBinding, permissionSnapshot } from '../test/permissionFixtures'
import { evaluateFieldAccess, type BackendFieldCatalog } from '../permissions/permissionSnapshot'

afterEach(() => vi.useRealTimers())
describe('PermissionGate and field state', () => {
  it('denies loading/missing snapshots, empty ALL and missing outer groups', () => {
    const binding = permissionBinding(); const snapshot = permissionSnapshot()
    const { result } = renderHook(() => usePermission(snapshot, binding))
    expect(result.current.hasAll()).toBe(false)
    render(<>
      <PermissionGate snapshot={null} binding={binding} requirement={{ access: 'PUBLIC' }}>loading</PermissionGate>
      <PermissionGate snapshot={snapshot} binding={binding} requirement={{ allOf: [{ mode: 'ALL', codes: ['order:read'] }, { mode: 'ANY', codes: ['order:write'] }] }}>missing</PermissionGate>
      <PermissionGate snapshot={snapshot} binding={binding} requirement={{ mode: 'ANY', codes: ['order:read', 'order:write'] }}>allowed</PermissionGate>
    </>)
    expect(screen.queryByText('loading')).toBeNull(); expect(screen.queryByText('missing')).toBeNull()
    expect(screen.getByText('allowed')).toBeInTheDocument()
  })

  it('stops showing content after expiry or any context version change', async () => {
    vi.useFakeTimers()
    const snapshot = permissionSnapshot({ snapshotExpiresAt: new Date(Date.now() + 1000).toISOString() })
    const binding = permissionBinding()
    const { rerender } = render(<PermissionGate snapshot={snapshot} binding={binding} requirement={{ mode: 'ALL', codes: ['order:read'] }}>protected</PermissionGate>)
    expect(screen.getByText('protected')).toBeInTheDocument()
    rerender(<PermissionGate snapshot={snapshot} binding={{ ...binding, policyVersion: '14' }} requirement={{ mode: 'ALL', codes: ['order:read'] }}>protected</PermissionGate>)
    expect(screen.queryByText('protected')).toBeNull()
    rerender(<PermissionGate snapshot={snapshot} binding={binding} requirement={{ mode: 'ALL', codes: ['order:read'] }}>protected</PermissionGate>)
    await act(() => vi.advanceTimersByTimeAsync(1001))
    expect(screen.queryByText('protected')).toBeNull()
  })

  it('prioritizes plain read over masked read and makes write independent', () => {
    const binding = permissionBinding()
    const catalog: BackendFieldCatalog = { catalogScope: binding.catalogScope, catalogVersion: binding.catalogVersion, fields: {
      'order.field.secret': { access: 'PROTECTED', fieldPolicy: { valueType: 'STRING', plainRead: { mode: 'ALL', codes: ['plain'] },
        maskedRead: { mode: 'ALL', codes: ['masked'] }, write: { mode: 'ALL', codes: ['write'] }, masker: 'FIXED' }, inputBinding: true },
      'order.field.public': { access: 'PUBLIC' },
      'order.field.internal': { access: 'INTERNAL' },
    } }
    expect(evaluateFieldAccess('order.field.secret', catalog, permissionSnapshot({ permissionCodes: ['plain', 'masked'] }), binding)).toEqual({ read: 'PLAIN', writable: false })
    expect(evaluateFieldAccess('order.field.secret', catalog, permissionSnapshot({ permissionCodes: ['masked'] }), binding)).toEqual({ read: 'MASKED', writable: false })
    expect(evaluateFieldAccess('order.field.secret', catalog, permissionSnapshot({ permissionCodes: ['write'] }), binding)).toEqual({ read: 'OMITTED', writable: true })
    expect(evaluateFieldAccess('order.field.public', catalog, permissionSnapshot(), binding)).toEqual({ read: 'PLAIN', writable: false })
    expect(evaluateFieldAccess('order.field.internal', catalog, permissionSnapshot(), binding)).toEqual({ read: 'OMITTED', writable: false })
    expect(evaluateFieldAccess('order.field.secret', { ...catalog, catalogVersion: '8' }, permissionSnapshot(), binding)).toEqual({ read: 'OMITTED', writable: false })
    const readonly = { ...catalog, fields: { ...catalog.fields, 'order.field.secret': { ...catalog.fields['order.field.secret'], inputBinding: false } } }
    expect(evaluateFieldAccess('order.field.secret', readonly, permissionSnapshot({ permissionCodes: ['write'] }), binding)).toEqual({ read: 'OMITTED', writable: false })
    const publicInput = { ...catalog, fields: { 'order.field.public': { access: 'PUBLIC' as const, inputBinding: true } } }
    expect(evaluateFieldAccess('order.field.public', publicInput, permissionSnapshot(), binding)).toEqual({ read: 'PLAIN', writable: false })
  })
})
