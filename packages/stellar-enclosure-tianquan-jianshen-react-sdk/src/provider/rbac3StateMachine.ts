import { isSnapshotCurrent } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import type { ActiveRoleSetView, Rbac3AboutView, Rbac3State, RoleActivationCandidateView, PermissionSnapshot, PermissionSnapshotContext } from '../types'

export interface Rbac3MachineState {
  readonly status: Rbac3State
  readonly about: Rbac3AboutView | null
  readonly snapshot: PermissionSnapshot | null
  readonly binding: PermissionSnapshotContext | null
  readonly inputBindingKey: string | null
  readonly requestEpoch: number
  readonly candidates: RoleActivationCandidateView | null
  readonly activeRoles: ActiveRoleSetView | null
  readonly errorCode: string | null
}
export type Rbac3MachineEvent =
  | { readonly type: 'INITIALIZE'; readonly inputBindingKey: string; readonly requestEpoch: number }
  | { readonly type: 'ABOUT_SUCCEEDED'; readonly about: Rbac3AboutView; readonly snapshot: PermissionSnapshot; readonly binding: PermissionSnapshotContext }
  | { readonly type: 'ACTIVATION_REQUIRED'; readonly candidates: RoleActivationCandidateView | null; readonly activeRoles?: ActiveRoleSetView | null }
  | { readonly type: 'REPLACE_ACTIVE_ROLES' }
  | { readonly type: 'REPLACE_STEP_UP_REQUIRED' }
  | { readonly type: 'REPLACE_REJECTED'; readonly errorCode: string }
  | { readonly type: 'AUTHENTICATION_REQUIRED'; readonly errorCode?: string }
  | { readonly type: 'FORBIDDEN'; readonly errorCode: string }
  | { readonly type: 'ERROR'; readonly errorCode: string; readonly retryable: boolean }
  | { readonly type: 'EXPIRED' }

export const initialRbac3MachineState: Rbac3MachineState = Object.freeze({
  status: 'UNINITIALIZED', about: null, snapshot: null, binding: null, inputBindingKey: null, requestEpoch: -1,
  candidates: null, activeRoles: null, errorCode: null,
})
const cleared = (state: Rbac3MachineState): Rbac3MachineState => ({ ...state, about: null, snapshot: null, binding: null, candidates: null, activeRoles: null })

export const transitionRbac3State = (state: Rbac3MachineState, event: Rbac3MachineEvent): Rbac3MachineState => {
  switch (event.type) {
    case 'INITIALIZE': return { ...initialRbac3MachineState, status: 'LOADING_ABOUT', inputBindingKey: event.inputBindingKey, requestEpoch: event.requestEpoch }
    case 'ABOUT_SUCCEEDED':
      if (!isSnapshotCurrent(event.snapshot, event.binding) || event.binding.requestEpoch !== state.requestEpoch) {
        return { ...cleared(state), status: 'ERROR_RETRYABLE', errorCode: 'PERMISSION_SNAPSHOT_CONTEXT_MISMATCH_OR_EXPIRED' }
      }
      return { ...state, status: 'READY', about: event.about, snapshot: event.snapshot, binding: event.binding, candidates: null, errorCode: null }
    case 'ACTIVATION_REQUIRED': return { ...cleared(state), status: 'ACTIVATION_REQUIRED', candidates: event.candidates, activeRoles: event.activeRoles ?? null, errorCode: null }
    case 'REPLACE_ACTIVE_ROLES': return { ...cleared(state), status: 'REPLACING_ACTIVE_ROLES', errorCode: null }
    case 'REPLACE_STEP_UP_REQUIRED': return { ...cleared(state), status: 'ACTIVATION_REQUIRED', errorCode: 'STEP_UP_REQUIRED' }
    case 'REPLACE_REJECTED': return { ...cleared(state), status: 'ERROR_RETRYABLE', errorCode: event.errorCode }
    case 'AUTHENTICATION_REQUIRED': return { ...cleared(state), status: 'AUTHENTICATION_REQUIRED', errorCode: event.errorCode ?? 'AUTHENTICATION_REQUIRED' }
    case 'FORBIDDEN': return { ...cleared(state), status: 'FORBIDDEN_NO_ROUTE', errorCode: event.errorCode }
    case 'ERROR': return { ...cleared(state), status: event.retryable ? 'ERROR_RETRYABLE' : 'ERROR_FATAL', errorCode: event.errorCode }
    case 'EXPIRED': return { ...cleared(state), status: 'ERROR_RETRYABLE', errorCode: 'PERMISSION_SNAPSHOT_EXPIRED' }
  }
}
