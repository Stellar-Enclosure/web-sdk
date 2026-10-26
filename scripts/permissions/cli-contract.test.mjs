import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../permission-manifest.mjs'
import { manifestDigests } from './canonicalize.mjs'
import { contract, lockFile } from './test-support.mjs'
const operationId = '00000000-0000-4000-8000-000000000001'

test('LOCAL source can prepare dry-run intents but cannot execute any online command', async context => {
  const root = await mkdtemp(join(tmpdir(), 'permission-cli-'))
  context.after(() => rm(root, {recursive: true, force: true}))
  const target = {catalogScopeId: '1', tenantId: '2', ...contract.manifest.application, namespaceCode: 'default', environment: 'test'}
  const profile = {baseUrl: 'https://rbac.example', target, producerId: contract.manifest.producer.id,
    authentication: {issuer: 'https://idp.example/tenants/2', clientId: 'fixture', resource: 'https://rbac.example', scopes: ['catalog:register'], clientSecretFileEnv: 'PAC_UNUSED_SECRET_FILE'}}
  await writeFile(join(root, 'targets.json'), JSON.stringify({schemaVersion: 1, targets: {test: profile}}))
  await writeFile(join(root, 'manifest.json'), JSON.stringify(contract.manifest))
  const {canonical: _canonical, ...digests} = manifestDigests(contract.manifest)
  await writeFile(join(root, 'plan.json'), JSON.stringify({planId: '10', target, producerId: profile.producerId, expectedProducerRevision: '0', expectedActiveRevision: '0', digests,
    diff: {entries: [], conflicts: [], authorizationExpansion: false, absenceCompared: true}, expiresAt: new Date(Date.now() + 60_000).toISOString()}))
  await writeFile(join(root, 'selection.json'), JSON.stringify({target, operationId, expectedActiveRevision: '0', producers: [{producerId: profile.producerId, producerVersion: '1', qualificationId: '20'}]}))
  const common = ['--lock', lockFile, '--target', 'test', '--target-file', 'targets.json', '--output', 'result.json']
  let requests = 0
  const runtime = {fetcher: async () => {requests++; throw new Error('network must remain unused')}}
  for (const command of [
    ['diff', '--manifest', 'manifest.json', '--expected-producer-revision', '0', '--expected-active-revision', '0'],
    ['sync', '--plan', 'plan.json', '--operation-id', operationId], ['activate', '--selection', 'selection.json'],
  ]) {
    assert.equal((await main([...command, ...common, '--dry-run', 'true'], root, runtime)).status, 'DRY_RUN')
    assert.equal(JSON.parse(await readFile(join(root, 'result.json'))).mode, 'LOCAL_UNCOMMITTED')
    await assert.rejects(main([...command, ...common], root, runtime), /LOCAL_UNCOMMITTED_ONLINE_FORBIDDEN/)
  }
  await assert.rejects(main(['status', '--operation-id', operationId, ...common], root, runtime), /LOCAL_UNCOMMITTED_ONLINE_FORBIDDEN/)
  assert.equal(requests, 0)
})
