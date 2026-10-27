import test from 'node:test'
import assert from 'node:assert/strict'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { contract, fixture, lockFile } from './test-support.mjs'
import { manifestDigests } from './canonicalize.mjs'
import { createReleasePlan, loadReleaseInventory } from './release-plan.mjs'
import { main } from '../permission-manifest.mjs'
import { readFile } from 'node:fs/promises'

const hashes = value => {const {canonical: _canonical, ...result} = manifestDigests(value); return result}
const target = {catalogScopeId: '10', tenantId: '20', businessCode: 'trade', applicationCode: 'order', namespaceCode: 'default', environment: 'test'}
const now = Date.parse('2026-10-27T12:00:00Z')
const review = (manifest, version, expansion = false) => ({target, producerId: manifest.producer.id, producerVersion: version,
  expectedActiveRevision: '3', digests: hashes(manifest), diff: {authorizationExpansion: expansion, conflicts: [], entries: [], absenceCompared: true}})

const fixtures = () => {
  const backend = structuredClone(contract.manifest)
  const frontend = structuredClone(backend)
  frontend.producer = {id: 'order-web', kind: 'REACT_TYPESCRIPT', snapshotMode: 'FULL', ownedKeyPrefixes: ['order.web.'],
    expectedModules: ['console'], scannedModules: ['console'], clearIntent: false}
  frontend.artifact = {repository: 'order-web', commit: 'b'.repeat(40), buildId: 'web-1', version: '1'}
  frontend.permissionDefinitions = []
  frontend.permissionReferences = ['order:read']
  frontend.resources = [{key: 'order.web.page.list', type: 'PAGE', target: {route: '/orders'}, access: 'PROTECTED',
    requirement: {mode: 'ALL', codes: ['order:read']}, allowedPrincipals: ['USER'], oauthScopes: [],
    i18n: {pageCode: 'order.web', labelKey: 'title'}, lifecycle: 'ACTIVE'}]
  frontend.resourceReferences = [{key: 'order.field.amount', usage: 'FORM_FIELD'}]
  frontend.messages = [{pageCode: 'order.web', key: 'title', defaultLocale: 'en', defaults: {en: 'Orders'}}]
  contract.validate(frontend)
  const member = (manifest, qualificationId, artifact) => ({producerId: manifest.producer.id, producerVersion: '1',
    sourceVersion: hashes(manifest).manifestDigest, digests: hashes(manifest), qualificationId, artifactDigest: artifact})
  const qualification = (manifest, version, qualificationId, artifact, expiresAt = '2026-10-27T13:00:00Z') => ({
    producerId: manifest.producer.id, producerVersion: version, qualificationId, artifactDigest: artifact,
    manifestDigest: hashes(manifest).manifestDigest, policyDigest: hashes(manifest).policyDigest, target,
    verifiedAt: '2026-10-27T11:59:00Z', expiresAt})
  const descriptor = {scope: target, activationVersion: '3', producers: [member(backend, '1', 'a'.repeat(64)), member(frontend, '2', 'b'.repeat(64))]}
  const inventory = {schemaVersion: 1, descriptor, enabledProducers: ['order-api', 'order-web'], currentManifests: [backend, frontend],
    candidates: [], qualifications: [qualification(backend, '1', '1', 'a'.repeat(64)), qualification(frontend, '1', '2', 'b'.repeat(64))]}
  return {backend, frontend, inventory, qualification}
}

test('frontend-only deployment retains the backend version while requiring server review', () => {
  const {frontend, inventory, qualification} = fixtures()
  const candidate = structuredClone(frontend)
  candidate.artifact.buildId = 'web-2'
  candidate.messages[0].defaults.en = 'Orders updated'
  inventory.candidates.push({producerVersion: '2', manifest: candidate, artifactDigest: 'c'.repeat(64), state: 'READY', serverDiff: review(candidate, '2')})
  inventory.qualifications.push(qualification(candidate, '2', '3', 'c'.repeat(64)))
  const plan = createReleasePlan(inventory, {validate: contract.validate, now})
  assert.equal(plan.status, 'REVIEW_REQUIRED')
  assert.deepEqual(plan.producers.map(value => [value.producerId, value.producerVersion, value.action]),
    [['order-api', '1', 'REUSE'], ['order-web', '2', 'DEPLOY_NEW_VERSION']])
  assert.equal(plan.producers[1].authorizationExpansion, 'NO_EXPANSION_REPORTED')
  assert.equal(plan.producers[1].diff.policyChanged, false)
  assert.equal(plan.producers[1].diff.metadataChanged, true)
  assert.ok(plan.limitations.includes('NO_DEPLOYMENT_OR_ACTIVATION_PERFORMED'))
})

test('backend-only deployment retains the frontend and expired qualifications block activation planning', () => {
  const {backend, inventory, qualification} = fixtures()
  const candidate = structuredClone(backend)
  candidate.artifact.buildId = 'api-2'
  inventory.candidates.push({producerVersion: '2', manifest: candidate, artifactDigest: 'd'.repeat(64), state: 'READY', serverDiff: review(candidate, '2')})
  inventory.qualifications.push(qualification(candidate, '2', '4', 'd'.repeat(64)))
  let plan = createReleasePlan(inventory, {validate: contract.validate, now})
  assert.equal(plan.status, 'REVIEW_REQUIRED')
  assert.equal(plan.producers[0].diff.policyChanged, false)
  assert.equal(plan.producers[1].action, 'REUSE')
  inventory.qualifications[1].expiresAt = '2026-10-27T11:59:00Z'
  plan = createReleasePlan(inventory, {validate: contract.validate, now})
  assert.equal(plan.status, 'BLOCKED')
  assert.ok(plan.blockers.includes('order-web:CURRENT_QUALIFICATION_REQUIRED'))
})

test('incomplete producer sets, missing field references and stale active manifests cannot pass', () => {
  const {inventory} = fixtures()
  assert.throws(() => createReleasePlan({...inventory, enabledProducers: ['order-api']}, {validate: contract.validate, now}), /RELEASE_INVENTORY_INCOMPLETE/)
  const missing = structuredClone(inventory)
  missing.currentManifests[1].resourceReferences[0].key = 'order.field.missing'
  const web = missing.descriptor.producers[1]
  web.digests = hashes(missing.currentManifests[1]); web.sourceVersion = web.digests.manifestDigest
  const plan = createReleasePlan(missing, {validate: contract.validate, now})
  assert.equal(plan.status, 'BLOCKED')
  assert.ok(plan.blockers.some(value => value.includes('MISSING_RESOURCE:order.field.missing')))
  const stale = structuredClone(inventory)
  stale.currentManifests[0].artifact.buildId = 'different'
  assert.throws(() => createReleasePlan(stale, {validate: contract.validate, now}), /RELEASE_ACTIVE_BINDING_INVALID/)
})

test('file inventory derives producer versions from descriptor and registration receipts', async context => {
  const {root} = await fixture(context)
  const {backend, frontend, inventory, qualification} = fixtures()
  const next = structuredClone(frontend); next.artifact.buildId = 'web-2'
  const files = {
    'descriptor.json': inventory.descriptor,
    'producers.json': {target, activeRevision: '3', producers: [{producerId: 'order-api'}, {producerId: 'order-web'}]},
    'backend.json': backend, 'frontend.json': frontend, 'candidate.json': next,
    'registration.json': {currentState: 'READY', receipt: {scope: target, producerId: 'order-web', producerVersion: '2', digests: hashes(next)}},
    'evidence.json': {producerId: 'order-web', artifact: next.artifact, ...hashes(next), artifactDigest: 'c'.repeat(64)},
    'api-qualification.json': qualification(backend, '1', '1', 'a'.repeat(64)),
    'web-qualification.json': qualification(next, '2', '3', 'c'.repeat(64)),
    'diff.json': review(next, '2'),
    'inventory.json': {schemaVersion: 1, descriptor: 'descriptor.json', producerList: 'producers.json',
      currentManifests: ['backend.json', 'frontend.json'],
      candidates: [{manifest: 'candidate.json', registration: 'registration.json', evidence: 'evidence.json', diff: 'diff.json'}],
      qualifications: ['api-qualification.json', 'web-qualification.json']},
  }
  await Promise.all(Object.entries(files).map(([name, value]) => writeFile(join(root, name), JSON.stringify(value))))
  const assembled = await loadReleaseInventory(join(root, 'inventory.json'))
  const plan = createReleasePlan(assembled, {validate: contract.validate, now})
  assert.equal(plan.status, 'REVIEW_REQUIRED')
  assert.deepEqual(plan.producers.map(value => value.producerVersion), ['1', '2'])
  files['registration.json'].receipt.digests.manifestDigest = 'f'.repeat(64)
  await writeFile(join(root, 'registration.json'), JSON.stringify(files['registration.json']))
  await assert.rejects(loadReleaseInventory(join(root, 'inventory.json')), /RELEASE_CANDIDATE_RECEIPT_MISMATCH/)
})

test('a reported authorization expansion blocks the plan', () => {
  const {frontend, inventory, qualification} = fixtures()
  const next = structuredClone(frontend); next.artifact.buildId = 'web-2'
  next.resources.push({...next.resources[0], key: 'order.web.page.detail', target: {route: '/orders/detail'}})
  inventory.candidates.push({producerVersion: '2', manifest: next, artifactDigest: 'c'.repeat(64), state: 'READY', serverDiff: review(next, '2', true)})
  inventory.qualifications.push(qualification(next, '2', '3', 'c'.repeat(64)))
  inventory.roleSnapshots = {target, expectedActiveRevision: '3', roles: [{roleId: '7', permissionCodes: ['order:read']}]}
  const plan = createReleasePlan(inventory, {validate: contract.validate, now})
  assert.equal(plan.status, 'BLOCKED')
  assert.ok(plan.blockers.includes('order-web:AUTHORIZATION_EXPANSION_REQUIRES_REVIEW'))
  assert.deepEqual(plan.roleImpact.changedDecisions.map(value => [value.roleId, value.before.access, value.after.access]), [['7', 'ABSENT', 'ALLOW']])
})

test('optional role impact compares API and field expressions without claiming a full authorization decision', () => {
  const {backend, inventory, qualification} = fixtures()
  const next = structuredClone(backend); next.artifact.buildId = 'api-2'
  next.resources.find(value => value.type === 'API').requirement = {mode: 'ANY', codes: ['order:read', 'order:amount:write']}
  next.resources.find(value => value.type === 'FIELD').fieldPolicy.write = {mode: 'ALL', codes: ['order:read']}
  inventory.candidates.push({producerVersion: '2', manifest: next, artifactDigest: 'c'.repeat(64), state: 'READY', serverDiff: review(next, '2', true)})
  inventory.qualifications.push(qualification(next, '2', '3', 'c'.repeat(64)))
  inventory.roleSnapshots = {target, expectedActiveRevision: '3', roles: [
    {roleId: '7', permissionCodes: ['order:amount:write']}, {roleId: '8', permissionCodes: ['order:read']},
  ]}
  const plan = createReleasePlan(inventory, {validate: contract.validate, now})
  assert.equal(plan.status, 'BLOCKED')
  assert.equal(plan.roleImpact.status, 'EXPRESSION_ONLY')
  const api = plan.roleImpact.changedDecisions.find(value => value.roleId === '7' && value.resourceKey === 'order.api.detail')
  assert.deepEqual([api.before.access, api.after.access], ['DENY', 'ALLOW'])
  const field = plan.roleImpact.changedDecisions.find(value => value.roleId === '8' && value.resourceKey === 'order.field.amount')
  assert.deepEqual([field.before.writeRule, field.after.writeRule], ['DENY', 'ALLOW'])
  const association = plan.roleImpact.permissionAssociations.find(value => value.permissionCode === 'order:read')
  assert.deepEqual(association.roles, ['8'])
  assert.ok(association.resources.some(value => value.producerId === 'order-web' && value.resourceKey === 'order.web.page.list'))
  assert.ok(plan.roleImpact.limitations.includes('OAUTH_SCOPE_DATA_SCOPE_AND_INPUT_BINDING_NOT_EVALUATED'))
})

test('CLI produces no activation for an unchanged set and removes stale output on invalid inventory', async context => {
  const {root} = await fixture(context)
  const {inventory} = fixtures()
  for (const value of inventory.qualifications) {
    value.verifiedAt = '2020-01-01T00:00:00Z'
    value.expiresAt = '9999-12-31T23:59:59Z'
  }
  const file = join(root, 'inventory.json'); const output = join(root, 'plan.json')
  await writeFile(file, JSON.stringify(inventory))
  const args = ['release-plan', '--inventory', file, '--output', output, '--lock', lockFile]
  assert.equal((await main(args, root)).status, 'NO_CHANGES')
  assert.equal((await stat(output)).mode & 0o077, 0)
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')).order, [])
  inventory.enabledProducers.pop()
  await writeFile(file, JSON.stringify(inventory))
  await assert.rejects(main(args, root), /RELEASE_INVENTORY_INCOMPLETE/)
  await assert.rejects(readFile(output), /ENOENT/)
})
