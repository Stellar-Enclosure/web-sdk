import { allowsSnapshotRequirement, evaluateFieldAccess, isPermissionRequirement,
  type BackendFieldCatalog, type PermissionSnapshot, type PermissionSnapshotBinding, type ResourceReference } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import type { FieldAccessResult, FrontendNavigationNode, FrontendResourceDefinition } from '../types'
export type { FieldAccessResult, FrontendNavigationNode, FrontendResourceDefinition, FrontendResourceKind } from '../types'

/** Checked-in declarations supply requirements; resource keys are lookup identities, never grants. */
export class FrontendResourceRegistry {
  readonly definitions: readonly FrontendResourceDefinition[]
  private readonly byKey: ReadonlyMap<string, FrontendResourceDefinition>
  constructor(definitions: readonly FrontendResourceDefinition[], private readonly references: readonly ResourceReference[] = []) {
    this.definitions = definitions.map(value => Object.freeze({ ...value, target: Object.freeze({ ...value.target }), i18n: Object.freeze({ ...value.i18n }) }))
    const keys = new Set<string>()
    for (const value of this.definitions) {
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/.test(value.key) || keys.has(value.key.toLowerCase())) throw new Error('Invalid or duplicate frontend resource key')
      keys.add(value.key.toLowerCase())
      if (!['APP', 'MENU', 'PAGE', 'COMPONENT', 'BUTTON'].includes(value.type)) throw new Error('Frontend declarations cannot own API or FIELD policies')
      const access = value.access ?? (value.requirement ? 'PROTECTED' : undefined)
      if (!access || !['PROTECTED', 'PUBLIC', 'INTERNAL'].includes(access) || (access === 'PROTECTED' && !isPermissionRequirement(value.requirement))
        || (access !== 'PROTECTED' && value.requirement != null)) throw new Error('Frontend resource needs an explicit requirement or access classification')
      if (value.type === 'PAGE' && (typeof value.target.route !== 'string' || !value.target.route.startsWith('/') || value.target.route.startsWith('//'))) throw new Error('Page resource requires a local route')
    }
    this.byKey = new Map(this.definitions.map(value => [value.key, value]))
    for (const value of this.definitions) {
      const seen = new Set([value.key])
      let parent: string | readonly string[] | undefined = value.target.parentKey
      while (parent !== undefined) {
        if (typeof parent !== 'string' || !this.byKey.has(parent)) throw new Error('Frontend resource parent is missing')
        if (seen.has(parent)) throw new Error('Cyclic frontend resource parent chain')
        seen.add(parent); parent = this.byKey.get(parent)?.target.parentKey
      }
    }
  }

  canAccessResource(key: string, snapshot: PermissionSnapshot | null, binding: PermissionSnapshotBinding | null): boolean {
    const resource = this.byKey.get(key)
    if (!resource || resource.access === 'INTERNAL' || (resource.allowedPrincipals && !resource.allowedPrincipals.includes('USER'))) return false
    return allowsSnapshotRequirement(snapshot, binding, resource.access === 'PUBLIC' ? { access: 'PUBLIC' } : resource.requirement)
  }

  canAccessRoute(key: string, snapshot: PermissionSnapshot | null, binding: PermissionSnapshotBinding | null): boolean {
    return this.byKey.get(key)?.type === 'PAGE' && this.canAccessResource(key, snapshot, binding)
  }

  navigation(snapshot: PermissionSnapshot | null, binding: PermissionSnapshotBinding | null): readonly FrontendNavigationNode[] {
    const children = new Map<string | undefined, FrontendResourceDefinition[]>()
    for (const value of this.definitions.filter(item => item.type === 'MENU' || item.type === 'PAGE')) {
      const parent = typeof value.target.parentKey === 'string' ? value.target.parentKey : undefined
      children.set(parent, [...(children.get(parent) ?? []), value])
    }
    const build = (value: FrontendResourceDefinition): FrontendNavigationNode | null => {
      if (value.target.hidden === 'true' || !this.canAccessResource(value.key, snapshot, binding)) return null
      const descendants = (children.get(value.key) ?? []).sort(compareResourceOrder).map(build).filter((item): item is FrontendNavigationNode => item !== null)
      return { ...value, children: descendants }
    }
    return (children.get(undefined) ?? []).sort(compareResourceOrder).map(build).filter((item): item is FrontendNavigationNode => item !== null)
  }

  getField(key: string, catalog: BackendFieldCatalog | null, snapshot: PermissionSnapshot | null, binding: PermissionSnapshotBinding | null): FieldAccessResult {
    if (!this.references.some(value => value.key === key && ['FORM_FIELD', 'TABLE_FIELD', 'DETAIL_FIELD'].includes(value.usage))) return { read: 'OMITTED', writable: false }
    return evaluateFieldAccess(key, catalog, snapshot, binding)
  }

  serializable(): readonly FrontendResourceDefinition[] { return this.definitions }
}

export const compareResourceOrder = (left: FrontendResourceDefinition, right: FrontendResourceDefinition): number => {
  const order = (value: FrontendResourceDefinition) => typeof value.target.order === 'string' && /^\d{1,9}$/.test(value.target.order) ? Number(value.target.order) : Number.MAX_SAFE_INTEGER
  return order(left) - order(right) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
}
