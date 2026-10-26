#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createToolchainLock, prepareContract, loadContract, verifyToolchain } from './permissions/prepare-contract.mjs'
import { parseStrictJson } from './permissions/validate-manifest.mjs'
import { scanTypescript } from './permissions/scan-typescript.mjs'
import { canonicalJson, manifestDigests, compareManifests, sha256 } from './permissions/canonicalize.mjs'
import { createRegistrationClient, loadTargetProfile, PermissionToolFailure, preparePlanRequest, registrationRequest, validateActivation, waitForOperation } from './permissions/registration-client.mjs'

const parse = argv => {
  const [command, ...values] = argv
  const flags = {}
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    if (!key?.startsWith('--') || !values[index + 1] || values[index + 1].startsWith('--') || Object.hasOwn(flags, key.slice(2))) throw new Error('CLI_ARGUMENT_INVALID')
    flags[key.slice(2)] = values[index + 1]
  }
  const allowed = {
    lock: ['artifact', 'artifact-sha256', 'output', 'contract-directory', 'mode', 'sdk-commit'],
    prepare: ['lock', 'artifact'], verify: ['lock', 'purpose'],
    scan: ['config', 'output', 'lock', 'root'], validate: ['manifest', 'lock'],
    diff: ['manifest', 'baseline', 'output', 'lock', 'target', 'target-file', 'expected-producer-revision', 'expected-active-revision', 'dry-run'],
    sync: ['plan', 'operation-id', 'lock', 'target', 'target-file', 'output', 'dry-run'],
    status: ['operation-id', 'kind', 'wait-seconds', 'lock', 'target', 'target-file', 'output'],
    activate: ['selection', 'lock', 'target', 'target-file', 'output', 'dry-run'],
  }
  if (!allowed[command]) throw new Error('CLI_COMMAND_UNKNOWN')
  if (Object.keys(flags).some(key => !allowed[command].includes(key))) throw new Error('CLI_UNKNOWN_ARGUMENT')
  return { command, flags }
}
const required = (flags, name) => {
  if (!flags[name]) throw new Error('CLI_ARGUMENT_REQUIRED:' + name)
  return flags[name]
}
export const atomicJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.' + process.pid + '.tmp'
  try { await writeFile(temporary, canonicalJson(value) + '\n', { flag: 'wx' }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}

export const main = async (argv = process.argv.slice(2), cwd = process.cwd(), runtime = {}) => {
  const { command, flags } = parse(argv)
  const lockFile = resolve(cwd, flags.lock ?? process.env.PAC_TOOLCHAIN_LOCK ?? 'permission-toolchain.lock.json')
  if (command === 'lock') {
    const lock = await createToolchainLock({ artifact: resolve(cwd, required(flags, 'artifact')), artifactSha256: required(flags, 'artifact-sha256'),
      output: resolve(cwd, required(flags, 'output')), contractDirectory: flags['contract-directory'], mode: flags.mode, sdkCommit: flags['sdk-commit'] })
    return { status: 'LOCKED', mode: lock.mode, contractSha256: lock.contract.sha256 }
  }
  if (command === 'prepare') {
    const contract = await prepareContract({ lockFile, artifact: resolve(cwd, required(flags, 'artifact')) })
    return { status: 'PREPARED', mode: contract.lock.mode, contractSha256: contract.lock.contract.sha256 }
  }
  if (command === 'scan') {
    const output = resolve(cwd, required(flags, 'output'))
    const configPath = resolve(cwd, required(flags, 'config'))
    if (output === configPath || output === lockFile) throw new Error('SCAN_OUTPUT_CONFLICT')
    await rm(output, { force: true })
    try {
      const config = parseStrictJson(await readFile(configPath))
      const contract = await loadContract(flags.lock ? lockFile : resolve(dirname(configPath), config.toolchainLock ?? 'permission-toolchain.lock.json'))
      const root = resolve(cwd, flags.root ?? dirname(configPath))
      if (contract.lock.mode === 'PINNED_COMMIT') {
        const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
        if (git(['rev-parse', 'HEAD']) !== config.artifact?.commit || git(['status', '--porcelain'])) throw new Error('IMMUTABLE_PRODUCER_CHECKOUT_REQUIRED')
      }
      const scan = await scanTypescript(config, { root, validate: contract.validate })
      const digests = manifestDigests(scan.manifest)
      await atomicJson(output, scan.manifest)
      const report = { status: 'SUCCEEDED', mode: contract.lock.mode, completeness: scan.manifest.producer.snapshotMode,
        contractSha256: contract.lock.contract.sha256, toolSourceDigest: contract.lock.sdk.sourceDigest,
        dependencyLockSha256: contract.lock.sdk.dependencyLockSha256, sourceDigest: scan.sourceDigest, sourceFiles: scan.sourceFiles,
        policyDigest: digests.policyDigest, metadataDigest: digests.metadataDigest, manifestDigest: digests.manifestDigest }
      await atomicJson(output + '.report.json', report)
      return report
    } catch (error) {
      await rm(output, { force: true })
      await atomicJson(output + '.report.json', { status: 'FAILED', completeness: 'UNCONFIRMED', code: error instanceof Error ? error.message.split(':')[0] : 'SCAN_FAILED' })
      throw error
    }
  }
  if (['sync', 'status', 'activate'].includes(command) || command === 'diff' && flags.target) {
    if (flags['dry-run'] !== undefined && !['true', 'false'].includes(flags['dry-run'])) throw new Error('DRY_RUN_ARGUMENT_INVALID')
    const dryRun = flags['dry-run'] === 'true'
    await verifyToolchain(lockFile, { online: !dryRun })
    const contract = await loadContract(lockFile)
    const profile = await loadTargetProfile(resolve(cwd, required(flags, 'target-file')), required(flags, 'target'))
    const environment = runtime.environment ?? process.env
    if (!dryRun && command !== 'status' && profile.target.environment !== 'test'
      && !(environment.CI === 'true' && (environment.GITHUB_ACTIONS === 'true' || environment.GITLAB_CI === 'true'))) {
      throw new Error('LOCAL_WRITE_TARGET_MUST_BE_TEST')
    }
    const output = resolve(cwd, required(flags, 'output'))
    let request
    let plan
    if (command === 'diff') {
      if (flags.baseline) throw new Error('DIFF_MODE_CONFLICT')
      const manifest = contract.validate(parseStrictJson(await readFile(resolve(cwd, required(flags, 'manifest')))))
      request = preparePlanRequest(manifest, required(flags, 'expected-producer-revision'), required(flags, 'expected-active-revision'), profile)
    } else if (command === 'sync') {
      plan = parseStrictJson(await readFile(resolve(cwd, required(flags, 'plan'))))
      request = registrationRequest(plan, required(flags, 'operation-id'), profile)
    }
    else if (command === 'activate') request = validateActivation(parseStrictJson(await readFile(resolve(cwd, required(flags, 'selection')))), profile)
    if (dryRun) {
      const result = {status: 'DRY_RUN', mode: contract.lock.mode, command, target: profile.target, producerId: profile.producerId,
        ...(request?.operationId ? {operationId: request.operationId} : {}), requestDigest: sha256(canonicalJson(request))}
      await atomicJson(output, result)
      return result
    }
    const client = createRegistrationClient(profile, runtime)
    try {
      if (command === 'diff') {
        const plan = await client.plan(request.manifest, request.expectedProducerRevision, request.expectedActiveRevision)
        await atomicJson(output, plan)
        return {status: 'PLANNED', planId: plan.planId, target: plan.target, producerId: plan.producerId, digests: plan.digests, authorizationExpansion: plan.diff.authorizationExpansion, conflicts: plan.diff.conflicts.length}
      }
      if (command === 'sync') {
        await atomicJson(output, {status: 'DISPATCHING', request})
        const result = await client.register(plan, request.operationId)
        await atomicJson(output, result)
        if (result.currentState !== 'READY') throw new PermissionToolFailure(result.currentState === 'FAILED' ? 'REGISTRATION_FAILED' : 'REGISTRATION_PENDING', result.currentState === 'FAILED' ? 5 : 6, {operationId: request.operationId, currentState: result.currentState, preserveOutput: true})
        return {status: 'READY', operationId: request.operationId, producerVersion: result.receipt.producerVersion}
      }
      if (command === 'activate') {
        await atomicJson(output, {status: 'DISPATCHING', request})
        const result = await client.activate(request)
        await atomicJson(output, result)
        return {status: 'ACTIVATED', operationId: request.operationId, activationVersion: result.activationVersion}
      }
      const operationId = required(flags, 'operation-id')
      const kind = flags.kind ?? 'registration'
      const seconds = flags['wait-seconds'] ?? '0'
      if (!/^\d{1,4}$/.test(seconds) || Number(seconds) > 3600) throw new Error('STATUS_WAIT_INVALID')
      return await waitForOperation(client, operationId, kind, {seconds: Number(seconds), now: runtime.now, sleep: runtime.sleep,
        onResult: result => atomicJson(output, result)})
    } catch (error) {
      if (error instanceof PermissionToolFailure && !error.details.preserveOutput) {
        await atomicJson(output, {status: error.exitCode === 6 ? 'UNKNOWN' : 'FAILED', code: error.message,
          ...(request ? {request} : {}), ...error.details})
      }
      throw error
    }
  }
  const contract = await loadContract(lockFile)
  if (command === 'verify') {
    if (flags.purpose && !['local-build', 'distribution'].includes(flags.purpose)) throw new Error('VERIFY_PURPOSE_INVALID')
    if (flags.purpose === 'distribution' && contract.lock.mode !== 'PINNED_COMMIT') throw new Error('LOCAL_UNCOMMITTED_DISTRIBUTION_FORBIDDEN')
    return { status: 'VERIFIED', mode: contract.lock.mode, contractSha256: contract.lock.contract.sha256 }
  }
  const manifest = contract.validate(parseStrictJson(await readFile(resolve(cwd, required(flags, 'manifest')))))
  if (command === 'validate') {
    const { canonical: _canonical, ...digests } = manifestDigests(manifest)
    return { status: 'VALID', mode: contract.lock.mode, ...digests }
  }
  const baseline = contract.validate(parseStrictJson(await readFile(resolve(cwd, required(flags, 'baseline')))))
  const diff = compareManifests(baseline, manifest)
  const result = { status: 'COMPARED_OFFLINE', mode: contract.lock.mode, resources: diff.resources, permissions: diff.permissions, messages: diff.messages,
    policyChanged: diff.before.policyDigest !== diff.after.policyDigest, metadataChanged: diff.before.metadataDigest !== diff.after.metadataDigest }
  await atomicJson(resolve(cwd, required(flags, 'output')), result)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    const code = error instanceof PermissionToolFailure ? error.message : /^[A-Z][A-Z0-9_]+/.exec(error?.message ?? '')?.[0] ?? 'PERMISSION_TOOL_INPUT_INVALID'
    process.stderr.write(JSON.stringify({status: error instanceof PermissionToolFailure && error.exitCode === 6 ? 'PENDING' : 'FAILED', code, ...(error instanceof PermissionToolFailure ? error.details : {})}) + '\n')
    process.exitCode = error instanceof PermissionToolFailure ? error.exitCode : 2
  })
}
