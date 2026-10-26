import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJdk25Locale, isCanonicalJdk25Locale } from './jdk25-locale.mjs'
import { contract } from './test-support.mjs'

for (const sample of contract.locales.cases) {
  test('RC/JDK25 locale: ' + sample.input, () => {
    assert.equal(canonicalJdk25Locale(sample.input), sample.canonical)
    assert.equal(isCanonicalJdk25Locale(sample.input), sample.valid)
  })
}

test('manifest locales follow the JDK contract without ICU preferred-alias folding', () => {
  const manifest = structuredClone(contract.manifest)
  const message = manifest.messages[0]
  message.defaultLocale = 'en-SU'
  message.defaults = { 'en-SU': 'Source text', 'en-US-POSIX': 'Source text' }
  assert.doesNotThrow(() => contract.validate(manifest))
  message.defaultLocale = 'iw-IL'; message.defaults = { 'iw-IL': 'Source text' }
  assert.throws(() => contract.validate(manifest), /LOCALE/)
})

test('Java whitespace rules preserve nonbreaking source text', () => {
  const manifest = structuredClone(contract.manifest)
  manifest.messages[0].defaults = { 'zh-CN': '\u00a0' }
  manifest.permissionDefinitions[0].meaning = '\u00a0'
  assert.doesNotThrow(() => contract.validate(manifest))
})
