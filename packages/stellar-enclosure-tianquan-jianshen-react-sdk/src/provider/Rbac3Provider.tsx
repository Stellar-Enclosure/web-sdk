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
const RENEW_AHEAD_MS = 15_000
const RENEW_RETRY_WINDOW_MS = 30_000
const MAX_RENEW_RETRIES = 5

export const Rbac3Provider = ({ client, binding: suppliedBinding, requestContext, fieldCatalog = null, resources = NO_RESOURCES, resourceReferences = NO_REFERENCES, onContextChange,
  autoInitialize = true, children }: Rbac3ProviderProps) => {
  const inputKey = isPermissionSnapshotContext(suppliedBinding) ? permissionBindingKey(suppliedBinding) : null
  // Inline host props with the same verified facts must not repeatedly cancel a slow renewal.
  const binding = useMemo(() => suppliedBinding, [inputKey, suppliedBinding?.requestEpoch])
  const resourceRegistry = useMemo(() => new FrontendResourceRegistry(resources, resourceReferences), [resources, resourceReferences])
  const [state, dispatch] = useReducer(transitionRbac3State, initialRbac3MachineState)
  const epoch = useSyncExternalStore(requestContext.subscribe, () => requestContext.epoch, () => requestContext.epoch)
  const sequence = useRef(0)
  const pending = useRef<AbortController | null>(null)
  const throttledSnapshot = useRef<PermissionSnapshot | null>(null)
  const renewalRetry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentState = useRef(state)
  currentState.current = state
  const contextChange = useRef(onContextChange)
  contextChange.current = onContextChange
  const replacing = useRef<number | null>(null)
  const verifiedSource = useRef<{ client: Rbac3Client; requestContext: AuthRequestContext } | null>(null)
  const latestBinding = useRef<{ inputKey: string; binding: PermissionSnapshotContext } | null>(null)
  const begin = useCallback(() => {
    pending.current?.abort()
    if (renewalRetry.current !== null) clearTimeout(renewalRetry.current)
    renewalRetry.current = null
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
        verifiedSource.current = { client, requestContext }
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
  const renew = useCallback(async function renewSnapshot(expected: PermissionSnapshotContext, previousExpiry: number,
    deadline: number, retries = 0): Promise<void> {
    if (!binding || !inputKey || binding.requestEpoch !== requestContext.epoch
      || expected.requestEpoch !== requestContext.epoch || replacing.current !== null
      || retries > 0 && Date.now() >= deadline) return
    const attempt = begin()
    const scheduleRetry = (next = expected, expiresAt = previousExpiry): boolean => {
      const delay = Math.min(1_000 * 2 ** retries, 5_000)
      if (retries >= MAX_RENEW_RETRIES || Date.now() + delay >= deadline) return false
      renewalRetry.current = setTimeout(() => {
        renewalRetry.current = null
        void renewSnapshot(next, expiresAt, deadline, retries + 1)
      }, delay)
      return true
    }
    try {
      // Neither read waits for the other; a short-lived snapshot may have only seconds left on arrival.
      const [about, response] = await Promise.all([client.getAbout(attempt.signal), client.getPermissionSnapshot(attempt.signal)])
      attempt.assertCurrent()
      const next = snapshotContext(response, expected.requestEpoch)
      const rolesChanged = JSON.stringify(next.activeRoleContext) !== JSON.stringify(expected.activeRoleContext)
      if (!isSnapshotCurrent(response, next) || next.issuer !== expected.issuer || next.subject !== expected.subject
        || catalogScopeKey(next.catalogScope) !== catalogScopeKey(expected.catalogScope)
        || BigInt(next.catalogVersion) < BigInt(expected.catalogVersion)
        || BigInt(next.authVersion) < BigInt(expected.authVersion) || BigInt(next.policyVersion) < BigInt(expected.policyVersion)
        || rolesChanged && next.authVersion === expected.authVersion
        || about.user.subject !== next.subject || about.user.tenantId !== next.catalogScope.tenantId
        || !Number.isSafeInteger(about.authVersion) || String(about.authVersion) !== next.authVersion
        || !Number.isSafeInteger(about.policyVersion) || String(about.policyVersion) !== next.policyVersion) {
        throw new Rbac3RequestError({ status: 409, code: 'INVALID_RESPONSE', message: 'Renewed permission snapshot context changed', retryable: false })
      }
      const snapshot = copyPermissionSnapshot(response)
      const expiresAt = snapshotExpiry(snapshot.snapshotExpiresAt)
      // Accept new grants/revocations and shorter expiry immediately, even if a reused head does not renew its TTL.
      throttledSnapshot.current = expiresAt <= previousExpiry ? snapshot : null
      verifiedSource.current = { client, requestContext }
      latestBinding.current = { inputKey, binding: next }
      if (snapshot.catalogScope.applicationCode === 'tianquan-jianshen' && snapshot.activeRoleContext.rootRoleIds.length === 0
        && snapshot.permissionCodes.includes('system:role-activation:use')) await loadActivation(attempt)
      else {
        dispatch({ type: 'ABOUT_SUCCEEDED', about, snapshot, binding: next })
        if (expiresAt <= previousExpiry) scheduleRetry(next, expiresAt)
      }
      contextChange.current?.(next, snapshot)
    } catch (error) {
      try { attempt.assertCurrent() } catch { return }
      if (error instanceof DOMException && error.name === 'AbortError') return
      const value = classifyError(error)
      if (value.retryable && (value.status === 0 || value.status >= 500)) {
        if (!scheduleRetry() && Date.now() >= previousExpiry) failure(error)
        // A transient read failure does not unmount a still-current authorized view.
      } else failure(error)
    }
  }, [binding, inputKey, requestContext, begin, client, loadActivation, failure])

  const identityKey = binding && inputKey
    ? JSON.stringify([binding.issuer, binding.subject, catalogScopeKey(binding.catalogScope)]) : null
  useEffect(() => () => {
    pending.current?.abort(); sequence.current += 1; replacing.current = null
    if (renewalRetry.current !== null) clearTimeout(renewalRetry.current)
    renewalRetry.current = null
  }, [client, requestContext, epoch, identityKey, autoInitialize])
  useEffect(() => {
    const established = currentState.current
    const acceptedEcho = binding && inputKey && established.status === 'READY' && established.binding
      && binding.requestEpoch === requestContext.epoch && established.requestEpoch === requestContext.epoch
      && verifiedSource.current?.client === client && verifiedSource.current.requestContext === requestContext
      && isSnapshotCurrent(established.snapshot, binding)
    if (autoInitialize) {
      // A host acknowledging the SDK's verified renewal is not a new login or a reason to clear its component tree.
      if (acceptedEcho) latestBinding.current = { inputKey, binding: established.binding! }
      else void initialize()
    }
  }, [autoInitialize, initialize, epoch])
  useEffect(() => {
    if (!state.snapshot) return
    const snapshot = state.snapshot
    const timer = setTimeout(() => dispatch({ type: 'EXPIRED', snapshot }), Math.max(1, Math.min(snapshotExpiry(state.snapshot.snapshotExpiresAt) - Date.now(), 2_147_483_647)))
    return () => clearTimeout(timer)
  }, [state.snapshot])
  useEffect(() => {
    if (state.status !== 'READY' || !state.snapshot || !state.binding || state.snapshot === throttledSnapshot.current) return
    const expected = state.binding
    const expiresAt = snapshotExpiry(state.snapshot.snapshotExpiresAt)
    const timer = setTimeout(() => {
      void renew(expected, expiresAt, Date.now() + RENEW_RETRY_WINDOW_MS)
    }, Math.max(0, Math.min(expiresAt - Date.now() - RENEW_AHEAD_MS, 2_147_483_647)))
    return () => clearTimeout(timer)
  }, [state.status, state.snapshot, state.binding, renew])

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
      verifiedSource.current = { client, requestContext }
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

  const snapshotCurrent = state.snapshot === null || isSnapshotCurrent(state.snapshot, state.binding)
  const acceptedEcho = binding !== null && state.binding !== null && inputKey === permissionBindingKey(state.binding)
  const contextMatches = binding !== null && binding.requestEpoch === epoch && state.requestEpoch === epoch
    && verifiedSource.current?.client === client && verifiedSource.current.requestContext === requestContext
    && (state.inputBindingKey === inputKey || acceptedEcho) && snapshotCurrent
  const value = useMemo<Rbac3AuthorizationContextValue>(() => ({ ...state,
    status: state.status === 'READY' && !contextMatches ? snapshotCurrent ? 'UNINITIALIZED' : 'ERROR_RETRYABLE' : state.status,
    errorCode: !snapshotCurrent ? 'PERMISSION_SNAPSHOT_EXPIRED' : state.errorCode,
    about: contextMatches ? state.about : null, snapshot: contextMatches ? state.snapshot : null,
    binding: contextMatches ? state.binding : null, candidates: contextMatches ? state.candidates : null,
    activeRoles: contextMatches ? state.activeRoles : null, fieldCatalog, resourceRegistry, replaceActiveRoles, retry: initialize,
  }), [state, contextMatches, snapshotCurrent, fieldCatalog, resourceRegistry, replaceActiveRoles, initialize])
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
