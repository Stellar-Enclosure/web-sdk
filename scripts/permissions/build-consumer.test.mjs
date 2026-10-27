import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildConsumer } from './build-consumer.mjs'
import { permissionBuildPlugin } from './consumer-vite-plugin.mjs'
import { canonicalJson, sha256 } from './canonicalize.mjs'

test('a failed consumer build invalidates prior manifest and deployment evidence before requiring credentials-free configuration', async context => {
  const root = await mkdtemp(join(tmpdir(), 'permission-build-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.generated/permissions'), { recursive: true })
  await mkdir(join(root, 'dist'))
  const files = ['.generated/permissions/manifest-v1.json', '.generated/permissions/manifest-v1.json.report.json', '.generated/permissions/backend-references.ts',
    '.generated/permissions/build-evidence.json', '.generated/permissions/artifact-record.json', 'dist/permission-build.json']
  for (const path of files) await writeFile(join(root, path), '{"status":"old-success"}')
  await assert.rejects(buildConsumer({ root, env: {} }), /TOOLCHAIN_LOCK_AND_CONTRACT/)
  for (const path of files) await assert.rejects(readFile(join(root, path)), /ENOENT/)
})

test('Vite requires this invocation digest and embeds exactly the reviewed evidence', async context => {
  const root = await mkdtemp(join(tmpdir(), 'permission-vite-'))
  const previous = { path: process.env.PAC_BUILD_EVIDENCE_FILE, digest: process.env.PAC_BUILD_EVIDENCE_DIGEST }
  context.after(async () => {
    if (previous.path === undefined) delete process.env.PAC_BUILD_EVIDENCE_FILE; else process.env.PAC_BUILD_EVIDENCE_FILE = previous.path
    if (previous.digest === undefined) delete process.env.PAC_BUILD_EVIDENCE_DIGEST; else process.env.PAC_BUILD_EVIDENCE_DIGEST = previous.digest
    await rm(root, { recursive: true, force: true })
  })
  delete process.env.PAC_BUILD_EVIDENCE_FILE
  delete process.env.PAC_BUILD_EVIDENCE_DIGEST
  assert.throws(() => permissionBuildPlugin().configResolved(), /LAUNCHER_REQUIRED/)
  const body = { mode: 'LOCAL_UNCOMMITTED', artifact: { buildId: 'test-build' }, manifestDigest: 'a'.repeat(64) }
  const evidence = { ...body, buildEvidenceDigest: sha256(canonicalJson(body)) }
  process.env.PAC_BUILD_EVIDENCE_FILE = join(root, 'evidence.json')
  process.env.PAC_BUILD_EVIDENCE_DIGEST = 'b'.repeat(64)
  await writeFile(process.env.PAC_BUILD_EVIDENCE_FILE, canonicalJson(evidence))
  assert.throws(() => permissionBuildPlugin().configResolved(), /EVIDENCE_CHANGED/)
  process.env.PAC_BUILD_EVIDENCE_DIGEST = evidence.buildEvidenceDigest
  const plugin = permissionBuildPlugin()
  plugin.configResolved()
  let asset
  plugin.generateBundle.call({ emitFile(value) { asset = value } })
  assert.equal(asset.fileName, 'permission-build.json')
  assert.deepEqual(JSON.parse(asset.source), evidence)
  assert.equal(plugin.transformIndexHtml()[0].attrs.content, evidence.buildEvidenceDigest)
})
