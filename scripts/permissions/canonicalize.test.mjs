import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJson, manifestDigests, compareManifests } from './canonicalize.mjs'
import { contract } from './test-support.mjs'

test('RC JAR canonical bytes and three SHA-256 projections match Java fixtures', () => {
  assert.deepEqual(manifestDigests(contract.manifest), contract.canonical)
  const reversed = structuredClone(contract.manifest)
  for (const name of ['permissionDefinitions', 'resources', 'messages']) reversed[name].reverse()
  assert.deepEqual(manifestDigests(reversed), contract.canonical)
})

test('metadata-only changes do not change the policy digest', () => {
  const changed = structuredClone(contract.manifest)
  changed.messages[0].defaults['en-US'] = 'Updated source label'
  const next = manifestDigests(contract.validate(changed))
  assert.equal(next.policyDigest, contract.canonical.policyDigest)
  assert.notEqual(next.metadataDigest, contract.canonical.metadataDigest)
  assert.notEqual(next.manifestDigest, contract.canonical.manifestDigest)
  assert.deepEqual(compareManifests(contract.manifest, changed).changed, [])
})

test('canonical JSON has deterministic escaping and rejects unsafe numbers, Unicode and depth', () => {
  assert.equal(canonicalJson({ z: '\n', a: '订单😀' }), '{"a":"订单😀","z":"\\n"}')
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 0.5, NaN, '\ud800', { '非ASCII': 1 }]) assert.throws(() => canonicalJson(value))
  let deep = {}; for (let index = 0; index < 18; index++) deep = { deep }
  assert.throws(() => canonicalJson(deep), /DEPTH/)
})
