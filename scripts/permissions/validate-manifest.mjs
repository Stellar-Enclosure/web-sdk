import Ajv2020 from 'ajv/dist/2020.js'
import ts from 'typescript'
import { isCanonicalJdk25Locale } from './jdk25-locale.mjs'
import { canonicalJson, normalizeManifest } from './canonicalize.mjs'
import { isPermissionRequirement } from '../../packages/stellar-enclosure-web-shared/src/permissions/evaluateRequirement.ts'

export const parseStrictJson = input => {
  const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)
  if (Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) throw new Error('JSON_BYTE_LIMIT')
  const value = JSON.parse(text)
  const source = ts.parseJsonText('input.json', text)
  const visit = node => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set()
      for (const property of node.properties) {
        const name = property.name?.text
        if (names.has(name)) throw new Error('JSON_DUPLICATE_PROPERTY')
        names.add(name)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  canonicalJson(value)
  return value
}

const unique = (values, key, label) => {
  const seen = new Set()
  for (const item of values) {
    const name = key(item).toLowerCase()
    if (seen.has(name)) throw new Error('MANIFEST_DUPLICATE_OR_CASE_COLLISION:' + label)
    seen.add(name)
  }
}
const same = (left, right) => canonicalJson([...left].sort()) === canonicalJson([...right].sort())
const javaWhitespace = character => {
  const code = character.codePointAt(0)
  return (code >= 9 && code <= 13) || (code >= 28 && code <= 31)
    || (![0x00a0, 0x2007, 0x202f].includes(code) && /[\p{Zs}\p{Zl}\p{Zp}]/u.test(character))
}
const javaBlank = value => [...value].every(javaWhitespace)
const boundedText = (value, maximum, label) => {
  if (typeof value !== 'string' || !value.length || javaBlank(value) || javaWhitespace(value[0]) || javaWhitespace(value.at(-1)) || value.length > maximum || !value.isWellFormed()) throw new Error('MANIFEST_TEXT_INVALID:' + label)
}
const placeholders = text => {
  if (typeof text !== 'string' || !text.length || javaBlank(text) || text.length > 8192 || text.includes('\0') || !text.isWellFormed()) throw new Error('SOURCE_TEXT_INVALID')
  const names = new Set()
  const rest = text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g, (_match, name) => { names.add(name); return '' })
  if (rest.includes('{{') || rest.includes('}}')) throw new Error('SOURCE_INTERPOLATION_INVALID')
  return [...names].sort()
}
const locale = value => {
  if (!isCanonicalJdk25Locale(value)) throw new Error('SOURCE_LOCALE_NOT_CANONICAL')
}

export const createManifestValidator = schema => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, ownProperties: true })
  for (const keyword of ['x-contract', 'x-canonicalBcp47', 'x-tianshuInterpolation']) ajv.addKeyword({ keyword, valid: true })
  const validate = ajv.compile(schema)
  return input => {
    // AST values have null prototypes; Ajv's uniqueItems comparator expects ordinary JSON objects.
    const json = JSON.parse(canonicalJson(input))
    if (!validate(json)) {
      const first = validate.errors[0]
      throw new Error('MANIFEST_SCHEMA_INVALID:' + first.instancePath + ':' + first.keyword)
    }
    const manifest = normalizeManifest(json)
    for (const [name, values, key] of [
      ['permissions', manifest.permissionDefinitions, value => value.code], ['permissionReferences', manifest.permissionReferences, value => value],
      ['resources', manifest.resources, value => value.key], ['resourceReferences', manifest.resourceReferences, value => value.key + ':' + value.usage],
      ['messages', manifest.messages, value => value.pageCode + '/' + value.key],
      ['expectedModules', manifest.producer.expectedModules, value => value], ['scannedModules', manifest.producer.scannedModules, value => value],
      ['ownedKeyPrefixes', manifest.producer.ownedKeyPrefixes, value => value],
    ]) unique(values, key, name)
    if (manifest.producer.scannedModules.some(value => !manifest.producer.expectedModules.includes(value))
      || (manifest.producer.snapshotMode === 'FULL' && !same(manifest.producer.expectedModules, manifest.producer.scannedModules))) throw new Error('SCAN_MODULE_COVERAGE_INVALID')
    boundedText(manifest.artifact.repository, 256, 'repository')
    boundedText(manifest.artifact.buildId, 256, 'buildId')
    boundedText(manifest.artifact.version, 128, 'version')
    const codes = new Set(manifest.permissionReferences)
    for (const definition of manifest.permissionDefinitions) {
      boundedText(definition.meaning, 1024, 'meaning')
      if (codes.has(definition.code)) throw new Error('PERMISSION_DEFINED_AND_REFERENCED')
      codes.add(definition.code)
    }
    unique([...codes], value => value, 'permission ownership')
    const requirement = value => {
      if (!isPermissionRequirement(value)) throw new Error('PERMISSION_REQUIREMENT_INVALID')
      const groups = 'allOf' in value ? value.allOf : [value]
      if (groups.some(group => 'codes' in group && group.codes.some(code => !codes.has(code)))) throw new Error('PERMISSION_REFERENCE_UNDECLARED')
    }
    const owned = new Set(manifest.resources.map(value => value.key))
    for (const resource of manifest.resources) {
      if (!manifest.producer.ownedKeyPrefixes.some(prefix => resource.key.startsWith(prefix))) throw new Error('RESOURCE_PREFIX_UNOWNED')
      if (manifest.producer.kind === 'REACT_TYPESCRIPT' && ['API', 'FIELD'].includes(resource.type)) throw new Error('FRONTEND_BACKEND_RESOURCE_OWNERSHIP_FORBIDDEN')
      if (resource.requirement) requirement(resource.requirement)
      if (resource.fieldPolicy) for (const name of ['plainRead', 'maskedRead', 'write']) if (resource.fieldPolicy[name]) requirement(resource.fieldPolicy[name])
      if (resource.access === 'PROTECTED' && !resource.requirement && !resource.fieldPolicy
        && !(same(resource.allowedPrincipals, ['SERVICE']) && resource.oauthScopes.length > 0)) throw new Error('RESOURCE_ACCESS_CLASSIFICATION_MISSING')
      unique(resource.oauthScopes, value => value, 'oauthScopes')
      for (const value of Object.values(resource.target)) {
        for (const text of Array.isArray(value) ? value : [value]) boundedText(text, 2048, 'target')
      }
      if (Buffer.byteLength(canonicalJson(resource.target)) > 64 * 1024 || Buffer.byteLength(canonicalJson(resource)) > 256 * 1024) throw new Error('RESOURCE_BYTE_LIMIT')
    }
    if (manifest.resourceReferences.some(value => owned.has(value.key))) throw new Error('RESOURCE_OWNED_AND_REFERENCED')
    const empty = !manifest.resources.length && !manifest.permissionDefinitions.length && !manifest.messages.length
    if (manifest.producer.snapshotMode === 'FULL' && empty && !manifest.producer.clearIntent) throw new Error('EMPTY_FULL_SCAN_REQUIRES_CLEAR_INTENT')
    if (manifest.producer.clearIntent && (!empty || manifest.producer.snapshotMode !== 'FULL')) throw new Error('CLEAR_INTENT_REQUIRES_EMPTY_FULL_SCAN')
    for (const message of manifest.messages) {
      locale(message.defaultLocale)
      if (!Object.hasOwn(message.defaults, message.defaultLocale)) throw new Error('SOURCE_DEFAULT_LOCALE_MISSING')
      const expected = placeholders(message.defaults[message.defaultLocale])
      unique(Object.keys(message.defaults), value => value, 'sourceLocales')
      for (const [tag, text] of Object.entries(message.defaults)) {
        locale(tag)
        if (!same(expected, placeholders(text))) throw new Error('SOURCE_PLACEHOLDER_CONTRACT_MISMATCH')
      }
    }
    return manifest
  }
}
