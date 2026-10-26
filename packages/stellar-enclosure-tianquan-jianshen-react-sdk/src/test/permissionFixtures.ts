import { vi } from 'vitest'
import { AuthRequestContext } from '@stellar-enclosure/stellar-enclosure-web-shared'
import { snapshotContext, type PermissionSnapshot, type ResourceDefinition, type ResourceReference, type BackendFieldCatalog } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import type { Rbac3AboutView, Rbac3Client, RoleActivationCandidateView } from '../types'

export const snapshot = (overrides: Partial<PermissionSnapshot> = {}): PermissionSnapshot => ({
  issuer: 'https://idp.example/tenants/1001', subject: 'alice',
  catalogScope: { catalogScopeId: '500', tenantId: '1001', businessCode: 'trade', applicationCode: 'orders', namespaceCode: 'main', environment: 'test' },
  catalogVersion: '7', authVersion: '11', policyVersion: '13', activeRoleContext: { applicationCode: 'orders', rootRoleIds: ['20'], effectiveRoleIds: ['20'] },
  permissionCodes: ['order:read'], snapshotExpiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides,
})
export const about: Rbac3AboutView = { user: { subject: 'alice', tenantId: '1001', status: 'ACTIVE' }, currentApplicationCode: 'orders',
  activeRoles: [{ roleId: '20', roleCode: 'READER', applicationCode: 'orders' }], landingRouteCode: 'order.page.list', authVersion: 11, policyVersion: 13 }
export const resources: readonly ResourceDefinition[] = [
  { key: 'order.menu', type: 'MENU', target: { order: '1' }, access: 'PUBLIC', i18n: { pageCode: 'order', labelKey: 'menu' } },
  { key: 'order.page.list', type: 'PAGE', target: { parentKey: 'order.menu', route: '/orders', componentKey: 'orders' }, requirement: { mode: 'ALL', codes: ['order:read'] }, i18n: { pageCode: 'order', labelKey: 'title' } },
  { key: 'order.button.write', type: 'BUTTON', target: { pageKey: 'order.page.list', actionKey: 'write' }, requirement: { mode: 'ALL', codes: ['order:write'] }, i18n: { pageCode: 'order', labelKey: 'write' } },
]
export const references: readonly ResourceReference[] = [{ key: 'order.field.accountNo', usage: 'DETAIL_FIELD' }]
export const fields: BackendFieldCatalog = { catalogScope: snapshot().catalogScope, catalogVersion: '7', fields: {
  'order.field.accountNo': { access: 'PROTECTED', fieldPolicy: { valueType: 'STRING', plainRead: { mode: 'ALL', codes: ['order:account:plain'] },
    maskedRead: { mode: 'ALL', codes: ['order:read'] }, masker: 'BANK_ACCOUNT', write: { mode: 'ALL', codes: ['order:write'] } } },
} }
export const fixture = (overrides: Partial<Rbac3Client> = {}, current = snapshot()) => {
  const requestContext = new AuthRequestContext()
  const binding = snapshotContext(current, requestContext.epoch)
  const candidates: RoleActivationCandidateView = { applications: [], basedOnAuthVersion: 11, basedOnPolicyVersion: 13,
    basedOnDirectorySnapshotVersion: '1', configurationErrors: [], calculatedAt: new Date().toISOString() }
  const client: Rbac3Client = {
    getActivationCandidates: vi.fn(async () => candidates),
    getActiveRoles: vi.fn(async () => ({ activeRoles: [], activationRequired: false, authVersion: 11, policyVersion: 13, snapshotChecksum: 'sum' })),
    replaceActiveRoles: vi.fn(async () => ({ activeRoles: [], changed: true, authVersion: 12, policyVersion: 13, activationRequired: false, snapshotChecksum: 'next' })),
    getAbout: vi.fn(async () => ({ ...about, user: { ...about.user, subject: current.subject, tenantId: current.catalogScope.tenantId }, currentApplicationCode: current.catalogScope.applicationCode })),
    getPermissionSnapshot: vi.fn(async () => current), ...overrides,
  }
  return { client, binding, requestContext }
}
