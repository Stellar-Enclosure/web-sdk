import { useEffect, useMemo, useState } from 'react'
import { allowsSnapshotRequirement, snapshotExpiry, type PermissionSnapshot, type PermissionSnapshotBinding } from '../permissions/permissionSnapshot'

export const usePermission = (snapshot: PermissionSnapshot | null, binding: PermissionSnapshotBinding | null) => {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const remaining = snapshot ? snapshotExpiry(snapshot.snapshotExpiresAt) - Date.now() : 0
    if (!(remaining > 0)) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining + 1, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [snapshot, now])
  return useMemo(() => {
    const allows = (requirement: unknown) => allowsSnapshotRequirement(snapshot, binding, requirement, Math.max(now, Date.now()))
    return {
      allows,
      has: (permission: string) => allows({ mode: 'ALL', codes: [permission] }),
      hasAll: (...required: string[]) => allows({ mode: 'ALL', codes: required }),
      hasAny: (...required: string[]) => allows({ mode: 'ANY', codes: required }),
    }
  }, [snapshot, binding, now])
}
