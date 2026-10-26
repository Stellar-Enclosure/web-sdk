import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStrictJson } from './validate-manifest.mjs'
import { contract } from './test-support.mjs'

test('strict JSON parsing rejects duplicate keys, invalid numbers and malformed Unicode', () => {
  assert.throws(() => parseStrictJson('{"schemaVersion":"1.0","schemaVersion":"2"}'), /DUPLICATE/)
  assert.throws(() => parseStrictJson('{"revision":9007199254740993}'), /NUMBER/)
  assert.throws(() => parseStrictJson(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])))
  assert.throws(() => parseStrictJson('{"text":"\\ud800"}'), /UNICODE/)
})

test('schema and semantic rules reject unknown fields, missing modules, collisions and unowned keys', () => {
  const cases = [
    manifest => { manifest.tenantId = 'forbidden' },
    manifest => { manifest.producer.expectedModules.push('missing') },
    manifest => { manifest.permissionDefinitions.push({ ...manifest.permissionDefinitions[0], code: manifest.permissionDefinitions[0].code.toUpperCase() }) },
    manifest => { manifest.resources[0].key = 'other.unowned' },
    manifest => { manifest.resources[0].requirement = { mode: 'ANY', codes: ['undeclared:code'] } },
    manifest => { manifest.resources[0].requirement = { mode: 'ALL', codes: [] } },
    manifest => { manifest.resources[1].fieldPolicy.maskedRead = { access: 'PUBLIC' }; manifest.resources[1].fieldPolicy.masker = 'FIXED' },
    manifest => { manifest.producer.kind = 'REACT_TYPESCRIPT' },
    manifest => { manifest.messages[0].defaults['en-US'] = 'Hello {{name}}' },
  ]
  for (const mutate of cases) {
    const manifest = structuredClone(contract.manifest); mutate(manifest)
    assert.throws(() => contract.validate(manifest))
  }
})

test('empty FULL requires deliberate clear intent and PARTIAL never becomes FULL', () => {
  const manifest = structuredClone(contract.manifest)
  manifest.permissionDefinitions = []; manifest.resources = []; manifest.messages = []
  assert.throws(() => contract.validate(manifest), /EMPTY_FULL/)
  manifest.producer.clearIntent = true
  assert.equal(contract.validate(manifest).producer.clearIntent, true)
  manifest.producer.snapshotMode = 'PARTIAL'
  assert.throws(() => contract.validate(manifest), /CLEAR_INTENT/)
})

test('Java PUBLIC and INTERNAL FIELD classifications need no policy and never become frontend-owned', () => {
  for (const access of ['PUBLIC', 'INTERNAL']) {
    const manifest = structuredClone(contract.manifest)
    const field = manifest.resources.find(value => value.type === 'FIELD')
    field.access = access
    delete field.fieldPolicy
    assert.doesNotThrow(() => contract.validate(manifest))
    manifest.producer.kind = 'REACT_TYPESCRIPT'
    assert.throws(() => contract.validate(manifest), /FRONTEND_BACKEND_RESOURCE/)
  }
})

test('multiple null-prototype AST objects obey JSON uniqueItems without invoking object methods', () => {
  const astValues = value => Array.isArray(value) ? value.map(astValues)
    : value !== null && typeof value === 'object' ? Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, child]) => [key, astValues(child)]))) : value
  const value = astValues(contract.manifest)
  assert.deepEqual(contract.validate(value), contract.manifest)
  value.resources.push(value.resources[0])
  assert.throws(() => contract.validate(value), /SCHEMA_INVALID/)
})
