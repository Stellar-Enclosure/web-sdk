import type { PermissionGroup, PermissionRequirement } from './definitions'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))

const group = (value: unknown): value is PermissionGroup => {
  if (!object(value)) return false
  if (keys(value, ['access'])) return value.access === 'PUBLIC'
  if (!keys(value, ['mode', 'codes']) || (value.mode !== 'ALL' && value.mode !== 'ANY') || !Array.isArray(value.codes)
    || value.codes.length === 0 || value.codes.length > 64) return false
  const seen = new Set<string>()
  return value.codes.every((code: unknown) => {
    if (typeof code !== 'string' || code.length > 128 || !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(code) || seen.has(code.toLowerCase())) return false
    seen.add(code.toLowerCase())
    return true
  })
}

export const isPermissionRequirement = (value: unknown): value is PermissionRequirement => {
  if (group(value)) return true
  return object(value) && keys(value, ['allOf']) && Array.isArray(value.allOf)
    && value.allOf.length > 0 && value.allOf.length <= 32 && value.allOf.every(group)
}

/** Missing, empty, malformed or unknown rules deny. PUBLIC must be explicit. */
export const evaluateRequirement = (requirement: unknown, effectiveCodes: ReadonlySet<string>): boolean => {
  if (!isPermissionRequirement(requirement) || !(effectiveCodes instanceof Set)) return false
  const evaluate = (item: PermissionGroup): boolean => 'access' in item ? true
    : item.mode === 'ALL' ? item.codes.every(code => effectiveCodes.has(code)) : item.codes.some(code => effectiveCodes.has(code))
  return 'allOf' in requirement ? requirement.allOf.every(evaluate) : evaluate(requirement)
}
