import { createContext, type PropsWithChildren, useCallback, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react'
import type { AuthRequestContext } from '@stellar-enclosure/stellar-enclosure-web-shared'
import { catalogScopeKey, copyPermissionSnapshot, isPermissionSnapshotContext, isSnapshotCurrent,
  permissionBindingKey, snapshotContext, snapshotExpiry, type ResourceDefinition, type ResourceReference } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import { Rbac3RequestError } from '../errors'
import type { Rbac3Client, ReplaceActiveRolesRequest, ReplaceActiveRolesResult, PermissionSnapshotContext, PermissionSnapshot, BackendFieldCatalog } from '../types'
import { FrontendResourceRegistry } from '../registry/FrontendResourceRegistry'
import { initialRbac3MachineState, type Rbac3MachineState, transitionRbac3State } from './rbac3StateMachine'

export interface Rbac3AuthorizationContextValue extends Rbac3MachineState {
  readonly fieldCatalog: BackendFieldCatalog | null
  readonly resourceRegistry: FrontendResourceRegistry
  readonly replaceActiveRoles: (request: ReplaceActiveRolesRequest) => Promise<ReplaceActiveRolesResult | null>
  readonly retry: () => Promise<void>
}
export const Rbac3AuthorizationContext = createContext<Rbac3AuthorizationContextValue | null>(null)
export interface Rbac3ProviderProps extends PropsWithChildren {
  readonly client: Rbac3Client
  readonly binding: PermissionSnapshotContext | null
  readonly requestContext: AuthRequestContext
  readonly fieldCatalog?: BackendFieldCatalog | null
  readonly resources?: readonly ResourceDefinition[]
  readonly resourceReferences?: readonly ResourceReference[]
  readonly onContextChange?: (context: PermissionSnapshotContext, snapshot: PermissionSnapshot) => void
  readonly autoInitialize?: boolean
}

const NO_RESOURCES: readonly ResourceDefinition[] = []
const NO_REFERENCES: readonly ResourceReference[] = []

export const Rbac3Provider = ({ client, binding, requestContext, fieldCatalog = null, resources = NO_RESOURCES, resourceReferences = NO_REFERENCES, onContextChange,
  autoInitialize = true, children }: Rbac3ProviderProps) => {
  const resourceRegistry = useMemo(() => new FrontendResourceRegistry(resources, resourceReferences), [resources, resourceReferences])
  const [state, dispatch] = useReducer(transitionRbac3State, initialRbac3MachineState)
  const epoch = useSyncExternalStore(requestContext.subscribe, () => requestContext.epoch, () => requestContext.epoch)
  const inputKey = isPermissionSnapshotContext(binding) ? permissionBindingKey(binding) : null
  const sequence = useRef(0)
  const pending = useRef<AbortController | null>(null)
  const replacing = useRef<number | null>(null)
  const latestBinding = useRef<{ inputKey: string; binding: PermissionSnapshotContext } | null>(null)
  const begin = useCallback(() => {
    pending.current?.abort()
    const controller = new AbortController(); pending.current = controller
    const serial = ++sequence.current
    const captured = requestContext.capture(controller.signal)
    return { serial, signal: captured.signal, assertCurrent: () => {
      captured.assertCurrent()
      if (serial !== sequence.current) throw new DOMException('Authorization request was superseded', 'AbortError')
    } }
  }, [requestContext])
  const failure = useCallback((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return
    const value = classifyError(error)
    if (value.status === 401) dispatch({ type: 'AUTHENTICATION_REQUIRED', errorCode: value.code })
    else if (value.status === 403) dispatch({ type: 'FORBIDDEN', errorCode: value.code })
    else dispatch({ type: 'ERROR', errorCode: value.code, retryable: value.retryable })
  }, [])
  const loadActivation = useCallback(async (attempt: ReturnType<typeof begin>) => {
    const [candidates, activeRoles] = await Promise.all([client.getActivationCandidates(attempt.signal), client.getActiveRoles(attempt.signal)])
    attempt.assertCurrent()
    dispatch({ type: 'ACTIVATION_REQUIRED', candidates, activeRoles })
  }, [client])
  const initialize = useCallback(async () => {
    if (!binding || !inputKey || binding.requestEpoch !== requestContext.epoch) {
      pending.current?.abort(); sequence.current += 1
      dispatch({ type: 'AUTHENTICATION_REQUIRED' }); return
    }
    const expected = latestBinding.current?.inputKey === inputKey && latestBinding.current.binding.requestEpoch === requestContext.epoch
      ? latestBinding.current.binding : binding
    const attempt = begin()
    dispatch({ type: 'INITIALIZE', inputBindingKey: inputKey, requestEpoch: expected.requestEpoch })
    try {
      const [about, response] = await Promise.all([client.getAbout(attempt.signal), client.getPermissionSnapshot(attempt.signal)])
      attempt.assertCurrent()
      if (!isSnapshotCurrent(response, expected) || about.user.subject !== expected.subject || about.user.tenantId !== expected.catalogScope.tenantId) {
        throw new Rbac3RequestError({ status: 409, code: 'INVALID_RESPONSE', message: 'Permission snapshot context changed', retryable: true })
      }
      const snapshot = copyPermissionSnapshot(response)
      if (snapshot.catalogScope.applicationCode === 'tianquan-jianshen' && snapshot.activeRoleContext.rootRoleIds.length === 0
        && snapshot.permissionCodes.includes('system:role-activation:use')) await loadActivation(attempt)
      else {
        latestBinding.current = { inputKey, binding: expected }
        dispatch({ type: 'ABOUT_SUCCEEDED', about, snapshot, binding: expected })
      }
    } catch (error) {
      try {
        attempt.assertCurrent()
        if (classifyError(error).code === 'ROLE_ACTIVATION_REQUIRED') await loadActivation(attempt)
        else failure(error)
      } catch (currentError) { failure(currentError) }
    }
  }, [binding, inputKey, requestContext, begin, client, loadActivation, failure])
  useEffect(() => {
    if (autoInitialize) void initialize()
    return () => { pending.current?.abort(); sequence.current += 1; replacing.current = null }
  }, [autoInitialize, initialize, epoch])
  useEffect(() => {
    if (!state.snapshot) return
    const timer = setTimeout(() => dispatch({ type: 'EXPIRED' }), Math.max(1, Math.min(snapshotExpiry(state.snapshot.snapshotExpiresAt) - Date.now(), 2_147_483_647)))
    return () => clearTimeout(timer)
  }, [state.snapshot])

  const replaceActiveRoles = useCallback(async (request: ReplaceActiveRolesRequest): Promise<ReplaceActiveRolesResult | null> => {
    if (!binding || !inputKey || binding.requestEpoch !== requestContext.epoch || replacing.current !== null) {
      throw new Rbac3RequestError({ status: 409, code: 'AUTH_MUTATION_CONFLICT', message: 'Authorization context is not ready', retryable: false })
    }
    const attempt = begin()
    replacing.current = attempt.serial
    dispatch({ type: 'INITIALIZE', inputBindingKey: inputKey, requestEpoch: binding.requestEpoch })
    dispatch({ type: 'REPLACE_ACTIVE_ROLES' })
    try {
      const result = await client.replaceActiveRoles(request, attempt.signal)
      attempt.assertCurrent()
      if (result.activationRequired) { await loadActivation(attempt); return result }
      const [about, response] = await Promise.all([client.getAbout(attempt.signal), client.getPermissionSnapshot(attempt.signal)])
      attempt.assertCurrent()
      const next = snapshotContext(response, binding.requestEpoch)
      if (!isSnapshotCurrent(response, next) || next.issuer !== binding.issuer || next.subject !== binding.subject
        || catalogScopeKey(next.catalogScope) !== catalogScopeKey(binding.catalogScope) || next.catalogVersion !== binding.catalogVersion
        || BigInt(next.authVersion) < BigInt(binding.authVersion) || BigInt(next.policyVersion) < BigInt(binding.policyVersion)
        || about.user.subject !== next.subject || about.user.tenantId !== next.catalogScope.tenantId) {
        throw new Rbac3RequestError({ status: 409, code: 'INVALID_RESPONSE', message: 'Permission snapshot context changed', retryable: true })
      }
      latestBinding.current = { inputKey, binding: next }
      dispatch({ type: 'ABOUT_SUCCEEDED', about, snapshot: copyPermissionSnapshot(response), binding: next })
      onContextChange?.(next, copyPermissionSnapshot(response))
      return result
    } catch (error) {
      attempt.assertCurrent()
      const value = classifyError(error)
      if (value.code === 'STEP_UP_REQUIRED') dispatch({ type: 'REPLACE_STEP_UP_REQUIRED' })
      else if (value.status === 401 || value.status === 403) failure(error)
      else if (value.code === 'ROLE_ACTIVATION_VERSION_CONFLICT' || value.code === 'AUTH_MUTATION_CONFLICT') {
        await loadActivation(attempt); return null
      } else dispatch({ type: 'REPLACE_REJECTED', errorCode: value.code })
      throw error
    } finally { if (replacing.current === attempt.serial) replacing.current = null }
  }, [binding, inputKey, requestContext, begin, client, loadActivation, onContextChange, failure])

  const contextMatches = binding !== null && binding.requestEpoch === epoch && state.requestEpoch === epoch && state.inputBindingKey === inputKey
  const value = useMemo<Rbac3AuthorizationContextValue>(() => ({ ...state,
    status: state.status === 'READY' && !contextMatches ? 'UNINITIALIZED' : state.status,
    about: contextMatches ? state.about : null, snapshot: contextMatches ? state.snapshot : null,
    binding: contextMatches ? state.binding : null, candidates: contextMatches ? state.candidates : null,
    activeRoles: contextMatches ? state.activeRoles : null, fieldCatalog, resourceRegistry, replaceActiveRoles, retry: initialize,
  }), [state, contextMatches, fieldCatalog, resourceRegistry, replaceActiveRoles, initialize])
  return <Rbac3AuthorizationContext.Provider value={value}>{children}</Rbac3AuthorizationContext.Provider>
}

const classifyError = (error: unknown): { status: number; code: string; retryable: boolean } => {
  if (error instanceof Rbac3RequestError) return error
  if (typeof error === 'object' && error !== null) {
    const value = error as { status?: unknown; code?: unknown; retryable?: unknown }
    return { status: typeof value.status === 'number' ? value.status : 0,
      code: typeof value.code === 'string' ? value.code : 'NETWORK_ERROR', retryable: value.retryable === true }
  }
  return { status: 0, code: 'NETWORK_ERROR', retryable: true }
}
