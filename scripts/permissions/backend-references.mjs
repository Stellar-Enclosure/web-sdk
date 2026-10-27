import { canonicalJson, manifestDigests, sha256 } from './canonicalize.mjs'

const symbol = value => {
  const name = value.replace(/[^A-Za-z0-9]+(.)/g, (_match, character) => character.toUpperCase())
    .replace(/[^A-Za-z0-9]/g, '').replace(/^[A-Z]/, character => character.toLowerCase())
  return /^[A-Za-z]/.test(name) ? name : 'key' + name
}

const entries = (values, name) => {
  const groups = new Map()
  for (const value of values) {
    const base = symbol(name(value))
    const group = groups.get(base) ?? []
    group.push(value.key)
    groups.set(base, group)
  }
  const result = {}
  for (const [base, keys] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    for (const key of keys.sort()) {
      const property = keys.length === 1 ? base : base + '_' + sha256(key).slice(0, 12)
      if (Object.hasOwn(result, property)) throw new Error('BACKEND_REFERENCE_SYMBOL_COLLISION')
      result[property] = key
    }
  }
  return result
}

/** A reference projection of one fixed backend FULL manifest, never a second policy definition. */
export const backendReferences = (manifest, expected) => {
  const { canonical: _canonical, ...digests } = manifestDigests(manifest)
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.manifestDigest ?? '')
    || manifest.producer.kind !== 'JAVA' || manifest.producer.snapshotMode !== 'FULL'
    || manifest.producer.id !== expected.producerId || manifest.application.businessCode !== expected.businessCode
    || manifest.application.applicationCode !== expected.applicationCode || digests.manifestDigest !== expected.manifestDigest) {
    throw new Error('BACKEND_MANIFEST_BINDING_MISMATCH')
  }
  const permissions = entries(manifest.permissionDefinitions.map(value => ({key: value.code})), value => value.key)
  const apis = entries(manifest.resources.filter(value => value.type === 'API'), value => value.key)
  const fields = entries(manifest.resources.filter(value => value.type === 'FIELD'), value => {
    const dto = value.target.dto
    const property = value.target.property
    return typeof dto === 'string' && typeof property === 'string' ? dto.split('.').at(-1) + '_' + property : value.key
  })
  return { producerId: manifest.producer.id, manifestDigest: digests.manifestDigest,
    artifact: manifest.artifact, permissionCodes: permissions, apiKeys: apis, fieldKeys: fields }
}

export const backendReferencesSource = references => {
  const header = '// Generated from the pinned backend Manifest. Do not edit.\n'
  const names = [['permissionCodes', 'permission'], ['apiKeys', 'api'], ['fieldKeys', 'field']]
  return header + names.flatMap(([name, prefix]) => Object.entries(references[name]).map(([key, value]) =>
    `export const ${prefix}${key[0].toUpperCase() + key.slice(1)} = ${canonicalJson(value)} as const\n`)).join('')
}
