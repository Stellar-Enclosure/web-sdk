import '@testing-library/jest-dom/vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fixture, fields, references, resources, snapshot } from '../test/permissionFixtures'
import { Rbac3Provider } from '../provider/Rbac3Provider'
import { ActionGuard } from './ActionGuard'
import { FieldGuard } from './FieldGuard'
import { PermissionGuard } from './PermissionGuard'

describe('shared requirement guards', () => {
  it('denies before snapshot readiness and uses ALL/ANY instead of resource membership', async () => {
    let release!: (value: ReturnType<typeof snapshot>) => void
    const props = fixture({ getPermissionSnapshot: () => new Promise(done => { release = done }) })
    render(<Rbac3Provider {...props} resources={resources}>
      <PermissionGuard requirement={{ mode: 'ANY', codes: ['order:read', 'order:write'] }}>read</PermissionGuard>
      <PermissionGuard requirement={{ mode: 'ALL', codes: [] }}>empty</PermissionGuard>
      <ActionGuard resourceKey="order.button.write">write</ActionGuard>
      <ActionGuard resourceKey="order:read">permission-as-key</ActionGuard>
    </Rbac3Provider>)
    expect(screen.queryByText('read')).toBeNull()
    await waitFor(() => expect(release).toBeTypeOf('function'))
    act(() => release(snapshot()))
    await waitFor(() => expect(screen.getByText('read')).toBeInTheDocument())
    for (const value of ['empty', 'write', 'permission-as-key']) expect(screen.queryByText(value)).toBeNull()
  })

  it('uses only the server-masked value and requires a declared backend field reference', async () => {
    const props = fixture()
    render(<Rbac3Provider {...props} resources={resources} resourceReferences={references} fieldCatalog={fields}>
      <FieldGuard fieldKey="order.field.accountNo" value="6222021234567890" maskedValue="6222 **** 7890" />
      <FieldGuard fieldKey="order.field.unknown" value="unknown-secret" />
    </Rbac3Provider>)
    await waitFor(() => expect(screen.getByText('6222 **** 7890')).toBeInTheDocument())
    expect(screen.queryByText('6222021234567890')).toBeNull()
    expect(screen.queryByText('unknown-secret')).toBeNull()
  })

  it('rejects stale field projections even when the user has the matching code', async () => {
    const props = fixture()
    render(<Rbac3Provider {...props} resourceReferences={references} fieldCatalog={{ ...fields, catalogVersion: '6' }}>
      <FieldGuard fieldKey="order.field.accountNo" value="plaintext" maskedValue="masked" fallback="denied" />
    </Rbac3Provider>)
    await waitFor(() => expect(props.client.getPermissionSnapshot).toHaveBeenCalled())
    expect(screen.getByText('denied')).toBeInTheDocument()
    expect(screen.queryByText('masked')).toBeNull()
  })
})
