import { describe, expect, it } from 'vitest'
import { snapshotContext } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import { resources, references, fields, snapshot } from '../test/permissionFixtures'
import { FrontendResourceRegistry } from './FrontendResourceRegistry'
import { resolveDefaultRoute } from '../routing/resolveDefaultRoute'

const current = snapshot(); const binding = snapshotContext(current, 0)
describe('FrontendResourceRegistry', () => {
  it('uses declared requirements and never turns a resource key or calls reference into a grant', () => {
    const registry = new FrontendResourceRegistry(resources, references)
    expect(registry.navigation(current, binding)[0].children[0].key).toBe('order.page.list')
    expect(registry.canAccessRoute('order.page.list', current, binding)).toBe(true)
    expect(registry.canAccessResource('order.button.write', current, binding)).toBe(false)
    expect(registry.canAccessResource('order:read', current, binding)).toBe(false)
    const forged = snapshot({ permissionCodes: ['order.page.list'] })
    expect(registry.canAccessRoute('order.page.list', forged, binding)).toBe(false)
    expect(resolveDefaultRoute(forged, binding, registry)).toBeNull()
  })
  it('requires a backend field reference and matching catalog projection', () => {
    const registry = new FrontendResourceRegistry(resources, references)
    expect(registry.getField('order.field.accountNo', fields, current, binding)).toEqual({ read: 'MASKED', writable: false })
    expect(registry.getField('unknown', fields, current, binding)).toEqual({ read: 'OMITTED', writable: false })
    expect(registry.getField('order.field.accountNo', { ...fields, catalogVersion: '8' }, current, binding)).toEqual({ read: 'OMITTED', writable: false })
  })
  it('rejects duplicate keys, missing parents, cycles and frontend FIELD policies', () => {
    expect(() => new FrontendResourceRegistry([resources[0], resources[0]])).toThrow(/duplicate/)
    expect(() => new FrontendResourceRegistry([{ ...resources[0], target: { parentKey: 'missing' } }])).toThrow(/missing/)
    expect(() => new FrontendResourceRegistry([{ ...resources[0], target: { parentKey: resources[0].key } }])).toThrow(/Cyclic/)
    expect(() => new FrontendResourceRegistry([{ ...resources[0], type: 'FIELD' } as never])).toThrow(/FIELD/)
  })
})
