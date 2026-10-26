#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { main, atomicJson } from '../permission-manifest.mjs'
import { loadContract, verifyToolchain } from './prepare-contract.mjs'
import { canonicalJson, manifestDigests, sha256 } from './canonicalize.mjs'
import { parseStrictJson } from './validate-manifest.mjs'
import { PermissionToolFailure } from './registration-client.mjs'

const hashFile = async path => {
  const info = await stat(path)
  if (!info.isFile() || info.size > 1024 * 1024 * 1024) throw new Error('ARTIFACT_FILE_INVALID')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
const gitFacts = cwd => ({head: execFileSync('git', ['rev-parse', 'HEAD'], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim().length > 0})

export const verifyArtifact = async ({manifestFile, evidenceFile, artifact, lockFile, cwd = process.cwd(), repository = gitFacts}) => {
  const contract = await loadContract(lockFile)
  const manifest = contract.validate(parseStrictJson(await readFile(manifestFile)))
  const evidence = parseStrictJson(await readFile(evidenceFile))
  const facts = repository(cwd)
  if (manifest.producer.snapshotMode !== 'FULL' || manifest.artifact.commit !== facts.head
    || contract.lock.mode === 'PINNED_COMMIT' && facts.dirty) throw new Error('ARTIFACT_REPOSITORY_OR_COMPLETENESS_MISMATCH')
  const {canonical: _canonical, ...digests} = manifestDigests(manifest)
  if (evidence.producerId !== manifest.producer.id || canonicalJson(evidence.artifact) !== canonicalJson(manifest.artifact)
    || Object.entries(digests).some(([key, digest]) => evidence[key] !== digest)) throw new Error('ARTIFACT_EVIDENCE_BINDING_MISMATCH')
  if ((await stat(artifact)).isDirectory()) {
    if (evidence.status !== 'BUILT' || evidence.schemaVersion !== 1 || !Array.isArray(evidence.artifactFiles)
      || evidence.mode !== contract.lock.mode || evidence.toolSourceDigest !== contract.lock.sdk.sourceDigest
      || evidence.contractSha256 !== contract.lock.contract.sha256 || evidence.dependencyLockSha256 !== contract.lock.sdk.dependencyLockSha256) throw new Error('FRONTEND_BUILD_EVIDENCE_INVALID')
    const files = []
    const visit = async path => {
      for (const entry of (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const child = resolve(path, entry.name)
        if (entry.isSymbolicLink()) throw new Error('ARTIFACT_SYMLINK_FORBIDDEN')
        if (entry.isDirectory()) await visit(child)
        else files.push({path: relative(artifact, child).replaceAll('\\', '/'), sha256: await hashFile(child)})
      }
    }
    await visit(artifact)
    if (sha256(canonicalJson(files)) !== evidence.artifactDigest || canonicalJson(files) !== canonicalJson(evidence.artifactFiles)) throw new Error('ARTIFACT_DIGEST_MISMATCH')
    const embedded = parseStrictJson(await readFile(resolve(artifact, 'permission-build.json')))
    const {buildEvidenceDigest, ...content} = embedded
    if (buildEvidenceDigest !== evidence.buildEvidenceDigest || sha256(canonicalJson(content)) !== buildEvidenceDigest
      || embedded.manifestDigest !== digests.manifestDigest || canonicalJson(embedded.artifact) !== canonicalJson(manifest.artifact)) throw new Error('EMBEDDED_MANIFEST_IDENTITY_MISMATCH')
    const before = canonicalJson(files)
    files.length = 0
    await visit(artifact)
    if (canonicalJson(files) !== before) throw new Error('ARTIFACT_CHANGED_DURING_VERIFICATION')
  } else {
    if (evidence.schemaVersion !== '1.0' || !Array.isArray(evidence.modules)
      || evidence.modules.some(module => typeof module?.module !== 'string' || !/^[a-f0-9]{64}$/.test(module.inputDigest))
      || canonicalJson(evidence.modules.map(module => module.module).sort()) !== canonicalJson([...manifest.producer.scannedModules].sort())) throw new Error('JAVA_ARTIFACT_EVIDENCE_INVALID')
    if (await hashFile(artifact) !== evidence.artifactDigest) throw new Error('ARTIFACT_DIGEST_MISMATCH')
    const entries = execFileSync('unzip', ['-Z1', artifact], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']})
      .split('\n').filter(value => value === 'META-INF/permissions/manifest-v1.json' || value === 'BOOT-INF/classes/META-INF/permissions/manifest-v1.json')
    if (entries.length !== 1) throw new Error('ARTIFACT_REQUIRES_ONE_FULL_MANIFEST')
    const bytes = execFileSync('unzip', ['-p', artifact, entries[0]], {maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']})
    const embedded = contract.validate(parseStrictJson(bytes))
    if (canonicalJson(embedded) !== canonicalJson(manifest)) throw new Error('EMBEDDED_MANIFEST_IDENTITY_MISMATCH')
    if (await hashFile(artifact) !== evidence.artifactDigest) throw new Error('ARTIFACT_CHANGED_DURING_VERIFICATION')
  }
  return {manifest, evidence, result: {status: 'VERIFIED_ARTIFACT', mode: contract.lock.mode, producerId: manifest.producer.id,
    commit: facts.head, workingTreeChanged: facts.dirty, artifactDigest: evidence.artifactDigest, ...digests}}
}

export const ciMain = async (argv = process.argv.slice(2), cwd = process.cwd(), runtime = {}) => {
  const flags = {}
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--') || Object.hasOwn(flags, argv[index].slice(2))) throw new Error('CI_ARGUMENT_INVALID')
    flags[argv[index].slice(2)] = argv[index + 1]
  }
  const allowed = ['phase', 'manifest', 'evidence', 'artifact', 'lock', 'target', 'target-file', 'expected-producer-revision', 'expected-active-revision', 'operation-id', 'output-dir', 'wait-seconds', 'selection']
  if (Object.keys(flags).some(key => !allowed.includes(key)) || !['validate', 'register', 'activate'].includes(flags.phase)) throw new Error('CI_ARGUMENT_INVALID')
  const required = name => {if (!flags[name]) throw new Error('CI_ARGUMENT_REQUIRED:' + name); return flags[name]}
  const lockFile = resolve(cwd, required('lock'))
  const output = resolve(cwd, flags['output-dir'] ?? '.generated/permission-ci')
  if (flags.phase !== 'validate') await verifyToolchain(lockFile, {online: true})
  let verified
  if (flags.phase !== 'activate') {
    verified = await verifyArtifact({manifestFile: resolve(cwd, required('manifest')), evidenceFile: resolve(cwd, required('evidence')),
      artifact: resolve(cwd, required('artifact')), lockFile, cwd, repository: runtime.repository ?? gitFacts})
    await atomicJson(resolve(output, 'validation.json'), verified.result)
    await atomicJson(resolve(output, 'validated-manifest.json'), verified.manifest)
    if (flags.phase === 'validate') return verified.result
  }
  const common = ['--lock', lockFile, '--target', required('target'), '--target-file', resolve(cwd, required('target-file'))]
  if (flags.phase === 'activate') {
    return main(['activate', ...common, '--selection', resolve(cwd, required('selection')), '--output', resolve(output, 'activation.json')], cwd, runtime)
  }
  const plan = resolve(output, 'plan.json')
  await main(['diff', ...common, '--manifest', resolve(output, 'validated-manifest.json'), '--expected-producer-revision', required('expected-producer-revision'),
    '--expected-active-revision', required('expected-active-revision'), '--output', plan], cwd, runtime)
  const operationId = required('operation-id')
  try {await main(['sync', ...common, '--plan', plan, '--operation-id', operationId, '--output', resolve(output, 'registration.json')], cwd, runtime)}
  catch (error) {if (!(error instanceof PermissionToolFailure) || error.exitCode !== 6) throw error}
  return main(['status', ...common, '--operation-id', operationId, '--kind', 'registration', '--wait-seconds', flags['wait-seconds'] ?? '120', '--output', resolve(output, 'status.json')], cwd, runtime)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  ciMain().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    const code = error instanceof PermissionToolFailure ? error.message : /^[A-Z][A-Z0-9_]+/.exec(error?.message ?? '')?.[0] ?? 'CI_PERMISSION_INPUT_INVALID'
    process.stderr.write(JSON.stringify({status: error instanceof PermissionToolFailure && error.exitCode === 6 ? 'PENDING' : 'FAILED', code,
      ...(error instanceof PermissionToolFailure ? error.details : {})}) + '\n')
    process.exitCode = error instanceof PermissionToolFailure ? error.exitCode : 2
  })
}
