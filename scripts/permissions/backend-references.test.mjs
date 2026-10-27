import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { backendReferences, backendReferencesSource } from './backend-references.mjs'
import { manifestDigests } from './canonicalize.mjs'
import { contract, fixture, lockFile } from './test-support.mjs'
import { main } from '../permission-manifest.mjs'
import { prepareConsumerBackend } from './prepare-consumer-backend.mjs'
import { mkdir } from 'node:fs/promises'

const expected = manifest => ({producerId: manifest.producer.id, businessCode: manifest.application.businessCode,
  applicationCode: manifest.application.applicationCode, manifestDigest: manifestDigests(manifest).manifestDigest})

test('backend references are deterministic and retain the fixed manifest ownership', () => {
  const manifest = contract.manifest
  const references = backendReferences(manifest, expected(manifest))
  assert.equal(references.permissionCodes.orderRead, 'order:read')
  assert.equal(references.apiKeys.orderApiDetail, 'order.api.detail')
  assert.equal(references.fieldKeys.orderFieldAmount, 'order.field.amount')
  assert.equal(backendReferencesSource(references), backendReferencesSource(backendReferences(manifest, expected(manifest))))
  assert.throws(() => backendReferences(manifest, {...expected(manifest), producerId: 'wrong'}), /BACKEND_MANIFEST_BINDING_MISMATCH/)
  assert.throws(() => backendReferences(manifest, {...expected(manifest), manifestDigest: 'f'.repeat(64)}), /BACKEND_MANIFEST_BINDING_MISMATCH/)
  assert.throws(() => backendReferences({...manifest, producer: {...manifest.producer, snapshotMode: 'PARTIAL'}},
    expected({...manifest, producer: {...manifest.producer, snapshotMode: 'PARTIAL'}})), /BACKEND_MANIFEST_BINDING_MISMATCH/)
})

test('a failed generation removes the old output and never overwrites its input', async context => {
  const {root} = await fixture(context)
  const file = join(root, 'manifest.json'); const output = join(root, 'src/backend.ts')
  await writeFile(file, JSON.stringify(contract.manifest))
  const pin = expected(contract.manifest)
  const args = ['backend-references', '--manifest', file, '--manifest-digest', pin.manifestDigest,
    '--producer-id', pin.producerId, '--business-code', pin.businessCode, '--application-code', pin.applicationCode,
    '--output', output, '--lock', lockFile]
  assert.equal((await main(args, root)).status, 'GENERATED')
  assert.match(await readFile(output, 'utf8'), /permissionOrderRead/)
  await assert.rejects(main(args.map(value => value === pin.manifestDigest ? 'f'.repeat(64) : value), root), /BACKEND_MANIFEST_BINDING_MISMATCH/)
  await assert.rejects(readFile(output), /ENOENT/)
  await assert.rejects(main(args.map(value => value === output ? file : value), root), /BACKEND_REFERENCE_OUTPUT_CONFLICT/)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).producer.id, pin.producerId)
})

test('consumer preparation fails closed and removes stale generated references', async context => {
  const {root, config} = await fixture(context)
  config.backendReferences = {producerId: contract.manifest.producer.id, manifestDigest: expected(contract.manifest).manifestDigest}
  const generated = join(root, '.generated/permissions/backend-references.ts')
  await mkdir(join(root, '.generated/permissions'), {recursive: true})
  await writeFile(generated, 'stale')
  await assert.rejects(prepareConsumerBackend({root, env: {}, config}), /PAC_BACKEND_MANIFEST_AND_TOOLCHAIN_REQUIRED/)
  await assert.rejects(readFile(generated), /ENOENT/)
})

test('consumer scan resolves explicit frontend uses from the pinned backend and fails closed on a changed pin', async context => {
  const source = `import {definePermissionReferences, defineResourceReferences, defineResources} from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import {permissionOrderRead, fieldOrderFieldAmount, apiOrderApiDetail} from '../.generated/permissions/backend-references'
export const permissions = definePermissionReferences([permissionOrderRead] as const)
export const references = defineResourceReferences([{key: fieldOrderFieldAmount, usage: 'FORM_FIELD'}, {key: apiOrderApiDetail, usage: 'CALLS'}] as const)
export const resources = defineResources([{key: 'order.page.list', type: 'PAGE', target: {route: '/orders'},
  requirement: {mode: 'ALL', codes: [permissionOrderRead]}, i18n: {pageCode: 'order', labelKey: 'api.detail'}}] as const)`
  const {root, config} = await fixture(context, {'resources.ts': source})
  config.backendReferences = {producerId: contract.manifest.producer.id, manifestDigest: expected(contract.manifest).manifestDigest}
  const configFile = join(root, 'config.json'); const backend = join(root, 'backend.json'); const output = join(root, 'manifest.json')
  await writeFile(configFile, JSON.stringify(config)); await writeFile(backend, JSON.stringify(contract.manifest))
  const args = ['scan', '--config', configFile, '--root', root, '--output', output, '--lock', lockFile]
  await main(args, root, {environment: {PAC_BACKEND_MANIFEST: backend}})
  const result = JSON.parse(await readFile(output, 'utf8'))
  assert.deepEqual(result.permissionReferences, ['order:read'])
  assert.deepEqual(result.resourceReferences.map(value => value.usage).sort(), ['CALLS', 'FORM_FIELD'])
  config.backendReferences.manifestDigest = 'f'.repeat(64)
  await writeFile(configFile, JSON.stringify(config))
  await assert.rejects(main(args, root, {environment: {PAC_BACKEND_MANIFEST: backend}}), /BACKEND_MANIFEST_BINDING_MISMATCH/)
  await assert.rejects(readFile(output), /ENOENT/)
  await assert.rejects(readFile(join(root, '.generated/permissions/backend-references.ts')), /ENOENT/)
})
