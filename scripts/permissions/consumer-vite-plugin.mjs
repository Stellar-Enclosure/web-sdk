import { readFileSync } from 'node:fs'
import { parseStrictJson } from './validate-manifest.mjs'
import { canonicalJson, sha256 } from './canonicalize.mjs'

/** The launcher supplies this invocation's digest; direct Vite builds cannot reuse an old manifest. */
export const permissionBuildPlugin = () => {
  let evidence
  return {
    name: 'permission-build-evidence',
    apply: 'build',
    configResolved() {
      const path = process.env.PAC_BUILD_EVIDENCE_FILE
      const expected = process.env.PAC_BUILD_EVIDENCE_DIGEST
      if (!path || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('PERMISSION_BUILD_LAUNCHER_REQUIRED')
      evidence = parseStrictJson(readFileSync(path))
      const { buildEvidenceDigest, ...body } = evidence
      if (buildEvidenceDigest !== expected || sha256(canonicalJson(body)) !== expected) throw new Error('PERMISSION_BUILD_EVIDENCE_CHANGED')
    },
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { name: 'permission-build', content: evidence.buildEvidenceDigest }, injectTo: 'head' }]
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'permission-build.json', source: canonicalJson(evidence) + '\n' })
    },
  }
}
