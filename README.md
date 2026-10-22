# web-sdk

Shared React UI, browser authentication and authorization SDKs for the Stellar Enclosure portal and five platform consoles. All first-party modules start at **0.0.1**.

## Packages and capabilities

| Public package | Function | Source and usage |
|---|---|---|
| `@stellar-enclosure/stellar-enclosure-web-shared` | Theme tokens, enterprise header/footer/layout, page/loading/error components, typed HTTP/error handling, Edge BFF session/CSRF/logout client, i18n and shared hooks. Its `/vite-plugin` export supplies the favicon plugin. | [Package README](packages/stellar-enclosure-web-shared/README.md), [public exports](packages/stellar-enclosure-web-shared/src/index.ts) |
| `@stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk` | Typed RBAC3 client/provider/state machine; role candidates and activation; permission, action and field guards; frontend resource/component registries and default-route selection. | [Package README](packages/stellar-enclosure-tianquan-jianshen-react-sdk/README.md), [public exports](packages/stellar-enclosure-tianquan-jianshen-react-sdk/src/index.ts) |

The shared package is consumed by `portal`, `tianshu-web`, `yuheng-web`, `yaoguang-web`, `tianquan-jianshen-web` and `tianquan-shoubing-web`; the Jianshen console also consumes the RBAC3 SDK. Shared UI renders navigation supplied by the application; Jianshen-specific authorization belongs to the RBAC3 SDK. Browser guards support UI behavior while server-side authorization remains authoritative.

The workspace owns SDK builds, tests, package checks and [consumer verification](scripts/verify-consumers.mjs). It contains no platform backend or executable console. The root is private; only the two packages below are publication units.

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
node scripts/verify-consumers.mjs \
  --workspace "$(cd .. && pwd)" \
  --cache "$HOME/.npm" \
  --output "$(pwd)/dist/npm-release" \
  --phase verify --online true
```

The consumer verifier checks the initial SDK tarballs against the application locks. After changing a package's publishable contents before its first release, run it with `--phase prepare` to refresh those locks, then `--phase verify` to check all six consumers.

## Publish to npmjs

Only these two packages are public. The workspace root and all frontend applications remain `private: true`. Each package pins `https://registry.npmjs.org/` and public access in `publishConfig`. Publishing runs its tests through `prepublishOnly`, and packing rebuilds `dist/` through `prepack`.

Run from this repository with Node 24/npm 11 and npm organization access to `@stellar-enclosure`:

```bash
npm ci

# Test both packages, build them and inspect the publication file lists.
npm run release:check

# Rehearse each independent publication without uploading.
npm run release:shared -- --dry-run
npm run release:jianshen -- --dry-run

# Authenticate locally, then publish only the intended package.
npm login --registry https://registry.npmjs.org/
npm run release:shared
npm run release:jianshen
```

`npm login` may require browser authentication; perform it yourself in your local publishing session. For subsequent releases, choose each package's version explicitly and commit the updated workspace lock:

```bash
npm version patch --workspace @stellar-enclosure/stellar-enclosure-web-shared --no-git-tag-version
# Or version the React SDK independently:
npm version patch --workspace @stellar-enclosure/stellar-enclosure-tianquan-jianshen-react-sdk --no-git-tag-version
```

Do not repeat a published name/version. Update the applications' SDK versions and locks when adopting a new release. Git pushes do not publish; no credentials belong in this repository.

When releasing the exact tarballs already checked by the consumer verifier, use the files and integrity values in its output `npm-manifest.json`:

```bash
npm publish dist/npm-release/stellar-enclosure-stellar-enclosure-web-shared-0.0.1.tgz --access public --registry https://registry.npmjs.org/
npm publish dist/npm-release/stellar-enclosure-stellar-enclosure-tianquan-jianshen-react-sdk-0.0.1.tgz --access public --registry https://registry.npmjs.org/
```

## Compatibility and publication

Java packages/classes, Bean names, configuration keys, OAuth/RPC identities, APIs, and database ownership are retained. Existing SQL and DDL history are copied byte for byte. Artifact/build versions and necessary build paths change. A successful build does not imply application startup or live infrastructure acceptance.

Git pushes run validation only. Central and npm publication are separate user actions. CI defaults to initial source bootstrap; after publication set `STELLAR_USE_SOURCE_BOOTSTRAP=false` to consume published artifacts directly. Private organizations may supply the Actions secret `STELLAR_ENCLOSURE_READ_TOKEN` with repository read access.

Original MIT/LGPL licenses and author attribution are preserved.
