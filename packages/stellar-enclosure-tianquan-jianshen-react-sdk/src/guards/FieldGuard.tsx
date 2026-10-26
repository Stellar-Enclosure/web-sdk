import type { ReactNode } from 'react'
import { usePermission as useSnapshotPermission } from '@stellar-enclosure/stellar-enclosure-web-shared/react-permissions'
import type { FieldAccessState } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import { useRbac3Authorization } from '../hooks/useRbac3Authorization'

export const useFieldAccess = (fieldKey: string): FieldAccessState => {
  const { status, snapshot, binding, fieldCatalog, resourceRegistry } = useRbac3Authorization()
  useSnapshotPermission(snapshot, binding)
  return resourceRegistry.getField(fieldKey, fieldCatalog, status === 'READY' ? snapshot : null, binding)
}
export interface FieldGuardProps {
  readonly fieldKey: string
  readonly value?: ReactNode
  readonly maskedValue?: ReactNode
  readonly fallback?: ReactNode
  readonly render?: (value: ReactNode, access: FieldAccessState) => ReactNode
}
/** Masked values must already be produced by the server. Write capability is checked independently. */
export const FieldGuard = ({ fieldKey, value = null, maskedValue = null, fallback = null, render }: FieldGuardProps) => {
  const access = useFieldAccess(fieldKey)
  if (access.read === 'OMITTED') return fallback
  const authorizedValue = access.read === 'MASKED' ? maskedValue : value
  if (authorizedValue === null || authorizedValue === undefined) return fallback
  return render ? render(authorizedValue, access) : authorizedValue
}
