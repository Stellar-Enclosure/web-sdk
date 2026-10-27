import { readFile, writeFile, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { canonicalJson, sha256, manifestDigests } from './canonicalize.mjs'
import { createManifestValidator, parseStrictJson } from './validate-manifest.mjs'
import { canonicalJdk25Locale, isCanonicalJdk25Locale } from './jdk25-locale.mjs'
import { evaluateRequirement } from '../../packages/stellar-enclosure-web-shared/src/permissions/evaluateRequirement.ts'

export const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const CONTRACT_ENTRIES = [
  'permission-manifest/schema-v1.json', 'permission-contract/manifest-v1.json',
  'permission-contract/canonical-v1.json', 'permission-contract/requirements-v1.json', 'permission-contract/locales-v1.json',
]
const hash = value => /^[a-f0-9]{64}$/.test(value)
const oid = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
const git = args => execFileSync('git', args, { cwd: toolRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export const toolSourceDigest = async () => {
  const roots = ['packages/stellar-enclosure-web-shared/src/i18n/jdk25Locale.ts', 'package.json', 'packages/stellar-enclosure-web-shared/package.json', 'packages/stellar-enclosure-web-shared/vite.config.ts', 'scripts/permission-manifest.mjs', 'scripts/verify-consumers.mjs', 'scripts/permissions', 'packages/stellar-enclosure-web-shared/src/permissions']
  const entries = []
  const visit = async path => {
    const absolute = resolve(toolRoot, path)
    if ((await stat(absolute)).isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(path + '/' + name)
    } else if (!path.includes('.test.') && /\.(?:mjs|ts|json|py)$/.test(path)) entries.push([path, sha256(await readFile(absolute))])
  }
  for (const root of roots) await visit(root)
  return sha256(canonicalJson(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b, 'en')))))
}

export const verifyToolchain = async (lockFile, { online = false } = {}) => {
  const lock = parseStrictJson(await readFile(lockFile))
  if (lock.schemaVersion !== 1 || !['LOCAL_UNCOMMITTED', 'PINNED_COMMIT'].includes(lock.mode) || lock.nodeMajor !== 24
    || Number(process.versions.node.split('.')[0]) !== lock.nodeMajor || !hash(lock.sdk?.sourceDigest)
    || !hash(lock.sdk?.dependencyLockSha256) || !hash(lock.contract?.sha256) || typeof lock.contractDirectory !== 'string') throw new Error('TOOLCHAIN_LOCK_INVALID')
  if (lock.mode === 'LOCAL_UNCOMMITTED' && online) throw new Error('LOCAL_UNCOMMITTED_ONLINE_FORBIDDEN')
  if (lock.sdk.sourceDigest !== await toolSourceDigest() || lock.sdk.dependencyLockSha256 !== sha256(await readFile(resolve(toolRoot, 'package-lock.json')))) throw new Error('TOOLCHAIN_SOURCE_OR_DEPENDENCY_DIGEST_MISMATCH')
  if (lock.mode === 'PINNED_COMMIT') {
    if (!oid(lock.sdk.commit) || git(['rev-parse', 'HEAD']) !== lock.sdk.commit || git(['status', '--porcelain']).length > 0) throw new Error('PINNED_TOOL_CHECKOUT_REQUIRED')
  }
  for (const entry of CONTRACT_ENTRIES) if (!hash(lock.contract.entries?.[entry])) throw new Error('CONTRACT_ENTRY_DIGEST_MISSING')
  return lock
}

export const createToolchainLock = async ({ artifact, artifactSha256, output, contractDirectory = '.generated/permission-contract', mode = 'LOCAL_UNCOMMITTED', sdkCommit }) => {
  if (!hash(artifactSha256)) throw new Error('EXPECTED_CONTRACT_SHA256_REQUIRED')
  const bytes = await readFile(artifact)
  if (bytes.length > 64 * 1024 * 1024 || sha256(bytes) !== artifactSha256) throw new Error('CONTRACT_ARTIFACT_DIGEST_MISMATCH')
  if (!['LOCAL_UNCOMMITTED', 'PINNED_COMMIT'].includes(mode)) throw new Error('TOOLCHAIN_MODE_INVALID')
  if (mode === 'PINNED_COMMIT' && (!oid(sdkCommit) || git(['rev-parse', 'HEAD']) !== sdkCommit || git(['status', '--porcelain']))) throw new Error('PINNED_TOOL_CHECKOUT_REQUIRED')
  const entries = {}
  for (const entry of CONTRACT_ENTRIES) entries[entry] = sha256(extract(artifact, entry))
  if (sha256(await readFile(artifact)) !== artifactSha256) throw new Error('CONTRACT_ARTIFACT_CHANGED')
  const lock = { schemaVersion: 1, mode, nodeMajor: 24, sdk: { commit: mode === 'PINNED_COMMIT' ? sdkCommit : null,
    sourceDigest: await toolSourceDigest(), dependencyLockSha256: sha256(await readFile(resolve(toolRoot, 'package-lock.json'))) },
    contract: { coordinates: 'top.egon:stellar-enclosure-tianquan-jianshen-contract:0.0.1', sha256: artifactSha256, entries }, contractDirectory }
  await writeFile(output, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' })
  return lock
}

const extract = (artifact, entry) => execFileSync('unzip', ['-p', artifact, entry], { maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
export const prepareContract = async ({ lockFile, artifact }) => {
  const lock = await verifyToolchain(lockFile)
  const path = await realpath(artifact)
  if (sha256(await readFile(path)) !== lock.contract.sha256) throw new Error('CONTRACT_ARTIFACT_DIGEST_MISMATCH')
  const directory = resolve(dirname(lockFile), lock.contractDirectory)
  await mkdir(directory, { recursive: true })
  for (const entry of CONTRACT_ENTRIES) {
    const bytes = extract(path, entry)
    if (sha256(bytes) !== lock.contract.entries[entry]) throw new Error('CONTRACT_ENTRY_DIGEST_MISMATCH')
    parseStrictJson(bytes)
    await writeFile(resolve(directory, entry.split('/').at(-1)), bytes)
  }
  if (sha256(await readFile(path)) !== lock.contract.sha256) throw new Error('CONTRACT_ARTIFACT_CHANGED')
  await writeFile(resolve(directory, 'artifact.json'), JSON.stringify({ coordinates: lock.contract.coordinates, sha256: lock.contract.sha256 }) + '\n')
  return loadContract(lockFile)
}

export const loadContract = async lockFile => {
  const lock = await verifyToolchain(lockFile)
  const directory = resolve(dirname(lockFile), lock.contractDirectory)
  const files = {}
  for (const entry of CONTRACT_ENTRIES) {
    const bytes = await readFile(resolve(directory, entry.split('/').at(-1)))
    if (sha256(bytes) !== lock.contract.entries[entry]) throw new Error('PREPARED_CONTRACT_DIGEST_MISMATCH')
    files[entry] = parseStrictJson(bytes)
  }
  const schema = files[CONTRACT_ENTRIES[0]]
  const validate = createManifestValidator(schema)
  const manifest = validate(files[CONTRACT_ENTRIES[1]])
  const expected = files[CONTRACT_ENTRIES[2]]
  if (canonicalJson(manifestDigests(manifest)) !== canonicalJson(expected)) throw new Error('RC_CANONICAL_FIXTURE_MISMATCH')
  const requirements = files[CONTRACT_ENTRIES[3]]
  if (requirements.some(value => evaluateRequirement(value.requirement, new Set(value.effective)) !== value.allow)) throw new Error('RC_REQUIREMENT_FIXTURE_MISMATCH')
  const locales = files[CONTRACT_ENTRIES[4]]
  if (locales.cases.some(value => canonicalJdk25Locale(value.input) !== value.canonical || isCanonicalJdk25Locale(value.input) !== value.valid)) throw new Error('RC_LOCALE_FIXTURE_MISMATCH')
  return { lock, directory, schema, validate, manifest, canonical: expected, requirements, locales }
}

