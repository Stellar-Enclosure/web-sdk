import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyArtifact, ciMain } from './ci.mjs'
import { canonicalJson, manifestDigests, sha256 } from './canonicalize.mjs'
import { contract, lockFile } from './test-support.mjs'

const fixture = async context => {
  const root = await mkdtemp(join(tmpdir(), 'permission-artifact-'))
  context.after(() => rm(root, {recursive: true, force: true}))
  const manifest = structuredClone(contract.manifest)
  await mkdir(join(root, 'META-INF/permissions'), {recursive: true})
  await writeFile(join(root, 'META-INF/permissions/manifest-v1.json'), canonicalJson(manifest))
  const artifact = join(root, 'producer.jar')
  execFileSync('zip', ['-q', artifact, 'META-INF/permissions/manifest-v1.json'], {cwd: root})
  const {canonical: _canonical, ...digests} = manifestDigests(manifest)
  const evidence = {schemaVersion: '1.0', producerId: manifest.producer.id, artifactFile: 'producer.jar', artifactDigest: sha256(await readFile(artifact)),
    ...digests, artifact: manifest.artifact, modules: manifest.producer.scannedModules.map(module => ({module, kind: 'COMPILED_DIRECTORY', inputDigest: 'a'.repeat(64)})), boundary: 'unit fixture'}
  const evidenceFile = join(root, 'evidence.json'); await writeFile(evidenceFile, JSON.stringify(evidence))
  const manifestFile = join(root, 'manifest.json'); await writeFile(manifestFile, JSON.stringify(manifest))
  return {root, artifact, evidenceFile, manifestFile, evidence, manifest,
    options: {artifact, evidenceFile, manifestFile, lockFile, cwd: root, repository: () => ({head: manifest.artifact.commit, dirty: true})}}
}

test('CI binds one embedded FULL manifest, final bytes and actual producer commit', async context => {
  const value = await fixture(context)
  const result = await verifyArtifact(value.options)
  assert.equal(result.result.status, 'VERIFIED_ARTIFACT')
  assert.equal(result.result.mode, 'LOCAL_UNCOMMITTED')
  assert.equal(result.result.workingTreeChanged, true)
  await assert.rejects(verifyArtifact({...value.options, repository: () => ({head: 'f'.repeat(40), dirty: false})}), /REPOSITORY/)
  await writeFile(value.evidenceFile, JSON.stringify({...value.evidence, artifactDigest: 'b'.repeat(64)}))
  await assert.rejects(verifyArtifact(value.options), /DIGEST_MISMATCH/)
})

test('two competing root and Boot manifests are rejected even when the archive digest matches', async context => {
  const value = await fixture(context)
  await mkdir(join(value.root, 'BOOT-INF/classes/META-INF/permissions'), {recursive: true})
  await writeFile(join(value.root, 'BOOT-INF/classes/META-INF/permissions/manifest-v1.json'), canonicalJson(value.manifest))
  execFileSync('zip', ['-q', value.artifact, 'BOOT-INF/classes/META-INF/permissions/manifest-v1.json'], {cwd: value.root})
  await writeFile(value.evidenceFile, JSON.stringify({...value.evidence, artifactDigest: sha256(await readFile(value.artifact))}))
  await assert.rejects(verifyArtifact(value.options), /ONE_FULL_MANIFEST/)
})

test('CI register and activate reject LOCAL tools before reading targets or credentials', async () => {
  for (const phase of ['register', 'activate']) await assert.rejects(ciMain(['--phase', phase, '--lock', lockFile]), /LOCAL_UNCOMMITTED_ONLINE_FORBIDDEN/)
})
