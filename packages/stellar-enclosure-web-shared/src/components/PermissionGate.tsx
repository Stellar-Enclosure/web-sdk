import type { ReactNode } from 'react'
import { usePermission } from '../hooks/usePermission'
import type { PermissionRequirement } from '../permissions/definitions'
import type { PermissionSnapshot, PermissionSnapshotBinding } from '../permissions/permissionSnapshot'

export interface PermissionGateProps {
  readonly snapshot: PermissionSnapshot | null
  readonly binding: PermissionSnapshotBinding | null
  readonly requirement: PermissionRequirement
  readonly children: ReactNode
  readonly fallback?: ReactNode
}

/** UI visibility only. The server independently authenticates and authorizes every API request. */
export const PermissionGate = ({ snapshot, binding, requirement, children, fallback = null }: PermissionGateProps) =>
  usePermission(snapshot, binding).allows(requirement) ? children : fallback
