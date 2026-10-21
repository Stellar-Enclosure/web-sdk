# web-sdk

Stellar Enclosure frontend. All first-party modules start at **0.0.1**.

Migrated from [52e407ee3be8](https://github.com/AllenDEricDAlexander/Egon-COLA/tree/52e407ee3be892200aafadb19ad912189f5ada1c). Maven namespace: `top.egon`; npm organization: `@stellar-enclosure`.

## Build and test

Requires Node 24 and npm 11. After the SDKs are published:

```bash
npm ci
npm run build
npm test -- --run
```

The root npm workspace contains `packages/stellar-enclosure-web-shared` and `packages/stellar-enclosure-tianquan-jianshen-react-sdk`. Public package names are `@stellar-enclosure/stellar-enclosure-web-shared` and `@stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk`.

For all six colocated consumers:

```bash
node scripts/verify-migration-consumers.mjs \
  --workspace "$(cd .. && pwd)" \
  --cache "$(cd .. && pwd)/.migration/npm-cache" \
  --output "$(cd .. && pwd)/.migration/npm-release" \
  --phase verify --online true
```

Publish the exact verified tarballs from `.migration/npm-release` with `npm publish <tarball> --access public`. The root workspace and all applications remain private. `release/npm-manifest.json` records actual integrity values. Publication is a separate user action.

## Compatibility and publication

Java packages/classes, Bean names, configuration keys, OAuth/RPC identities, APIs, and database ownership are retained. Existing SQL and DDL history are copied byte for byte. Artifact/build versions and necessary build paths change. A successful build does not imply application startup or live infrastructure acceptance.

Git pushes run validation only. Central and npm publication are separate user actions. CI defaults to initial source bootstrap; after publication set `STELLAR_USE_SOURCE_BOOTSTRAP=false` to consume published artifacts directly. Private organizations may supply the Actions secret `STELLAR_ENCLOSURE_READ_TOKEN` with repository read access.

Original MIT/LGPL licenses and author attribution are preserved.
