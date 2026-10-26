import {describe, expect, it, vi} from 'vitest'
import {loadFieldCatalog} from './fieldCatalog'
import {permissionSnapshot} from '../test/permissionFixtures'
import type {BackendFieldCatalog} from './permissionSnapshot'

const catalog = (query: URLSearchParams): BackendFieldCatalog => ({catalogScope: permissionSnapshot().catalogScope, catalogVersion: '1',
  fields: Object.fromEntries(query.getAll('keys').map(key => [key, {access: 'PUBLIC' as const, inputBinding: false}]))})

describe('bounded current catalog reads', () => {
  it('loads all requested fields in bounded GET batches', async () => {
    const keys = Array.from({length: 170}, (_, index) => 'order.field.' + index)
    const request = vi.fn(async (query: URLSearchParams) => catalog(query))
    const result = await loadFieldCatalog(keys, request)
    expect(Object.keys(result.fields)).toEqual(keys)
    expect(request).toHaveBeenCalledTimes(8)
    expect(request.mock.calls.every(([query]) => query.getAll('keys').length <= 24)).toBe(true)
  })
  it('rejects changed scope/version and unrelated fields instead of mixing active projections', async () => {
    const keys = Array.from({length: 25}, (_, index) => 'order.field.' + index)
    for (const changed of [
      (value: BackendFieldCatalog) => ({...value, catalogVersion: '2'}),
      (value: BackendFieldCatalog) => ({...value, catalogScope: {...value.catalogScope, environment: 'other'}}),
      (value: BackendFieldCatalog) => ({...value, fields: {...value.fields, unrelated: {access: 'PUBLIC' as const}}}),
    ]) {
      let count = 0
      await expect(loadFieldCatalog(keys, async query => ++count === 1 ? catalog(query) : changed(catalog(query)))).rejects.toThrow('FIELD_CATALOG_CHANGED_OR_INVALID')
    }
    await expect(loadFieldCatalog([], async query => catalog(query))).rejects.toThrow('KEYS_INVALID')
    await expect(loadFieldCatalog(['same', 'same'], async query => catalog(query))).rejects.toThrow('KEYS_INVALID')
  })
})
