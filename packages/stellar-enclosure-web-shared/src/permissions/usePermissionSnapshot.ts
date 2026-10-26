import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AuthRequestContext } from '../auth/authRequestContext'
import { isSnapshotCurrent, isPermissionSnapshotContext, permissionContextKey, type PermissionSnapshot, type PermissionSnapshotContext } from './permissionSnapshot'
import { createPermissionSnapshotCache } from './permissionSnapshotCache'

export const usePermissionSnapshot = (options: {
  binding: PermissionSnapshotContext | null
  requestContext: AuthRequestContext
  fetchSnapshot: (signal: AbortSignal) => Promise<PermissionSnapshot>
}) => {
  const { binding, requestContext, fetchSnapshot } = options
  const epoch = useSyncExternalStore(requestContext.subscribe, () => requestContext.epoch, () => requestContext.epoch)
  const enabled = isPermissionSnapshotContext(binding) && binding.requestEpoch === epoch
  const key = enabled ? permissionContextKey(binding) : null
  const cache = useMemo(() => createPermissionSnapshotCache(fetchSnapshot), [fetchSnapshot])
  const state = useSyncExternalStore(cache.subscribe, cache.getState, cache.getState)
  const refresh = useCallback(async () => {
    if (!binding || !enabled) { cache.invalidate(); return null }
    return cache.load(binding, requestContext.capture().signal, true)
  }, [binding, enabled, cache, requestContext])
  useEffect(() => {
    cache.invalidate()
    if (binding && enabled) void cache.load(binding, requestContext.capture().signal).catch(() => undefined)
    return () => cache.invalidate()
  }, [binding, enabled, key, epoch, cache, requestContext])
  const current = enabled && state.status === 'READY' && state.bindingKey === key && isSnapshotCurrent(state.snapshot, binding)
  const applies = enabled && state.bindingKey === key
  return { status: current ? 'READY' as const : !applies || state.status === 'READY' ? 'EMPTY' as const : state.status,
    snapshot: current ? state.snapshot : null, error: applies ? state.error : null, refresh, invalidate: cache.invalidate }
}
