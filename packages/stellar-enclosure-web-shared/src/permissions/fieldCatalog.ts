import {catalogScopeKey, isCatalogScope, type BackendFieldCatalog} from './permissionSnapshot'

/** Keep GET query size bounded and never merge projections from different active catalogs. */
export const loadFieldCatalog = async (keys: readonly string[], request: (query: URLSearchParams) => Promise<BackendFieldCatalog>): Promise<BackendFieldCatalog> => {
  if (keys.length === 0 || keys.length > 10_000 || new Set(keys).size !== keys.length) throw new Error('FIELD_CATALOG_KEYS_INVALID')
  let result: BackendFieldCatalog | undefined
  for (let start = 0; start < keys.length; start += 24) {
    const batch = keys.slice(start, start + 24)
    const query = new URLSearchParams()
    batch.forEach(key => query.append('keys', key))
    const catalog = await request(query)
    if (!catalog || !isCatalogScope(catalog.catalogScope) || !/^[1-9][0-9]{0,18}$/.test(catalog.catalogVersion)
      || !catalog.fields || typeof catalog.fields !== 'object' || Array.isArray(catalog.fields)
      || Object.keys(catalog.fields).some(key => !batch.includes(key))
      || result && (catalogScopeKey(result.catalogScope) !== catalogScopeKey(catalog.catalogScope) || result.catalogVersion !== catalog.catalogVersion)) throw new Error('FIELD_CATALOG_CHANGED_OR_INVALID')
    result = {...catalog, fields: {...result?.fields, ...catalog.fields}}
  }
  return result!
}
