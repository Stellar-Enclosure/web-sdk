import { createHash } from 'node:crypto'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

/** RC CanonicalJson: printable ASCII keys, safe integral numbers, well-formed Unicode, depth <= 16. */
export const canonicalJson = value => {
  const write = (item, depth) => {
    if (depth > 16) throw new Error('CANONICAL_DEPTH_EXCEEDED')
    if (item === null || typeof item === 'boolean') return String(item)
    if (typeof item === 'string') {
      if (!item.isWellFormed()) throw new Error('CANONICAL_UNICODE_INVALID')
      return JSON.stringify(item)
    }
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw new Error('CANONICAL_NUMBER_INVALID')
      return String(item)
    }
    if (Array.isArray(item)) return '[' + item.map(value => write(value, depth + 1)).join(',') + ']'
    if (typeof item !== 'object' || !item || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('CANONICAL_VALUE_INVALID')
    const names = Object.keys(item).sort(compare)
    if (names.some(name => !/^[\x20-\x7e]+$/.test(name))) throw new Error('CANONICAL_KEY_INVALID')
    return '{' + names.map(name => JSON.stringify(name) + ':' + write(item[name], depth + 1)).join(',') + '}'
  }
  const result = write(value, 0)
  if (Buffer.byteLength(result, 'utf8') > 16 * 1024 * 1024) throw new Error('CANONICAL_BYTE_LIMIT')
  return result
}

const sorted = (values, key = value => value) => [...values].sort((left, right) => compare(key(left), key(right)))
const present = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined))
export const normalizeRequirement = requirement => {
  if (requirement.access === 'PUBLIC') return { access: 'PUBLIC' }
  if (!requirement.allOf) return { mode: requirement.mode, codes: sorted(requirement.codes) }
  const groups = [...new Map(requirement.allOf.map(normalizeRequirement).map(group => [canonicalJson(group), group])).entries()]
    .sort(([a], [b]) => compare(a, b)).map(([, group]) => group)
  return groups.length === 1 ? groups[0] : { allOf: groups }
}

export const normalizeManifest = manifest => ({
  schemaVersion: manifest.schemaVersion,
  application: { ...manifest.application },
  producer: { ...manifest.producer, clearIntent: manifest.producer.clearIntent ?? false,
    ownedKeyPrefixes: sorted(manifest.producer.ownedKeyPrefixes), expectedModules: sorted(manifest.producer.expectedModules), scannedModules: sorted(manifest.producer.scannedModules) },
  artifact: { ...manifest.artifact },
  permissionDefinitions: sorted(manifest.permissionDefinitions, value => value.code).map(value => ({ ...value, i18n: present(value.i18n), lifecycle: value.lifecycle ?? 'ACTIVE' })),
  permissionReferences: sorted(manifest.permissionReferences),
  resources: sorted(manifest.resources, value => value.key).map(value => ({
    ...present(value),
    target: Object.fromEntries(Object.entries(value.target).map(([key, item]) => [key, Array.isArray(item) ? sorted(item) : item])),
    access: value.access ?? 'PROTECTED', lifecycle: value.lifecycle ?? 'ACTIVE',
    allowedPrincipals: sorted(value.allowedPrincipals ?? ['USER']), oauthScopes: sorted(value.oauthScopes ?? []), i18n: present(value.i18n),
    ...(value.requirement ? { requirement: normalizeRequirement(value.requirement) } : {}),
    ...(value.fieldPolicy ? { fieldPolicy: Object.fromEntries(Object.entries(present(value.fieldPolicy))
      .map(([key, item]) => [key, ['plainRead', 'maskedRead', 'write'].includes(key) ? normalizeRequirement(item) : item])) } : {}),
  })),
  resourceReferences: sorted(manifest.resourceReferences, value => value.key + ':' + value.usage),
  messages: sorted(manifest.messages, value => value.pageCode + '/' + value.key),
})

export const manifestDigests = manifest => {
  const complete = normalizeManifest(manifest)
  const policy = { schemaVersion: complete.schemaVersion, application: complete.application,
    permissionDefinitions: complete.permissionDefinitions.map(({ code, meaning, lifecycle }) => ({ code, meaning, lifecycle })),
    permissionReferences: complete.permissionReferences,
    resources: complete.resources.map(({ i18n: _i18n, ...resource }) => resource), resourceReferences: complete.resourceReferences }
  const metadata = { schemaVersion: complete.schemaVersion, application: complete.application,
    permissions: complete.permissionDefinitions.map(({ code, i18n }) => ({ code, i18n })),
    resources: complete.resources.map(({ key, i18n }) => ({ key, i18n })), messages: complete.messages }
  return { canonical: canonicalJson(complete), policyDigest: sha256(canonicalJson(policy)),
    metadataDigest: sha256(canonicalJson(metadata)), manifestDigest: sha256(canonicalJson(complete)) }
}

export const compareManifests = (before, after) => {
  const previous = normalizeManifest(before)
  const current = normalizeManifest(after)
  if (canonicalJson(previous.application) !== canonicalJson(current.application) || previous.producer.id !== current.producer.id) throw new Error('OFFLINE_DIFF_PRODUCER_MISMATCH')
  const delta = (left, right, key) => {
    const old = new Map(left.map(value => [key(value), value]))
    const next = new Map(right.map(value => [key(value), value]))
    return { added: [...next.keys()].filter(key => !old.has(key)).sort(), removed: [...old.keys()].filter(key => !next.has(key)).sort(),
      changed: [...next.keys()].filter(key => old.has(key) && canonicalJson(old.get(key)) !== canonicalJson(next.get(key))).sort() }
  }
  const resources = delta(previous.resources, current.resources, value => value.key)
  return { ...resources, resources, permissions: delta(previous.permissionDefinitions, current.permissionDefinitions, value => value.code),
    messages: delta(previous.messages, current.messages, value => value.pageCode + '/' + value.key),
    before: manifestDigests(before), after: manifestDigests(after) }
}
