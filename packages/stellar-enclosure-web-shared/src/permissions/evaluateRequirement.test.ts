// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { evaluateRequirement, isPermissionRequirement } from './evaluateRequirement'

const fixtures = JSON.parse(readFileSync(new URL('../../../../.generated/permission-contract/requirements-v1.json', import.meta.url), 'utf8')) as {
  name: string; requirement: unknown; effective: string[]; allow: boolean
}[]

describe('RC JAR Java/TypeScript requirement truth contract', () => {
  it.each(fixtures)('$name', fixture => {
    expect(evaluateRequirement(fixture.requirement, new Set(fixture.effective))).toBe(fixture.allow)
  })
  it('denies empty, unknown, nested and case-colliding rules', () => {
    for (const rule of [undefined, {}, { mode: 'ALL', codes: [] }, { mode: 'UNKNOWN', codes: ['read'] },
      { mode: 'ANY', codes: ['read', 'READ'] }, { allOf: [] }, { allOf: [{ allOf: [{ access: 'PUBLIC' }] }] },
      { access: 'PUBLIC', codes: ['read'] }, { access: 'INTERNAL' }]) {
      expect(isPermissionRequirement(rule)).toBe(false)
      expect(evaluateRequirement(rule, new Set(['read']))).toBe(false)
    }
  })
})
