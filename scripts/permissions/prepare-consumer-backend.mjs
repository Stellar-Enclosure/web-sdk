import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { main } from '../permission-manifest.mjs'
import { parseStrictJson } from './validate-manifest.mjs'

/** Prepare only the optional, explicitly pinned backend used by this consumer. */
export const prepareConsumerBackend = async ({root = process.cwd(), env = process.env, prepared = false, config} = {}) => {
  config ??= parseStrictJson(await readFile(resolve(root, 'permission-manifest.config.json')))
  if (!config.backendReferences) return null
  const output = resolve(root, '.generated/permissions/backend-references.ts')
  if ([env.PAC_BACKEND_MANIFEST, env.PAC_TOOLCHAIN_LOCK, env.PAC_CONTRACT_ARTIFACT]
    .some(path => path && resolve(root, path) === output)) throw new Error('BACKEND_REFERENCE_OUTPUT_CONFLICT')
  await rm(output, {force: true})
  const pin = config.backendReferences
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)
    || Object.keys(pin).sort().join(',') !== 'manifestDigest,producerId'
    || !/^[a-f0-9]{64}$/.test(pin.manifestDigest ?? '') || typeof pin.producerId !== 'string') {
    throw new Error('BACKEND_REFERENCE_CONFIGURATION_INVALID')
  }
  if (!env.PAC_BACKEND_MANIFEST || !env.PAC_TOOLCHAIN_LOCK || (!prepared && !env.PAC_CONTRACT_ARTIFACT)) {
    throw new Error('PAC_BACKEND_MANIFEST_AND_TOOLCHAIN_REQUIRED')
  }
  const lock = resolve(root, env.PAC_TOOLCHAIN_LOCK)
  if (!prepared) await main(['prepare', '--lock', lock, '--artifact', resolve(root, env.PAC_CONTRACT_ARTIFACT)], root)
  return main(['backend-references', '--lock', lock, '--manifest', resolve(root, env.PAC_BACKEND_MANIFEST),
    '--manifest-digest', pin.manifestDigest, '--producer-id', pin.producerId,
    '--business-code', config.application.businessCode, '--application-code', config.application.applicationCode,
    '--output', output], root)
}
