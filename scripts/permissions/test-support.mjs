import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadContract, toolRoot } from './prepare-contract.mjs'

export const lockFile = join(toolRoot, 'permission-toolchain.local.lock.json')
export const contract = await loadContract(lockFile)
export const fixture = async (context, files = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'stellar-permission-scan-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'))
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, 'src', name), text)
  const config = { schemaVersion: 1, application: { businessCode: 'trade', applicationCode: 'order' }, producerId: 'order-web',
    ownedKeyPrefixes: ['order.'], expectedModules: ['main'], modules: { main: { entryPoints: ['src/resources.ts'] } },
    artifact: { repository: 'fixture-only', commit: 'a'.repeat(40), buildId: 'test', version: '0.0.1' } }
  return { root, config }
}
export const declarations = `
import { defineResources, definePermissionReferences, defineMessages } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
export const references = definePermissionReferences(['order:read'] as const)
export const resources = defineResources([{key:'order.page.list',type:'PAGE',target:{route:'/orders'},
 requirement:{mode:'ALL',codes:['order:read']},i18n:{pageCode:'order.list',labelKey:'title'}}] as const)
export const messages = defineMessages([{pageCode:'order.list',key:'title',defaultLocale:'zh-CN',defaults:{'zh-CN':'订单列表','en-US':'Orders'}}] as const)
`
