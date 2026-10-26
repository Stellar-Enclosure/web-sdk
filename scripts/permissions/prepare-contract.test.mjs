import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyToolchain, loadContract } from './prepare-contract.mjs'
import { fixture, contract, lockFile } from './test-support.mjs'
import { main } from '../permission-manifest.mjs'

test('fixed artifact/schema/fixture hashes verify and local tools cannot distribute or register', async () => {
  assert.equal((await loadContract(lockFile)).lock.contract.sha256, contract.lock.contract.sha256)
  await assert.rejects(verifyToolchain(lockFile, { online: true }), /LOCAL_UNCOMMITTED/)
  await assert.rejects(main(['verify', '--lock', lockFile, '--purpose', 'distribution']), /DISTRIBUTION_FORBIDDEN/)
  await assert.rejects(main(['sync', '--lock', lockFile]), /LOCAL_UNCOMMITTED_ONLINE_FORBIDDEN/)
})

test('source, dependency and extracted contract tampering fails closed', async context => {
  const { root } = await fixture(context)
  const original = JSON.parse(await readFile(lockFile, 'utf8'))
  const temporary = join(root, 'toolchain.json')
  for (const field of ['sourceDigest', 'dependencyLockSha256']) {
    const modified = structuredClone(original); modified.sdk[field] = '0'.repeat(64)
    await writeFile(temporary, JSON.stringify(modified))
    await assert.rejects(verifyToolchain(temporary), /DIGEST_MISMATCH/)
  }
  const directory = join(root, 'contract'); await mkdir(directory)
  await cp(contract.directory, directory, { recursive: true })
  const modified = structuredClone(original); modified.contractDirectory = 'contract'
  await writeFile(temporary, JSON.stringify(modified))
  await writeFile(join(directory, 'manifest-v1.json'), '{}')
  await assert.rejects(loadContract(temporary), /CONTRACT_DIGEST_MISMATCH/)
})
