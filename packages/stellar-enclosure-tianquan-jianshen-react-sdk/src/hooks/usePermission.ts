import { usePermission as useSnapshotPermission } from '@stellar-enclosure/stellar-enclosure-web-shared/react-permissions'
import type { PermissionRequirement } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import { useRbac3Authorization } from './useRbac3Authorization'

export const usePermission = (requirement: PermissionRequirement | string): boolean => {
  const { status, snapshot, binding } = useRbac3Authorization()
  return useSnapshotPermission(status === 'READY' ? snapshot : null, binding)
    .allows(typeof requirement === 'string' ? { mode: 'ALL', codes: [requirement] } : requirement)
}
