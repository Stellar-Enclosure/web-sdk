import type { CatalogScope, PermissionSnapshot, PermissionSnapshotContext } from '../permissions/permissionSnapshot'

export const scope: CatalogScope = { catalogScopeId: '500', tenantId: '1001', businessCode: 'trade', applicationCode: 'orders', namespaceCode: 'main', environment: 'test' }
export const permissionSnapshot = (overrides: Partial<PermissionSnapshot> = {}): PermissionSnapshot => ({
  issuer: 'https://idp.example/tenants/1001', subject: 'alice', catalogScope: scope, catalogVersion: '7', authVersion: '11', policyVersion: '13',
  activeRoleContext: { applicationCode: 'orders', rootRoleIds: ['20'], effectiveRoleIds: ['20', '21'] },
  permissionCodes: ['order:read'], snapshotExpiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides,
})
export const permissionBinding = (overrides: Partial<PermissionSnapshotContext> = {}): PermissionSnapshotContext => {
  const snapshot = permissionSnapshot()
  return { issuer: snapshot.issuer, subject: snapshot.subject, catalogScope: snapshot.catalogScope, catalogVersion: snapshot.catalogVersion,
    authVersion: snapshot.authVersion, policyVersion: snapshot.policyVersion, activeRoleContext: snapshot.activeRoleContext, requestEpoch: 0, ...overrides }
}
