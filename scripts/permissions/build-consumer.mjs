import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { resolve, relative, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { main } from '../permission-manifest.mjs'
import { parseStrictJson } from './validate-manifest.mjs'
import { canonicalJson, sha256 } from './canonicalize.mjs'
import { verifyToolchain } from './prepare-contract.mjs'

/** A consumer invokes this fixed checkout; there is no sibling/main/latest discovery. */
export const buildConsumer = async ({ root = process.cwd(), env = process.env } = {}) => {
  const generated = resolve(root, '.generated/permissions')
  const manifestPath = resolve(generated, 'manifest-v1.json')
  const evidencePath = resolve(generated, 'build-evidence.json')
  for (const path of [manifestPath, manifestPath + '.report.json', evidencePath,
    resolve(generated, 'artifact-record.json'), resolve(root, 'dist/permission-build.json')]) await rm(path, { force: true })
  if (!env.PAC_TOOLCHAIN_LOCK || !env.PAC_CONTRACT_ARTIFACT) throw new Error('PAC_TOOLCHAIN_LOCK_AND_CONTRACT_ARTIFACT_REQUIRED')
  const lockFile = resolve(root, env.PAC_TOOLCHAIN_LOCK)
  const lock = await verifyToolchain(lockFile)
  const config = parseStrictJson(await readFile(resolve(root, 'permission-manifest.config.json')))
  const packageJson = parseStrictJson(await readFile(resolve(root, 'package.json')))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = git(['rev-parse', 'HEAD'])
  const workingTreeChanged = git(['status', '--porcelain']).length > 0
  if (lock.mode === 'PINNED_COMMIT' && (workingTreeChanged || !env.PAC_BUILD_ID)) throw new Error('IMMUTABLE_PRODUCER_AND_BUILD_ID_REQUIRED')
  const buildId = env.PAC_BUILD_ID ?? 'local-' + randomUUID()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(buildId)) throw new Error('PAC_BUILD_ID_INVALID')
  const buildConfig = { ...config, artifact: { ...config.artifact, commit, buildId, version: packageJson.version } }
  await mkdir(generated, { recursive: true })
  const configPath = resolve(generated, 'scan-config.json')
  await writeFile(configPath, canonicalJson(buildConfig) + '\n')
  await main(['prepare', '--lock', lockFile, '--artifact', resolve(root, env.PAC_CONTRACT_ARTIFACT)], root)
  const scan = await main(['scan', '--config', configPath, '--root', root, '--output', manifestPath, '--lock', lockFile], root)
  await main(['validate', '--manifest', manifestPath, '--lock', lockFile], root)
  const evidence = { schemaVersion: 1, mode: lock.mode, application: config.application, producerId: config.producerId,
    artifact: buildConfig.artifact, workingTreeChanged, sourceDigest: scan.sourceDigest, policyDigest: scan.policyDigest,
    metadataDigest: scan.metadataDigest, manifestDigest: scan.manifestDigest, toolSourceDigest: scan.toolSourceDigest,
    dependencyLockSha256: scan.dependencyLockSha256, contractSha256: scan.contractSha256 }
  const buildEvidence = { ...evidence, buildEvidenceDigest: sha256(canonicalJson(evidence)) }
  await writeFile(evidencePath, canonicalJson(buildEvidence) + '\n')
  const require = createRequire(resolve(root, 'package.json'))
  const childEnvironment = { ...env, PAC_BUILD_EVIDENCE_FILE: evidencePath, PAC_BUILD_EVIDENCE_DIGEST: buildEvidence.buildEvidenceDigest }
  const run = (path, args) => execFileSync(process.execPath, [path, ...args], { cwd: root, env: childEnvironment, stdio: 'inherit' })
  try {
    run(require.resolve('typescript/bin/tsc'), ['-b'])
    run(resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), ['build'])
    for (const file of scan.sourceFiles) {
      if (sha256(await readFile(resolve(root, file.path))) !== file.sha256) throw new Error('BUILD_PERMISSION_SOURCE_CHANGED')
    }
    const embedded = parseStrictJson(await readFile(resolve(root, 'dist/permission-build.json')))
    if (canonicalJson(embedded) !== canonicalJson(buildEvidence)) throw new Error('BUILD_EVIDENCE_NOT_EMBEDDED')
    const artifactFiles = []
    const collect = async directory => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const path = resolve(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error('BUILD_ARTIFACT_SYMLINK_FORBIDDEN')
        if (entry.isDirectory()) await collect(path)
        else artifactFiles.push({ path: relative(resolve(root, 'dist'), path).replaceAll('\\', '/'), sha256: sha256(await readFile(path)) })
      }
    }
    await collect(resolve(root, 'dist'))
    const result = { status: 'BUILT', ...buildEvidence, artifactDigest: sha256(canonicalJson(artifactFiles)), artifactFiles }
    await writeFile(resolve(generated, 'artifact-record.json'), canonicalJson(result) + '\n')
    return result
  } catch (error) {
    await rm(evidencePath, { force: true })
    await rm(resolve(root, 'dist/permission-build.json'), { force: true })
    await rm(resolve(generated, 'artifact-record.json'), { force: true })
    throw error
  }
}
