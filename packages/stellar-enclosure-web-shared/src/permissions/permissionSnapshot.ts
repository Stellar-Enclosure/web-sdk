import { evaluateRequirement, isPermissionRequirement } from './evaluateRequirement'
import type { PermissionRequirement } from './definitions'

export interface CatalogScope {
  readonly catalogScopeId: string
  readonly tenantId: string
  readonly businessCode: string
  readonly applicationCode: string
  readonly namespaceCode: string
  readonly environment: string
}
export interface ActiveRoleContext {
  readonly applicationCode: string
  readonly rootRoleIds: readonly string[]
  readonly effectiveRoleIds: readonly string[]
}
export interface PermissionSnapshotBinding {
  readonly issuer: string
  readonly subject: string
  readonly catalogScope: CatalogScope
  readonly catalogVersion: string
  readonly authVersion: string
  readonly policyVersion: string
  readonly activeRoleContext: ActiveRoleContext
}
export interface PermissionSnapshotContext extends PermissionSnapshotBinding {
  readonly requestEpoch: number
}
export interface PermissionSnapshot extends PermissionSnapshotBinding {
  readonly permissionCodes: readonly string[]
  readonly snapshotExpiresAt: string
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const decimal = (value: unknown, positive = false): value is string => typeof value === 'string'
  && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n && (!positive || value !== '0')
const identifier = (value: unknown, limit = 128): value is string => typeof value === 'string' && value.length <= limit && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value)
const ids = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length <= 10_000
  && value.every(item => decimal(item, true)) && new Set(value).size === value.length
const issuer = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const uri = new URL(value)
    return uri.protocol === 'https:' && !uri.username && !uri.password && !uri.search && !uri.hash && uri.href === value
  } catch { return false }
}
export const isCatalogScope = (value: unknown): value is CatalogScope => record(value)
  && decimal(value.catalogScopeId, true) && decimal(value.tenantId, true) && identifier(value.businessCode)
  && identifier(value.applicationCode) && identifier(value.namespaceCode) && identifier(value.environment, 32)

export const isPermissionSnapshotBinding = (value: unknown): value is PermissionSnapshotBinding => record(value)
  && issuer(value.issuer) && typeof value.subject === 'string' && value.subject.length > 0 && value.subject.length <= 256
  && value.subject.trim() === value.subject && isCatalogScope(value.catalogScope)
  && decimal(value.catalogVersion, true) && decimal(value.authVersion) && decimal(value.policyVersion)
  && record(value.activeRoleContext) && value.activeRoleContext.applicationCode === value.catalogScope.applicationCode
  && ids(value.activeRoleContext.rootRoleIds) && ids(value.activeRoleContext.effectiveRoleIds)

export const isPermissionSnapshotContext = (value: unknown): value is PermissionSnapshotContext =>
  isPermissionSnapshotBinding(value) && record(value) && typeof value.requestEpoch === 'number' && Number.isSafeInteger(value.requestEpoch) && value.requestEpoch >= 0

export const snapshotContext = (snapshot: PermissionSnapshot, requestEpoch: number): PermissionSnapshotContext => {
  if (!isPermissionSnapshot(snapshot) || !Number.isSafeInteger(requestEpoch) || requestEpoch < 0) throw new TypeError('Permission snapshot context is invalid')
  return Object.freeze({ ...copyPermissionBinding(snapshot), requestEpoch })
}

export const snapshotExpiry = (value: unknown): number => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return NaN
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : NaN
}

export const catalogScopeKey = (scope: CatalogScope): string => JSON.stringify([
  scope.catalogScopeId, scope.tenantId, scope.businessCode, scope.applicationCode, scope.namespaceCode, scope.environment,
])
export const permissionBindingKey = (binding: PermissionSnapshotBinding): string => {
  if (!isPermissionSnapshotBinding(binding)) throw new TypeError('Permission snapshot binding is invalid')
  return JSON.stringify([binding.issuer, binding.subject, catalogScopeKey(binding.catalogScope), binding.catalogVersion,
    binding.authVersion, binding.policyVersion, binding.activeRoleContext.applicationCode,
    [...binding.activeRoleContext.rootRoleIds].sort(), [...binding.activeRoleContext.effectiveRoleIds].sort()])
}

export const permissionContextKey = (context: PermissionSnapshotContext): string => {
  if (!isPermissionSnapshotContext(context)) throw new TypeError('Permission request context is invalid')
  return JSON.stringify([permissionBindingKey(context), context.requestEpoch])
}

export const isPermissionSnapshot = (value: unknown): value is PermissionSnapshot => {
  if (!isPermissionSnapshotBinding(value) || !record(value) || !Array.isArray(value.permissionCodes)
    || value.permissionCodes.length > 10_000 || !Number.isFinite(snapshotExpiry(value.snapshotExpiresAt))) return false
  return value.permissionCodes.every(item => identifier(item))
    && new Set(value.permissionCodes.map(item => item.toLowerCase())).size === value.permissionCodes.length
}

/** The snapshot is a short-lived UI view, never an API proof or a source of client-selected identity. */
export const isSnapshotCurrent = (snapshot: unknown, binding: unknown, now = Date.now()): snapshot is PermissionSnapshot =>
  isPermissionSnapshot(snapshot) && isPermissionSnapshotBinding(binding)
  && snapshotExpiry(snapshot.snapshotExpiresAt) > now && permissionBindingKey(snapshot) === permissionBindingKey(binding)

export const copyPermissionBinding = (binding: PermissionSnapshotBinding): PermissionSnapshotBinding => {
  if (!isPermissionSnapshotBinding(binding)) throw new TypeError('Permission snapshot binding is invalid')
  return Object.freeze({ issuer: binding.issuer, subject: binding.subject, catalogScope: Object.freeze({ ...binding.catalogScope }),
    catalogVersion: binding.catalogVersion, authVersion: binding.authVersion, policyVersion: binding.policyVersion,
    activeRoleContext: Object.freeze({ applicationCode: binding.activeRoleContext.applicationCode,
      rootRoleIds: Object.freeze([...binding.activeRoleContext.rootRoleIds].sort()), effectiveRoleIds: Object.freeze([...binding.activeRoleContext.effectiveRoleIds].sort()) }) })
}
export const copyPermissionSnapshot = (snapshot: PermissionSnapshot): PermissionSnapshot => {
  if (!isPermissionSnapshot(snapshot)) throw new TypeError('Permission snapshot is invalid')
  return Object.freeze({ ...copyPermissionBinding(snapshot), permissionCodes: Object.freeze([...snapshot.permissionCodes].sort()), snapshotExpiresAt: snapshot.snapshotExpiresAt })
}

export const allowsSnapshotRequirement = (snapshot: PermissionSnapshot | null, binding: PermissionSnapshotBinding | null,
  requirement: unknown, now = Date.now()): boolean => isSnapshotCurrent(snapshot, binding, now)
    && evaluateRequirement(requirement, new Set(snapshot.permissionCodes))

export interface BackendFieldPolicy {
  readonly valueType: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'OBJECT' | 'ARRAY'
  readonly plainRead?: PermissionRequirement | null
  readonly maskedRead?: PermissionRequirement | null
  readonly write?: PermissionRequirement | null
  readonly masker?: 'FIXED' | 'EMAIL' | 'PHONE' | 'BANK_ACCOUNT' | null
}
export interface BackendFieldProjection {
  readonly access: 'PROTECTED' | 'PUBLIC' | 'INTERNAL'
  readonly fieldPolicy?: BackendFieldPolicy | null
  /** True only when the backend confirms a real input binding that is not readOnly. */
  readonly inputBinding?: boolean | null
}
export interface BackendFieldCatalog {
  readonly catalogScope: CatalogScope
  readonly catalogVersion: string
  readonly fields: Readonly<Record<string, BackendFieldProjection>>
}
export interface FieldAccessState { readonly read: 'PLAIN' | 'MASKED' | 'OMITTED'; readonly writable: boolean }
const DENY_FIELD: FieldAccessState = Object.freeze({ read: 'OMITTED', writable: false })

export const evaluateFieldAccess = (fieldKey: string, catalog: BackendFieldCatalog | null,
  snapshot: PermissionSnapshot | null, binding: PermissionSnapshotBinding | null, now = Date.now()): FieldAccessState => {
  if (!isSnapshotCurrent(snapshot, binding, now) || !catalog || !isCatalogScope(catalog.catalogScope)
    || catalogScopeKey(catalog.catalogScope) !== catalogScopeKey(snapshot.catalogScope) || catalog.catalogVersion !== snapshot.catalogVersion
    || !identifier(fieldKey, 200) || !record(catalog.fields) || !Object.hasOwn(catalog.fields, fieldKey)) return DENY_FIELD
  const field = catalog.fields[fieldKey]
  if (!field || field.access === 'INTERNAL') return DENY_FIELD
  const input = field.inputBinding === true
  if (field.access === 'PUBLIC') return field.fieldPolicy == null ? { read: 'PLAIN', writable: false } : DENY_FIELD
  const policy = field.fieldPolicy
  if (field.access !== 'PROTECTED' || !policy || !['STRING', 'NUMBER', 'BOOLEAN', 'OBJECT', 'ARRAY'].includes(policy.valueType)) return DENY_FIELD
  for (const rule of [policy.plainRead, policy.maskedRead, policy.write]) if (rule != null && !isPermissionRequirement(rule)) return DENY_FIELD
  if ((policy.maskedRead != null && (policy.valueType !== 'STRING' || !['FIXED', 'EMAIL', 'PHONE', 'BANK_ACCOUNT'].includes(policy.masker ?? '')))
    || (policy.masker != null && policy.maskedRead == null)) return DENY_FIELD
  const codes = new Set(snapshot.permissionCodes)
  const read = evaluateRequirement(policy.plainRead, codes) ? 'PLAIN' : evaluateRequirement(policy.maskedRead, codes) ? 'MASKED' : 'OMITTED'
  return { read, writable: input && evaluateRequirement(policy.write, codes) }
}
