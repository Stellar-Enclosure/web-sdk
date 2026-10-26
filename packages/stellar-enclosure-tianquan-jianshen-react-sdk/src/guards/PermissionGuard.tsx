import type { ReactNode } from 'react'
import type { PermissionRequirement } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import { usePermission } from '../hooks/usePermission'

export interface PermissionGuardProps {
  readonly requirement: PermissionRequirement
  readonly children: ReactNode
  readonly fallback?: ReactNode
}
export const PermissionGuard = ({ requirement, children, fallback = null }: PermissionGuardProps) =>
  usePermission(requirement) ? children : fallback
