import type { PermissionSnapshot, PermissionSnapshotBinding } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import { FrontendResourceRegistry, compareResourceOrder, type FrontendResourceDefinition } from '../registry/FrontendResourceRegistry'

export const resolveDefaultRoute = (snapshot: PermissionSnapshot | null, binding: PermissionSnapshotBinding | null,
  definitions: FrontendResourceRegistry | readonly FrontendResourceDefinition[], landingRouteKey?: string | null): FrontendResourceDefinition | null => {
  const registry = definitions instanceof FrontendResourceRegistry ? definitions : new FrontendResourceRegistry(definitions)
  const accessible = registry.definitions.filter(value => value.type === 'PAGE' && value.target.hidden !== 'true')
    .filter(value => registry.canAccessRoute(value.key, snapshot, binding)).sort(compareResourceOrder)
  return accessible.find(value => value.key === landingRouteKey) ?? accessible[0] ?? null
}
