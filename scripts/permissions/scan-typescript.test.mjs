import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scanTypescript } from './scan-typescript.mjs'
import { fixture, declarations, contract, lockFile } from './test-support.mjs'
import { main } from '../permission-manifest.mjs'

test('const/import aliases, static members and arrays are parsed without loading application modules', async context => {
  const source = declarations.replace("['order:read']", '[codes.read]').replace("codes:['order:read']", 'codes:[codes.read]')
  const { root, config } = await fixture(context, { 'constants.ts': "export const codes = {read:'order:read'} as const", 'resources.ts': "import { codes } from './constants'\n" + source })
  const result = await scanTypescript(config, { root, validate: contract.validate })
  assert.equal(result.manifest.producer.snapshotMode, 'FULL')
  assert.equal(result.manifest.resources[0].key, 'order.page.list')
  assert.equal(Object.keys(result.sourceFiles).length, 2)
  assert.match(result.sourceDigest, /^[a-f0-9]{64}$/)
})

test('dynamic expressions, missing imports, side effects and spoofed markers fail without execution', async context => {
  const { root, config } = await fixture(context)
  globalThis.permissionScannerExecuted = false
  const sources = [
    declarations.replace("codes:['order:read']", "codes:['order:' + 'read']"),
    "import { missing } from './missing'\n" + declarations,
    "import type { Missing } from './missing'\n" + declarations,
    'globalThis.permissionScannerExecuted = true\n' + declarations,
    declarations + '\nconst dynamic = fetch("https://example.invalid")',
    "function defineResources(value) { globalThis.permissionScannerExecuted = true; return value }\nexport const resources=defineResources([])",
    declarations.replace("key:'order.page.list'", "key:Math.random()"),
  ]
  for (const source of sources) {
    await writeFile(join(root, 'src/resources.ts'), source)
    await assert.rejects(scanTypescript(config, { root, validate: contract.validate }))
  }
  assert.equal(globalThis.permissionScannerExecuted, false)
  delete globalThis.permissionScannerExecuted
})

test('missing expected modules and empty declaration output fail instead of producing FULL', async context => {
  const { root, config } = await fixture(context, { 'resources.ts': declarations })
  config.expectedModules.push('missing')
  await assert.rejects(scanTypescript(config, { root, validate: contract.validate }), /EXPECTED_MODULE/)
  config.snapshotMode = 'PARTIAL'
  assert.equal((await scanTypescript(config, { root, validate: contract.validate })).manifest.producer.snapshotMode, 'PARTIAL')
  config.expectedModules = ['main']; config.snapshotMode = 'FULL'
  await writeFile(join(root, 'src/resources.ts'), "import { defineResources } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'\nexport const resources=defineResources([])")
  await assert.rejects(scanTypescript(config, { root, validate: contract.validate }), /EMPTY_FULL/)
})

test('CLI writes a local evidence report, invalidates stale output on failure and forbids online use', async context => {
  const { root, config } = await fixture(context, { 'resources.ts': declarations })
  await writeFile(join(root, 'permission-manifest.config.json'), JSON.stringify(config))
  const args = ['scan', '--config', 'permission-manifest.config.json', '--output', 'dist/manifest.json', '--lock', lockFile]
  const result = await main(args, root)
  assert.equal(result.status, 'SUCCEEDED'); assert.equal(result.mode, 'LOCAL_UNCOMMITTED')
  assert.equal((await main(['validate', '--manifest', 'dist/manifest.json', '--lock', lockFile], root)).status, 'VALID')
  await assert.rejects(main(['diff', '--manifest', 'dist/manifest.json', '--target', 'production', '--output', 'diff.json', '--lock', lockFile], root), /LOCAL_UNCOMMITTED/)
  await writeFile(join(root, 'src/resources.ts'), declarations + '\nconst unresolved = runtime()')
  await assert.rejects(main(args, root), /DYNAMIC/)
  await assert.rejects(readFile(join(root, 'dist/manifest.json')), /ENOENT/)
  assert.equal(JSON.parse(await readFile(join(root, 'dist/manifest.json.report.json'), 'utf8')).completeness, 'UNCONFIRMED')
})
