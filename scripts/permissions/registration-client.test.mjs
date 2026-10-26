import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistrationClient, loadTargetProfile, PermissionToolFailure, validateActivation, waitForOperation } from './registration-client.mjs'
import { manifestDigests } from './canonicalize.mjs'
import { contract } from './test-support.mjs'
const operationId = '00000000-0000-4000-8000-000000000001'
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}})
const envelope = data => json({success: true, code: 10000, data})
const target = {catalogScopeId: '1', tenantId: '2', businessCode: contract.manifest.application.businessCode,
  applicationCode: contract.manifest.application.applicationCode, namespaceCode: 'default', environment: 'test'}
const profile = {baseUrl: 'https://rbac.example', target, producerId: contract.manifest.producer.id,
  authentication: {issuer: 'https://identity.example/tenants/2', clientId: 'ci-client', resource: 'https://rbac.example',
    scopes: ['tianquan-jianshen:permission-manifest:register'], clientSecretFileEnv: 'PAC_TEST_SECRET_FILE'}}
const {canonical: _canonical, ...digests} = manifestDigests(contract.manifest)
const plan = () => ({planId: '10', target, producerId: profile.producerId, expectedProducerRevision: '0', expectedActiveRevision: '0', digests,
  diff: {entries: [], conflicts: [], authorizationExpansion: false, absenceCompared: true}, expiresAt: new Date(Date.now() + 60_000).toISOString()})
const receipt = (currentState = 'METADATA_PENDING') => ({receipt: {operationId, planId: '10', scope: target, producerId: profile.producerId, producerVersion: '1', digests,
  resourceIds: {}, permissionIds: {}, resourceCount: 0, permissionCount: 0, messageCount: 0, registeredAt: new Date().toISOString()}, currentState, failureCode: null})
const fixture = async (context, handler) => {
  const directory = await mkdtemp(join(tmpdir(), 'permission-http-fixture-'))
  context.after(() => rm(directory, {recursive: true, force: true}))
  const secretFile = join(directory, 'secret')
  await writeFile(secretFile, 'synthetic-client-secret\n', {mode: 0o600})
  const calls = []
  const fetcher = async (url, init) => {
    calls.push({url, init})
    if (url.endsWith('/oauth2/token')) return json({access_token: 'synthetic.access.token', token_type: 'Bearer', expires_in: 300})
    return handler(url, init)
  }
  return {directory, secretFile, calls, client: createRegistrationClient(profile, {fetcher, environment: {PAC_TEST_SECRET_FILE: secretFile}})}
}

test('CC and registration bind the fixed resource, full scope, reviewed digests and one operation id', async context => {
  const value = await fixture(context, (url, init) => url.endsWith('/plans') ? envelope(plan()) : envelope(receipt()))
  const reviewed = await value.client.plan(contract.manifest, '0', '0')
  const result = await value.client.register(reviewed, operationId)
  assert.equal(result.currentState, 'METADATA_PENDING')
  assert.equal(value.calls.filter(call => call.url.endsWith('/oauth2/token')).length, 1)
  assert.equal(new URLSearchParams(value.calls[0].init.body).get('resource'), profile.authentication.resource)
  assert.equal(new URLSearchParams(value.calls[0].init.body).get('grant_type'), 'client_credentials')
  assert.equal(value.calls[0].init.redirect, 'error')
  const apply = JSON.parse(value.calls[2].init.body)
  assert.deepEqual(apply, {target, producerId: profile.producerId, planId: '10', operationId, digests, expectedProducerRevision: '0', expectedActiveRevision: '0'})
  assert.equal(JSON.stringify(result).includes('synthetic'), false)
})

test('ambiguous mutation failures never retry or replace the operation id', async context => {
  for (const kind of ['network', 'server', 'malformed', 'wrong-receipt']) {
    const value = await fixture(context, () => {
      if (kind === 'network') throw new TypeError('do not print this provider text')
      if (kind === 'server') return json({error_description: 'synthetic-client-secret'}, 503)
      if (kind === 'malformed') return new Response('not-json synthetic.access.token')
      const result = receipt(); result.receipt.operationId = '00000000-0000-4000-8000-000000000002'; return envelope(result)
    })
    await assert.rejects(value.client.register(plan(), operationId), error => {
      assert.equal(error.exitCode, 6); assert.equal(error.message, 'OPERATION_OUTCOME_UNKNOWN'); assert.equal(error.details.operationId, operationId)
      assert.equal(JSON.stringify(error).includes('synthetic'), false); return true
    })
    assert.equal(value.calls.filter(call => call.init.method === 'POST' && !call.url.endsWith('/oauth2/token')).length, 1)
  }
})

test('CAS and authorization failures have separate exit classes and no retry', async context => {
  for (const [status, exitCode] of [[409, 3], [401, 4], [403, 4]]) {
    const value = await fixture(context, () => json({message: 'ignored private provider message'}, status))
    await assert.rejects(value.client.register(plan(), operationId), error => error.exitCode === exitCode)
    assert.equal(value.calls.length, 2)
  }
})

test('original-outcome lookup keeps producer ids in query and distinguishes missing operations', async context => {
  const value = await fixture(context, url => {
    const query = new URL(url).searchParams
    assert.equal(query.get('producerId'), profile.producerId)
    assert.equal(query.get('tenantId'), target.tenantId)
    return json({}, 404)
  })
  await assert.rejects(value.client.status(operationId), error => error.exitCode === 6 && error.message === 'OPERATION_NOT_FOUND')
  assert.equal(value.calls.at(-1).init.method, 'GET')
})

test('status waits read the same operation and pending never becomes a completed result', async () => {
  let time = 0; const seen = []
  const client = {status: async (id, kind) => {seen.push([id, kind]); return receipt()}}
  await assert.rejects(waitForOperation(client, operationId, 'registration', {seconds: 2, now: () => time, sleep: async ms => {time += ms}}),
    error => error.exitCode === 6 && error.details.currentState === 'METADATA_PENDING')
  assert.equal(seen.length, 3)
  assert(seen.every(([id]) => id === operationId))
  let count = 0
  assert.equal((await waitForOperation({status: async () => receipt(++count === 1 ? 'METADATA_PENDING' : 'READY')}, operationId,
    'registration', {seconds: 2, now: () => time, sleep: async ms => {time += ms}})).status, 'READY')
})

test('activation accepts only existing qualification ids and verifies the returned complete set', async context => {
  const selection = {target, operationId, expectedActiveRevision: '0', producers: [{producerId: profile.producerId, producerVersion: '1', qualificationId: '20'}]}
  const value = await fixture(context, () => envelope({scope: target, operationId, activationVersion: '1', policyVersion: '3', createdAt: new Date().toISOString(),
    producers: [{...selection.producers[0], sourceVersion: digests.manifestDigest, digests, artifactDigest: 'd'.repeat(64)}]}))
  assert.equal((await value.client.activate(selection)).activationVersion, '1')
  assert.throws(() => validateActivation({...selection, artifactDigest: 'forged'}, profile), /INVALID/)
  assert.throws(() => validateActivation({...selection, producers: [{...selection.producers[0], qualificationId: null}]}, profile), /INVALID/)
})

test('credential files must be owner-only and their contents never appear in errors', async context => {
  const value = await fixture(context, () => envelope(receipt()))
  await chmod(value.secretFile, 0o644)
  await assert.rejects(value.client.status(operationId), error => error.exitCode === 4 && !error.message.includes('synthetic'))
  assert.equal(value.calls.length, 0)
})

test('target profiles reject inline credentials, unsafe targets and misleading environment names', async context => {
  const value = await fixture(context, () => envelope(receipt()))
  const path = join(value.directory, 'targets.json')
  await writeFile(path, JSON.stringify({schemaVersion: 1, targets: {test: profile}}))
  assert.deepEqual(await loadTargetProfile(path, 'test'), profile)
  for (const invalid of [{...profile, baseUrl: 'http://unsafe.example'}, {...profile, target: {...target, environment: 'prod'}},
    {...profile, authentication: {...profile.authentication, clientSecret: 'inline-forbidden'}}]) {
    await writeFile(path, JSON.stringify({schemaVersion: 1, targets: {test: invalid}}))
    await assert.rejects(loadTargetProfile(path, 'test'))
  }
})
