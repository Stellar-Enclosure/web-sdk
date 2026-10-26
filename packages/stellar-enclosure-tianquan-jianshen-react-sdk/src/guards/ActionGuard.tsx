import type { ReactNode } from 'react'
import { usePermission as useSnapshotPermission } from '@stellar-enclosure/stellar-enclosure-web-shared/react-permissions'
import { useRbac3Authorization } from '../hooks/useRbac3Authorization'

export interface ActionGuardProps {
  readonly resourceKey: string
  readonly children: ReactNode
  readonly fallback?: ReactNode
}
/** A key resolves a code-declared requirement. It cannot act as a permission grant. */
export const ActionGuard = ({ resourceKey, children, fallback = null }: ActionGuardProps) => {
  const { status, snapshot, binding, resourceRegistry } = useRbac3Authorization()
  useSnapshotPermission(snapshot, binding)
  return status === 'READY' && resourceRegistry.canAccessResource(resourceKey, snapshot, binding) ? children : fallback
}
