#!/usr/bin/env node
import {readFileSync, writeFileSync, mkdirSync, existsSync, cpSync} from 'node:fs'
import {resolve, isAbsolute, join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {realpathSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {toolRoot, verifyToolchain} from './permissions/prepare-contract.mjs'
import {main} from './permission-manifest.mjs'

export const KNOWN_CONSUMERS = ['tianshu-web', 'yuheng-web', 'yaoguang-web', 'tianquan-jianshen-web', 'tianquan-shoubing-web', 'tianji-web', 'portal']

export const aliases = new Map([
  ['@egon-cola/admin-web-shared', '@stellar-enclosure/stellar-enclosure-web-shared'],
  ['@egon-cola/xingyuan-admin-web-shared', '@stellar-enclosure/stellar-enclosure-web-shared'],
  ['@egon-cola/rbac3-react-sdk', '@stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk'],
  ['@egon-cola/tianquan-jianshen-react-sdk', '@stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk'],
])

export function parseVerifyArgs(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--workspace', '--cache', '--output', '--phase', '--consumer', '--online'].includes(key) || !value || args.has(key)) {
      throw new Error('Usage: verify-consumers.mjs --workspace ABS --cache ABS --output ABS [--phase prepare|verify]')
    }
    args.set(key, value)
  }
  for (const name of ['--workspace', '--cache', '--output']) {
    if (!isAbsolute(args.get(name) ?? '')) throw new Error(name + ' must be an absolute path')
  }
  const workspace = resolve(args.get('--workspace'))
  const cache = resolve(args.get('--cache'))
  const output = resolve(args.get('--output'))
  const phase = args.get('--phase') ?? 'verify'
  const online = args.get('--online') === 'true'
  if (!['prepare', 'verify'].includes(phase) || output === workspace || cache === workspace
    || output.includes('/.git/') || cache.includes('/.git/')) throw new Error('Unsafe parameters')
  const requested = args.get('--consumer')
  if (requested && !KNOWN_CONSUMERS.includes(requested)) throw new Error('Unknown consumer: ' + requested)
  return {workspace, cache, output, phase, online, requested}
}

export function reconcileConsumerLock({repo, pkg, lock, packages, phase}) {
  const committedLock = JSON.stringify(lock)
  lock.name = pkg.name
  lock.version = pkg.version
  lock.packages[''] = Object.fromEntries(Object.entries(pkg).filter(([key]) =>
    ['name', 'version', 'dependencies', 'devDependencies', 'optionalDependencies', 'engines'].includes(key)))
  for (const [key, value] of Object.entries(lock.packages)) {
    const relativeName = key.startsWith('node_modules/') ? key.slice('node_modules/'.length) : ''
    if (aliases.has(relativeName)) {
      delete lock.packages[key]
      if (!pkg.dependencies?.[aliases.get(relativeName)]) continue
    }
    if (value.link) delete lock.packages[key]
  }
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (!name.startsWith('@stellar-enclosure/')) continue
    const packed = packages.get(name)
    if (!packed || version !== packed.version) throw new Error('Unprepared SDK: ' + name + '@' + version)
    lock.packages['node_modules/' + name] = {
      version: packed.version, resolved: packed.resolved, integrity: packed.integrity,
      ...(packed.peerDependencies ? {peerDependencies: packed.peerDependencies} : {}),
      ...(packed.dependencies ? {dependencies: packed.dependencies} : {}),
    }
  }
  if (phase === 'verify' && JSON.stringify(lock) !== committedLock) {
    throw new Error('Committed lock differs from the actual SDK tarball: ' + repo + '; run --phase prepare explicitly')
  }
  return lock
}

async function runCli() {
const {workspace, cache, output, phase, online, requested} = parseVerifyArgs(process.argv.slice(2))
mkdirSync(output, {recursive: true})
mkdirSync(cache, {recursive: true})
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const run = (cwd, command, argv, capture = false) => {
  console.log('RUN ' + cwd.split('/').at(-1) + ': ' + command + ' ' + argv.join(' '))
  const result = spawnSync(command, argv, {
    cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: {...process.env, npm_config_cache: cache, npm_config_audit: 'false', npm_config_fund: 'false'},
  })
  if (result.status !== 0) throw new Error('FAILED ' + cwd + ' ' + command + '; exit=' + result.status)
  return result.stdout
}
const sdkRoot = join(workspace, 'web-sdk')
if (realpathSync(sdkRoot) !== realpathSync(toolRoot)) throw new Error('EXPLICIT_TOOL_CHECKOUT_REQUIRED')
if (!process.env.PAC_TOOLCHAIN_LOCK || !process.env.PAC_CONTRACT_ARTIFACT) throw new Error('PAC_TOOLCHAIN_LOCK_AND_CONTRACT_ARTIFACT_REQUIRED')
const toolchainLock = resolve(process.env.PAC_TOOLCHAIN_LOCK)
await verifyToolchain(toolchainLock)
await main(['prepare', '--lock', toolchainLock, '--artifact', resolve(process.env.PAC_CONTRACT_ARTIFACT)], sdkRoot)
process.env.PAC_SDK_DIR = sdkRoot
process.env.PAC_TOOLCHAIN_LOCK = toolchainLock
if (online) run(sdkRoot, 'npm', ['ci', '--ignore-scripts'])
run(sdkRoot, 'npm', ['ci', '--offline', '--ignore-scripts'])
run(sdkRoot, 'npm', ['run', 'build'])
const packages = new Map()
for (const directory of ['stellar-enclosure-web-shared', 'stellar-enclosure-tianquan-jianshen-react-sdk']) {
  const root = join(sdkRoot, 'packages', directory)
  for (const license of ['LICENSE-MIT', 'LICENSE-LGPL-2.1']) {
    if (!existsSync(join(root, license))) cpSync(join(sdkRoot, license), join(root, license))
  }
  const pkg = json(join(root, 'package.json'))
  if (pkg.name !== '@stellar-enclosure/' + directory || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version)) {
    throw new Error('Invalid SDK package identity or version: ' + directory)
  }
  const packed = JSON.parse(run(root, 'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], true))[0]
  if (!packed.integrity || packed.name !== pkg.name || packed.version !== pkg.version) throw new Error('Invalid pack metadata')
  run(sdkRoot, 'npm', ['cache', 'add', join(output, packed.filename)])
  const leaf = pkg.name.split('/')[1]
  packages.set(pkg.name, {
    name: pkg.name, version: pkg.version, filename: packed.filename, integrity: packed.integrity,
    shasum: packed.shasum, resolved: 'https://registry.npmjs.org/' + pkg.name + '/-/' + leaf + '-' + pkg.version + '.tgz',
    peerDependencies: pkg.peerDependencies, dependencies: pkg.dependencies, files: packed.files,
  })
}
const results = []
for (const repo of requested ? [requested] : KNOWN_CONSUMERS) {
  const root = join(workspace, repo)
  const pkg = json(join(root, 'package.json'))
  const lock = reconcileConsumerLock({repo, pkg, lock: json(join(root, 'package-lock.json')), packages, phase})
  if (phase === 'prepare') save(join(root, 'package-lock.json'), lock)
  if (online) run(root, 'npm', ['ci', '--ignore-scripts'])
  run(root, 'npm', ['ci', '--offline', '--ignore-scripts'])
  if (phase === 'verify') {
    run(root, 'npm', ['run', 'build'])
    run(root, 'npm', ['test', '--', '--run', '--testTimeout=15000'])
  }
  results.push({repository: repo, offlineInstall: 'PASS', buildAndTests: phase === 'verify' ? 'PASS' : 'NOT_RUN'})
}
if (phase === 'verify') run(sdkRoot, 'npm', ['test'])
const shared = packages.get('@stellar-enclosure/stellar-enclosure-web-shared')
const manifest = {version: shared.version, npmScope: '@stellar-enclosure', packages: [...packages.values()], consumers: results,
  registryColdInstall: 'PENDING_USER_PUBLICATION'}
mkdirSync(join(sdkRoot, 'release'), {recursive: true})
if (phase === 'prepare') save(join(sdkRoot, 'release', 'npm-manifest.json'), manifest)
save(join(output, 'npm-manifest.json'), manifest)
console.log('PASS: ' + phase + '; no registry publication was performed')
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  await runCli()
}
