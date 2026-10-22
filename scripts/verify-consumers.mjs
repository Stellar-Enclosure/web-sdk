#!/usr/bin/env node
import {readFileSync, writeFileSync, mkdirSync, existsSync, cpSync} from 'node:fs'
import {resolve, isAbsolute, join} from 'node:path'
import {spawnSync} from 'node:child_process'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
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
  if (!pkg.name.startsWith('@stellar-enclosure/') || pkg.version !== '0.0.1') throw new Error('Invalid SDK identity')
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
const aliases = new Map([
  ['@egon-cola/admin-web-shared', '@stellar-enclosure/stellar-enclosure-web-shared'],
  ['@egon-cola/xingyuan-admin-web-shared', '@stellar-enclosure/stellar-enclosure-web-shared'],
  ['@egon-cola/rbac3-react-sdk', '@stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk'],
  ['@egon-cola/tianquan-jianshen-react-sdk', '@stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk'],
])
const consumers = ['tianshu-web', 'yuheng-web', 'yaoguang-web', 'tianquan-jianshen-web', 'tianquan-shoubing-web', 'portal']
const requested = args.get('--consumer')
if (requested && !consumers.includes(requested)) throw new Error('Unknown consumer: ' + requested)
const results = []
for (const repo of requested ? [requested] : consumers) {
  const root = join(workspace, repo)
  const pkg = json(join(root, 'package.json'))
  const lock = json(join(root, 'package-lock.json'))
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
    if (!packed || version !== '0.0.1') throw new Error('Unprepared SDK: ' + name)
    lock.packages['node_modules/' + name] = {
      version: packed.version, resolved: packed.resolved, integrity: packed.integrity,
      ...(packed.peerDependencies ? {peerDependencies: packed.peerDependencies} : {}),
      ...(packed.dependencies ? {dependencies: packed.dependencies} : {}),
    }
  }
  if (phase === 'verify' && JSON.stringify(lock) !== committedLock) {
    throw new Error('Committed lock differs from the actual SDK tarball: ' + repo + '; run --phase prepare explicitly')
  }
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
const manifest = {version: '0.0.1', npmScope: '@stellar-enclosure', packages: [...packages.values()], consumers: results,
  registryColdInstall: 'PENDING_USER_PUBLICATION'}
mkdirSync(join(sdkRoot, 'release'), {recursive: true})
if (phase === 'prepare') save(join(sdkRoot, 'release', 'npm-manifest.json'), manifest)
save(join(output, 'npm-manifest.json'), manifest)
console.log('PASS: ' + phase + '; no registry publication was performed')
