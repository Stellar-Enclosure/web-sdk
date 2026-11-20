import test from 'node:test'
import assert from 'node:assert/strict'
import { KNOWN_CONSUMERS, parseVerifyArgs, reconcileConsumerLock } from '../verify-consumers.mjs'

const packedPackages = new Map([
  [
    '@stellar-enclosure/stellar-enclosure-web-shared',
    {
      name: '@stellar-enclosure/stellar-enclosure-web-shared',
      version: '0.1.1',
      integrity: 'sha512-sharedValidIntegrity==',
      resolved:
        'https://registry.npmjs.org/@stellar-enclosure/stellar-enclosure-web-shared/-/stellar-enclosure-web-shared-0.1.1.tgz',
      peerDependencies: { react: '^19.2.8' },
    },
  ],
  [
    '@stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk',
    {
      name: '@stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk',
      version: '0.1.1',
      integrity: 'sha512-jianshenValidIntegrity==',
      resolved:
        'https://registry.npmjs.org/@stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk/-/stellar-enclosure-tianquan-jianshen-react-sdk-0.1.1.tgz',
      dependencies: {
        '@stellar-enclosure/stellar-enclosure-web-shared': '0.1.1',
      },
    },
  ],
])

test('verify-consumers accepts tianji-web as a known consumer and rejects unknown consumers', () => {
  assert.ok(KNOWN_CONSUMERS.includes('tianji-web'))
  assert.equal(KNOWN_CONSUMERS.length, 7)

  const parsed = parseVerifyArgs([
    '--workspace',
    '/tmp/ws',
    '--cache',
    '/tmp/cache',
    '--output',
    '/tmp/out',
    '--consumer',
    'tianji-web',
    '--phase',
    'verify',
  ])
  assert.equal(parsed.requested, 'tianji-web')
  assert.equal(parsed.phase, 'verify')

  assert.throws(
    () =>
      parseVerifyArgs([
        '--workspace',
        '/tmp/ws',
        '--cache',
        '/tmp/cache',
        '--output',
        '/tmp/out',
        '--consumer',
        'unknown-web',
      ]),
    /Unknown consumer: unknown-web/,
  )
})

test('reconcileConsumerLock rejects version mismatch and tampered integrity in verify mode', () => {
  const pkg = {
    name: '@stellar-enclosure/stellar-enclosure-tianji-web',
    version: '0.0.1',
    dependencies: {
      '@stellar-enclosure/stellar-enclosure-web-shared': '0.1.1',
      '@stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk': '0.1.1',
    },
  }
  const baseLock = {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    packages: {
      '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
    },
  }

  const prepared = reconcileConsumerLock({
    repo: 'tianji-web',
    pkg,
    lock: structuredClone(baseLock),
    packages: packedPackages,
    phase: 'prepare',
  })
  assert.equal(
    prepared.packages['node_modules/@stellar-enclosure/stellar-enclosure-web-shared'].integrity,
    'sha512-sharedValidIntegrity==',
  )

  // Matching lock passes verify
  assert.doesNotThrow(() =>
    reconcileConsumerLock({
      repo: 'tianji-web',
      pkg,
      lock: structuredClone(prepared),
      packages: packedPackages,
      phase: 'verify',
    }),
  )

  // Tampered integrity fails verify
  const tampered = structuredClone(prepared)
  tampered.packages['node_modules/@stellar-enclosure/stellar-enclosure-web-shared'].integrity =
    'sha512-tamperedIntegrity=='
  assert.throws(
    () =>
      reconcileConsumerLock({
        repo: 'tianji-web',
        pkg,
        lock: tampered,
        packages: packedPackages,
        phase: 'verify',
      }),
    /Committed lock differs from the actual SDK tarball: tianji-web/,
  )

  // Mismatched SDK version fails
  assert.throws(
    () =>
      reconcileConsumerLock({
        repo: 'tianji-web',
        pkg: {
          ...pkg,
          dependencies: {
            '@stellar-enclosure/stellar-enclosure-web-shared': '0.1.0',
          },
        },
        lock: structuredClone(prepared),
        packages: packedPackages,
        phase: 'verify',
      }),
    /Unprepared SDK: @stellar-enclosure\/stellar-enclosure-web-shared@0\.1\.0/,
  )
})
