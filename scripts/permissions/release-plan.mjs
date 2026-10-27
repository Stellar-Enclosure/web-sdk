import { canonicalJson, compareManifests, manifestDigests } from './canonicalize.mjs'
import { validateCatalogTarget } from './registration-client.mjs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseStrictJson } from './validate-manifest.mjs'
import { evaluateRequirement } from '../../packages/stellar-enclosure-web-shared/src/permissions/evaluateRequirement.ts'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(value)
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const same = (left, right) => canonicalJson(left) === canonicalJson(right)
const digest = manifest => { const {canonical: _canonical, ...value} = manifestDigests(manifest); return value }

const expressionDecision = (resource, permissions) => {
  if (!resource) return {access: 'ABSENT'}
  if (!resource.allowedPrincipals.includes('USER')) return {access: 'NOT_USER'}
  if (resource.type !== 'FIELD') {
    if (resource.access === 'PUBLIC') return {access: 'ALLOW'}
    if (!resource.requirement) return {access: 'UNKNOWN'}
    return {access: evaluateRequirement(resource.requirement, permissions) ? 'ALLOW' : 'DENY'}
  }
  if (resource.access === 'PUBLIC') return {read: 'PLAIN', writeRule: 'ALLOW'}
  if (!resource.fieldPolicy) return {read: 'OMIT', writeRule: 'DENY'}
  const field = resource.fieldPolicy
  const read = field.plainRead && evaluateRequirement(field.plainRead, permissions) ? 'PLAIN'
    : field.maskedRead && evaluateRequirement(field.maskedRead, permissions) ? 'MASKED' : 'OMIT'
  return {read, writeRule: field.write && evaluateRequirement(field.write, permissions) ? 'ALLOW' : 'DENY'}
}

const referencedCodes = resource => {
  if (!resource) return []
  const result = new Set()
  const visit = requirement => {
    if (!requirement) return
    if (Array.isArray(requirement.allOf)) requirement.allOf.forEach(visit)
    else if (Array.isArray(requirement.codes)) requirement.codes.forEach(code => result.add(code))
  }
  visit(resource.requirement)
  for (const rule of ['plainRead', 'maskedRead', 'write']) visit(resource.fieldPolicy?.[rule])
  return [...result].sort()
}

/** Accepts existing descriptor, producer-list, registration and qualification receipts as files. */
export const loadReleaseInventory = async file => {
  const root = dirname(file)
  const input = async value => {
    const parsed = typeof value === 'string' ? parseStrictJson(await readFile(resolve(root, value))) : value
    return parsed?.success === true && parsed?.code === 10000 ? parsed.data : parsed
  }
  const source = await input(file)
  if (!record(source)) throw new Error('RELEASE_INVENTORY_INVALID')
  const descriptor = await input(source.descriptor)
  const list = source.producerList ? await input(source.producerList) : null
  if (list && (!record(descriptor) || !same(list.target, descriptor.scope) || list.activeRevision !== descriptor.activationVersion
    || !Array.isArray(list.producers))) throw new Error('RELEASE_PRODUCER_LIST_BINDING_INVALID')
  const enabledProducers = list ? list.producers.map(value => value.producerId) : source.enabledProducers
  if (!Array.isArray(source.currentManifests) || !Array.isArray(source.candidates) || !Array.isArray(source.qualifications)) {
    throw new Error('RELEASE_INVENTORY_INVALID')
  }
  const currentManifests = await Promise.all(source.currentManifests.map(input))
  const candidates = await Promise.all(source.candidates.map(async entry => {
    const manifest = await input(entry.manifest)
    if (!entry.registration || !entry.evidence) return {...entry, manifest}
    const registration = await input(entry.registration)
    const evidence = await input(entry.evidence)
    const receipt = registration?.receipt
    if (!record(receipt) || !record(evidence) || !record(manifest)
      || !same(receipt.scope, descriptor.scope) || receipt.producerId !== manifest.producer?.id
      || evidence.producerId !== manifest.producer?.id || !same(receipt.digests, digest(manifest))
      || !same(evidence.artifact, manifest.artifact) || evidence.manifestDigest !== digest(manifest).manifestDigest
      || evidence.policyDigest !== digest(manifest).policyDigest || !hash(evidence.artifactDigest)) {
      throw new Error('RELEASE_CANDIDATE_RECEIPT_MISMATCH')
    }
    return {producerVersion: receipt.producerVersion, state: registration.currentState, manifest, artifactDigest: evidence.artifactDigest,
      ...(entry.diff ? {serverDiff: await input(entry.diff)} : {})}
  }))
  const qualifications = await Promise.all(source.qualifications.map(async entry => {
    const value = await input(entry)
    if (!value?.attestation) return value
    if (!same(value.attestation.target, descriptor.scope)) throw new Error('RELEASE_QUALIFICATION_SCOPE_MISMATCH')
    return {...value.attestation, qualificationId: value.qualificationId, verifiedAt: value.verifiedAt, expiresAt: value.expiresAt}
  }))
  const roleSnapshots = source.roleSnapshots ? await input(source.roleSnapshots) : null
  return {schemaVersion: source.schemaVersion, descriptor, enabledProducers, currentManifests, candidates, qualifications, roleSnapshots}
}

/** Offline review aid. Authority, current revision and deployment qualifications remain server checks. */
export const createReleasePlan = (inventory, {validate, now = Date.now()} = {}) => {
  if (!record(inventory) || inventory.schemaVersion !== 1 || !record(inventory.descriptor)
    || !Array.isArray(inventory.enabledProducers) || !Array.isArray(inventory.currentManifests)
    || !Array.isArray(inventory.candidates) || !Array.isArray(inventory.qualifications)
    || inventory.enabledProducers.length < 1 || inventory.enabledProducers.length > 256
    || !Number.isFinite(now)) throw new Error('RELEASE_INVENTORY_INVALID')
  const descriptor = inventory.descriptor
  validateCatalogTarget(descriptor.scope)
  if (!decimal(descriptor.activationVersion) || !Array.isArray(descriptor.producers)
    || descriptor.producers.length !== inventory.enabledProducers.length
    || inventory.currentManifests.length !== descriptor.producers.length
    || inventory.candidates.length > descriptor.producers.length || inventory.qualifications.length > 512) {
    throw new Error('RELEASE_INVENTORY_INCOMPLETE')
  }
  const enabled = [...inventory.enabledProducers].sort()
  if (enabled.some(value => !id(value)) || new Set(enabled).size !== enabled.length) throw new Error('RELEASE_PRODUCER_SET_INVALID')
  const selected = new Map()
  const current = new Map()
  for (const input of inventory.currentManifests) {
    const manifest = validate(input)
    if (manifest.producer.snapshotMode !== 'FULL' || current.has(manifest.producer.id)) throw new Error('RELEASE_MANIFEST_SET_INVALID')
    current.set(manifest.producer.id, manifest)
  }
  for (const member of descriptor.producers) {
    if (!record(member)) throw new Error('RELEASE_ACTIVE_BINDING_INVALID')
    const manifest = current.get(member.producerId)
    if (!manifest || selected.has(member.producerId) || !decimal(member.producerVersion) || !decimal(member.qualificationId)
      || !hash(member.artifactDigest) || !same(digest(manifest), member.digests)
      || member.sourceVersion !== member.digests.manifestDigest
      || manifest.application.businessCode !== descriptor.scope.businessCode
      || manifest.application.applicationCode !== descriptor.scope.applicationCode) throw new Error('RELEASE_ACTIVE_BINDING_INVALID')
    selected.set(member.producerId, {producerId: member.producerId, previousVersion: member.producerVersion,
      producerVersion: member.producerVersion, artifactDigest: member.artifactDigest, manifest, action: 'REUSE', diff: null})
  }
  if (!same([...selected.keys()].sort(), enabled)) throw new Error('RELEASE_PRODUCER_SET_INVALID')
  const changed = new Set()
  for (const candidate of inventory.candidates) {
    if (!record(candidate) || !decimal(candidate.producerVersion) || !hash(candidate.artifactDigest)
      || !['READY', 'METADATA_PENDING', 'FAILED'].includes(candidate.state)) throw new Error('RELEASE_CANDIDATE_INVALID')
    const manifest = validate(candidate.manifest)
    const producer = manifest.producer.id
    const old = selected.get(producer)
    if (!old || changed.has(producer) || manifest.producer.snapshotMode !== 'FULL'
      || candidate.producerVersion === old.producerVersion || !same(manifest.application, old.manifest.application)) throw new Error('RELEASE_CANDIDATE_BINDING_INVALID')
    changed.add(producer)
    const comparison = compareManifests(old.manifest, manifest)
    let serverDiff = null
    if (candidate.serverDiff) {
      const review = candidate.serverDiff
      if (!record(review) || !same(review.target, descriptor.scope) || review.producerId !== producer
        || review.producerVersion !== candidate.producerVersion || review.expectedActiveRevision !== descriptor.activationVersion
        || !same(review.digests, digest(manifest)) || !record(review.diff)
        || review.diff.absenceCompared !== true || typeof review.diff.authorizationExpansion !== 'boolean' || !Array.isArray(review.diff.conflicts)
        || !Array.isArray(review.diff.entries) || review.diff.entries.length > 40_000
        || review.diff.conflicts.length > 40_000 || review.diff.conflicts.some(value => typeof value !== 'string' || value.length > 2048)
        || review.diff.entries.some(value => !record(value) || !['kind', 'domain', 'key', 'reason'].every(key =>
          typeof value[key] === 'string' && value[key].length <= 2048) || typeof value.authorizationExpansion !== 'boolean')
        || review.diff.entries.some(value => value.authorizationExpansion) && !review.diff.authorizationExpansion) {
        throw new Error('RELEASE_SERVER_DIFF_BINDING_INVALID')
      }
      serverDiff = review.diff
    }
    selected.set(producer, {...old, producerVersion: candidate.producerVersion, artifactDigest: candidate.artifactDigest,
      previousManifest: old.manifest, manifest, action: 'DEPLOY_NEW_VERSION', candidateState: candidate.state, serverDiff,
      diff: {policyChanged: comparison.before.policyDigest !== comparison.after.policyDigest,
        metadataChanged: comparison.before.metadataDigest !== comparison.after.metadataDigest,
        resources: comparison.resources, permissions: comparison.permissions, messages: comparison.messages}})
  }
  const definitions = new Map(); const resources = new Map(); const messages = new Set(); const blockers = []
  const permissionNames = new Set(); const resourceNames = new Set(); const messageNames = new Set()
  for (const item of selected.values()) {
    for (const value of item.manifest.permissionDefinitions) {
      if (permissionNames.has(value.code.toLowerCase())) throw new Error('RELEASE_DUPLICATE_PERMISSION_OWNER')
      permissionNames.add(value.code.toLowerCase())
      definitions.set(value.code, item.producerId)
    }
    for (const value of item.manifest.resources) {
      if (resourceNames.has(value.key.toLowerCase())) throw new Error('RELEASE_DUPLICATE_RESOURCE_OWNER')
      resourceNames.add(value.key.toLowerCase())
      resources.set(value.key, {owner: item.producerId, type: value.type})
    }
    for (const value of item.manifest.messages) {
      const key = value.pageCode + '/' + value.key
      if (messageNames.has(key.toLowerCase())) throw new Error('RELEASE_DUPLICATE_MESSAGE_OWNER')
      messageNames.add(key.toLowerCase())
      messages.add(key)
    }
  }
  for (const item of selected.values()) {
    const selectedDigests = digest(item.manifest)
    item.manifestDigest = selectedDigests.manifestDigest
    for (const code of item.manifest.permissionReferences) if (!definitions.has(code)) blockers.push(item.producerId + ':MISSING_PERMISSION:' + code)
    for (const ref of item.manifest.resourceReferences) {
      const target = resources.get(ref.key)
      if (!target || ['FORM_FIELD', 'TABLE_FIELD', 'DETAIL_FIELD'].includes(ref.usage) && target.type !== 'FIELD'
        || ref.usage === 'CALLS' && target.type !== 'API') blockers.push(item.producerId + ':MISSING_RESOURCE:' + ref.key + ':' + ref.usage)
    }
    for (const value of [...item.manifest.resources, ...item.manifest.permissionDefinitions]) {
      for (const [key, message] of Object.entries(value.i18n)) {
        if (key !== 'pageCode' && message && !messages.has(value.i18n.pageCode + '/' + message)) blockers.push(item.producerId + ':MISSING_MESSAGE:' + value.i18n.pageCode + '/' + message)
      }
    }
    if (item.candidateState && item.candidateState !== 'READY') blockers.push(item.producerId + ':CANDIDATE_NOT_READY')
    if (item.action === 'DEPLOY_NEW_VERSION' && !item.serverDiff) blockers.push(item.producerId + ':SERVER_DIFF_REQUIRED')
    if (item.serverDiff?.conflicts.length) blockers.push(item.producerId + ':SERVER_DIFF_CONFLICT')
    if (item.serverDiff?.authorizationExpansion) blockers.push(item.producerId + ':AUTHORIZATION_EXPANSION_REQUIRES_REVIEW')
    const matches = inventory.qualifications.filter(qualification => record(qualification) && record(qualification.target)
      && same(qualification.target, descriptor.scope) && qualification.producerId === item.producerId
      && qualification.producerVersion === item.producerVersion && qualification.artifactDigest === item.artifactDigest
      && qualification.manifestDigest === selectedDigests.manifestDigest && qualification.policyDigest === selectedDigests.policyDigest
      && decimal(qualification.qualificationId) && typeof qualification.expiresAt === 'string'
      && /^\d{4}-\d{2}-\d{2}T.+Z$/.test(qualification.expiresAt)
      && typeof qualification.verifiedAt === 'string' && /^\d{4}-\d{2}-\d{2}T.+Z$/.test(qualification.verifiedAt)
      && Number.isFinite(Date.parse(qualification.verifiedAt)) && Date.parse(qualification.verifiedAt) <= now
      && Number.isFinite(Date.parse(qualification.expiresAt)) && Date.parse(qualification.expiresAt) > now)
    matches.sort((left, right) => Date.parse(right.expiresAt) - Date.parse(left.expiresAt)
      || (BigInt(left.qualificationId) < BigInt(right.qualificationId) ? -1 : BigInt(left.qualificationId) > BigInt(right.qualificationId) ? 1 : 0))
    if (!matches.length) blockers.push(item.producerId + ':CURRENT_QUALIFICATION_REQUIRED')
    item.qualificationId = matches[0]?.qualificationId ?? null
  }
  const producers = [...selected.values()].sort((a, b) => a.producerId.localeCompare(b.producerId, 'en')).map(item => ({
    producerId: item.producerId, previousVersion: item.previousVersion, producerVersion: item.producerVersion, action: item.action,
    artifactDigest: item.artifactDigest, manifestDigest: item.manifestDigest,
    qualificationId: item.qualificationId, qualification: item.qualificationId ? 'REVALIDATE_ON_SERVER' : 'REQUALIFICATION_REQUIRED',
    ...(item.diff ? {diff: item.diff, authorizationExpansion: item.serverDiff
      ? item.serverDiff.authorizationExpansion ? 'EXPANSION_REPORTED' : 'NO_EXPANSION_REPORTED'
      : 'SERVER_DIFF_REQUIRED', serverDiff: item.serverDiff} : {})}))
  let roleImpact = {status: 'NOT_PROVIDED'}
  if (inventory.roleSnapshots) {
    const input = inventory.roleSnapshots
    if (!record(input) || !same(input.target, descriptor.scope) || input.expectedActiveRevision !== descriptor.activationVersion
      || !Array.isArray(input.roles) || input.roles.length > 1000 || new Set(input.roles.map(role => role?.roleId)).size !== input.roles.length
      || input.roles.some(role => !record(role) || !decimal(role.roleId) || !Array.isArray(role.permissionCodes)
        || role.permissionCodes.length > 10_000 || role.permissionCodes.some(code => typeof code !== 'string'
          || !/^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(code)))) throw new Error('RELEASE_ROLE_SNAPSHOT_INVALID')
    const items = [...selected.values()].sort((left, right) => left.producerId.localeCompare(right.producerId, 'en'))
    const changes = items.filter(item => item.diff).flatMap(item => {
      const old = new Map(item.previousManifest.resources.map(value => [value.key, value]))
      const next = new Map(item.manifest.resources.map(value => [value.key, value]))
      return [...new Set([...item.diff.resources.added, ...item.diff.resources.removed, ...item.diff.resources.changed])]
        .map(key => ({producerId: item.producerId, resourceKey: key, before: old.get(key), after: next.get(key)}))
    })
    if (changes.length * input.roles.length > 100_000) throw new Error('RELEASE_ROLE_IMPACT_LIMIT')
    const roles = input.roles.map(role => ({roleId: role.roleId, permissions: new Set(role.permissionCodes)}))
      .sort((left, right) => left.roleId.localeCompare(right.roleId, 'en'))
    const results = []
    for (const change of changes) for (const role of roles) {
      const before = expressionDecision(change.before, role.permissions); const after = expressionDecision(change.after, role.permissions)
      if (!same(before, after)) results.push({producerId: change.producerId, resourceKey: change.resourceKey, roleId: role.roleId,
        permissionCodes: [...new Set([...referencedCodes(change.before), ...referencedCodes(change.after)])].sort(), before, after})
    }
    const affectedCodes = new Set(changes.flatMap(change => [...referencedCodes(change.before), ...referencedCodes(change.after)]))
    for (const item of items) if (item.diff) {
      for (const code of [...item.diff.permissions.added, ...item.diff.permissions.removed, ...item.diff.permissions.changed]) affectedCodes.add(code)
    }
    if (affectedCodes.size * roles.length > 100_000) throw new Error('RELEASE_ROLE_IMPACT_LIMIT')
    const associations = new Map([...affectedCodes].sort().map(code => [code, {permissionCode: code, resources: [], roles: []}]))
    for (const item of items) for (const resource of item.manifest.resources) {
      for (const code of referencedCodes(resource)) associations.get(code)?.resources.push({producerId: item.producerId, resourceKey: resource.key})
    }
    for (const [code, association] of associations) {
      association.roles = roles.filter(role => role.permissions.has(code)).map(role => role.roleId).sort()
    }
    roleImpact = {status: 'EXPRESSION_ONLY', roles: input.roles.length, changedDecisions: results,
      permissionAssociations: [...associations.values()],
      limitations: ['UNTRUSTED_ROLE_SNAPSHOT_REQUIRES_REVALIDATION', 'ROLE_SNAPSHOT_MAY_BE_INCOMPLETE',
        'OAUTH_SCOPE_DATA_SCOPE_AND_INPUT_BINDING_NOT_EVALUATED']}
  }
  return {status: blockers.length ? 'BLOCKED' : changed.size ? 'REVIEW_REQUIRED' : 'NO_CHANGES', target: descriptor.scope,
    expectedActiveRevision: descriptor.activationVersion, producers, roleImpact, blockers: [...new Set(blockers)].sort(),
    limitations: ['UNTRUSTED_INVENTORY_REQUIRES_SERVER_REVALIDATION', 'WIRE_COMPATIBILITY_REQUIRES_REVIEW', 'NO_DEPLOYMENT_OR_ACTIVATION_PERFORMED'],
    order: changed.size ? ['REGISTER_AND_WAIT_READY', 'DEPLOY_OFF_TRAFFIC_AND_QUALIFY', 'REVIEW_COMPLETE_SELECTION_AND_DIFF',
      'STOP_OLD_TRAFFIC_AND_DRAIN', 'EXPLICIT_CAS_ACTIVATION', 'SWITCH_TRAFFIC_AND_VERIFY'] : []}
}
