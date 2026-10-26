import { copyPermissionSnapshot, isSnapshotCurrent, isPermissionSnapshotContext, permissionContextKey, snapshotExpiry,
  type PermissionSnapshot, type PermissionSnapshotContext } from './permissionSnapshot'

export interface PermissionSnapshotState {
  readonly status: 'EMPTY' | 'LOADING' | 'READY' | 'ERROR'
  readonly snapshot: PermissionSnapshot | null
  readonly bindingKey: string | null
  readonly error: unknown
}
export interface PermissionSnapshotCache {
  getState(): PermissionSnapshotState
  subscribe(listener: () => void): () => void
  load(binding: PermissionSnapshotContext, signal?: AbortSignal, refresh?: boolean): Promise<PermissionSnapshot>
  invalidate(): void
  dispose(): void
}

/** A single bound view. Context changes and every failed refresh discard the previous grant set. */
export const createPermissionSnapshotCache = (fetchSnapshot: (signal: AbortSignal) => Promise<PermissionSnapshot>,
  options: { now?: () => number; cacheTtlMs?: number } = {}): PermissionSnapshotCache => {
  const now = options.now ?? Date.now
  const ttl = options.cacheTtlMs ?? 60_000
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 60_000) throw new TypeError('Permission cache TTL is invalid')
  const listeners = new Set<() => void>()
  let state: PermissionSnapshotState = { status: 'EMPTY', snapshot: null, bindingKey: null, error: null }
  let generation = 0
  let pending: { key: string; controller: AbortController; promise: Promise<PermissionSnapshot> } | null = null
  let expires = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let removeAbortListener: (() => void) | undefined
  const publish = (next: PermissionSnapshotState) => { state = Object.freeze(next); listeners.forEach(listener => listener()) }
  const invalidate = () => {
    generation += 1
    removeAbortListener?.(); removeAbortListener = undefined
    pending?.controller.abort(); pending = null
    clearTimeout(timer); timer = undefined; expires = 0
    publish({ status: 'EMPTY', snapshot: null, bindingKey: null, error: null })
  }
  const load = (binding: PermissionSnapshotContext, signal?: AbortSignal, refresh = false): Promise<PermissionSnapshot> => {
    if (disposed) return Promise.reject(new DOMException('Permission cache is disposed', 'AbortError'))
    if (signal?.aborted) { invalidate(); return Promise.reject(new DOMException('Permission request is cancelled', 'AbortError')) }
    if (!isPermissionSnapshotContext(binding)) return Promise.reject(new TypeError('Permission request context is invalid'))
    const key = permissionContextKey(binding)
    if (state.bindingKey !== key || refresh || (state.status === 'READY' && (now() >= expires || !isSnapshotCurrent(state.snapshot, binding, now())))) invalidate()
    if (!refresh && state.status === 'READY' && state.snapshot && now() < expires && isSnapshotCurrent(state.snapshot, binding, now())) return Promise.resolve(state.snapshot)
    if (pending?.key === key) return pending.promise.then(value => {
      if (signal?.aborted) throw new DOMException('Permission request is cancelled', 'AbortError')
      return value
    })
    const expectedGeneration = generation
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    const assertActive = () => {
      if (disposed || expectedGeneration !== generation || combined.aborted) throw new DOMException('Permission request is superseded', 'AbortError')
    }
    const abort = () => { if (expectedGeneration === generation) invalidate() }
    combined.addEventListener('abort', abort, { once: true })
    removeAbortListener = () => combined.removeEventListener('abort', abort)
    publish({ status: 'LOADING', snapshot: null, bindingKey: key, error: null })
    const promise = Promise.resolve().then(() => { assertActive(); return fetchSnapshot(combined) }).then(snapshot => {
      assertActive()
      if (!isSnapshotCurrent(snapshot, binding, now())) throw new Error('PERMISSION_SNAPSHOT_CONTEXT_MISMATCH_OR_EXPIRED')
      const copy = copyPermissionSnapshot(snapshot)
      expires = Math.min(snapshotExpiry(copy.snapshotExpiresAt), now() + ttl)
      publish({ status: 'READY', snapshot: copy, bindingKey: key, error: null })
      clearTimeout(timer)
      timer = setTimeout(() => { if (expectedGeneration === generation) invalidate() }, Math.max(1, expires - now()))
      return copy
    }).catch(error => {
      if (expectedGeneration === generation && !disposed) {
        clearTimeout(timer); expires = 0
        removeAbortListener?.(); removeAbortListener = undefined
        publish({ status: 'ERROR', snapshot: null, bindingKey: key, error })
      }
      throw error
    }).finally(() => { if (pending?.controller === controller) pending = null })
    pending = { key, controller, promise }
    return promise
  }
  return { getState: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }, load, invalidate,
    dispose: () => { if (disposed) return; invalidate(); disposed = true; listeners.clear() } }
}
