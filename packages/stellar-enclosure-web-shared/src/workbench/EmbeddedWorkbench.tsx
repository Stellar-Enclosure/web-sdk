import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  bridgeFail,
  bridgeOk,
  normalizeRouteTarget,
  validateLeaveCheck,
  validatePresentation,
  WORKBENCH_PROTOCOL_VERSION,
  type AppCatalogStatus,
  type AppPageDescriptor,
  type BridgeResult,
  type LeaveCheck,
  type LeaveResult,
  type Presentation,
  type WorkbenchHost,
  type WorkbenchPort,
} from './contracts'

export interface LeaveGuardState {
  readonly dirty: boolean
  readonly pendingMutation?: boolean
}

export interface EmbeddedWorkbenchContextValue {
  readonly embedded: boolean
  readonly active: boolean
  readonly activeTabKey?: string
  readonly setLeaveGuard: (tabKey: string, state: LeaveGuardState) => void
  readonly clearLeaveGuard: (tabKey: string) => void
  readonly requestNavigation: (
    mode: 'push' | 'replace',
    target: { readonly path: string; readonly search?: string },
  ) => BridgeResult
}

const noopSetLeaveGuard = () => {}
const noopClearLeaveGuard = () => {}
const standaloneRequestNavigation = (): BridgeResult => bridgeFail('STALE_INSTANCE')

const EmbeddedWorkbenchContext = createContext<EmbeddedWorkbenchContextValue>({
  embedded: false,
  active: true,
  setLeaveGuard: noopSetLeaveGuard,
  clearLeaveGuard: noopClearLeaveGuard,
  requestNavigation: standaloneRequestNavigation,
})

export const useEmbeddedWorkbench = (): EmbeddedWorkbenchContextValue => useContext(EmbeddedWorkbenchContext)

export function useWorkbenchLeaveGuard(tabKey: string | undefined, state: LeaveGuardState): void {
  const { setLeaveGuard, clearLeaveGuard } = useEmbeddedWorkbench()
  const dirty = Boolean(state.dirty)
  const pendingMutation = Boolean(state.pendingMutation)

  useEffect(() => {
    if (!tabKey) return
    setLeaveGuard(tabKey, { dirty, pendingMutation })
    return () => {
      clearLeaveGuard(tabKey)
    }
  }, [tabKey, dirty, pendingMutation, setLeaveGuard, clearLeaveGuard])
}

export interface EmbeddedWorkbenchProps {
  readonly host?: WorkbenchHost
  readonly status: AppCatalogStatus
  readonly pages: readonly AppPageDescriptor[]
  readonly onPresent?: (presentation: Presentation) => Promise<BridgeResult> | BridgeResult
  readonly children: ReactNode
}

interface StoredLeaveState {
  readonly dirty: boolean
  readonly pendingMutation: boolean
}

const isSamePresentation = (prev: Presentation | undefined, next: Presentation): boolean => {
  if (!prev || prev.mode !== next.mode || prev.navigationId !== next.navigationId) {
    return false
  }
  if (next.mode === 'suspend') {
    return true
  }
  if (prev.mode === 'show' && next.mode === 'show') {
    return prev.tabKey === next.tabKey && prev.target.path === next.target.path && prev.target.search === next.target.search
  }
  if (prev.mode === 'close' && next.mode === 'close') {
    return prev.tabKey === next.tabKey && prev.guardRevision === next.guardRevision
  }
  return false
}

export function EmbeddedWorkbench({
  host,
  status,
  pages,
  onPresent,
  children,
}: EmbeddedWorkbenchProps) {
  const embedded = host !== undefined
  const [embeddedActive, setEmbeddedActive] = useState(false)
  const [embeddedTabKey, setEmbeddedTabKey] = useState<string | undefined>(undefined)

  const mountedRef = useRef(false)
  const attachedRef = useRef(false)
  const activeHostRef = useRef<WorkbenchHost | undefined>(undefined)
  const portRef = useRef<WorkbenchPort | undefined>(undefined)
  const onPresentRef = useRef(onPresent)
  const activeTabKeyRef = useRef<string | undefined>(undefined)

  const catalogRevisionRef = useRef(0)
  const lastNavigationIdRef = useRef(0)
  const lastPresentationRef = useRef<Presentation | undefined>(undefined)
  const requestIdRef = useRef(0)
  const guardRevisionRef = useRef(0)

  const openedTabsRef = useRef(new Set<string>())
  const leaveRegistryRef = useRef(new Map<string, StoredLeaveState>())
  const inflightAbortRef = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    onPresentRef.current = onPresent
  }, [onPresent])

  useEffect(() => {
    activeTabKeyRef.current = embedded ? embeddedTabKey : undefined
  }, [embedded, embeddedTabKey])

  const buildPort = useCallback((): WorkbenchPort => ({
    version: WORKBENCH_PROTOCOL_VERSION,
    present: async (presentation: Presentation): Promise<BridgeResult> => {
      if (!mountedRef.current || !attachedRef.current) {
        return bridgeFail('STALE_INSTANCE')
      }
      if (!validatePresentation(presentation)) {
        return bridgeFail('INVALID_INPUT')
      }
      if (isSamePresentation(lastPresentationRef.current, presentation)) {
        return bridgeOk()
      }
      if (presentation.navigationId <= lastNavigationIdRef.current) {
        return bridgeFail('SUPERSEDED')
      }
      if (presentation.signal.aborted) {
        return bridgeFail('SUPERSEDED')
      }
      if (presentation.mode === 'close' && presentation.guardRevision !== guardRevisionRef.current) {
        return bridgeFail('LEAVE_STATE_CHANGED')
      }

      lastNavigationIdRef.current = presentation.navigationId
      lastPresentationRef.current = presentation

      inflightAbortRef.current?.abort()
      const localController = new AbortController()
      inflightAbortRef.current = localController

      const onUpstreamAbort = () => localController.abort()
      presentation.signal.addEventListener('abort', onUpstreamAbort, { once: true })

      try {
        if (onPresentRef.current) {
          const linkedPresentation: Presentation = {
            ...presentation,
            signal: localController.signal,
          }
          const handlerResult = await onPresentRef.current(linkedPresentation)
          if (!mountedRef.current || !attachedRef.current) {
            if (lastPresentationRef.current === presentation) {
              lastPresentationRef.current = undefined
            }
            return bridgeFail('STALE_INSTANCE')
          }
          if (presentation.signal.aborted) {
            if (lastPresentationRef.current === presentation) {
              lastPresentationRef.current = undefined
            }
            return bridgeFail('SUPERSEDED')
          }
          if (localController.signal.aborted && lastNavigationIdRef.current !== presentation.navigationId) {
            if (lastPresentationRef.current === presentation) {
              lastPresentationRef.current = undefined
            }
            return bridgeFail('SUPERSEDED')
          }
          if (handlerResult && typeof handlerResult === 'object' && 'ok' in handlerResult && !handlerResult.ok) {
            if (lastPresentationRef.current === presentation) {
              lastPresentationRef.current = undefined
            }
            return handlerResult
          }
        }

        if (!mountedRef.current || !attachedRef.current) {
          if (lastPresentationRef.current === presentation) {
            lastPresentationRef.current = undefined
          }
          return bridgeFail('STALE_INSTANCE')
        }

        if (presentation.mode === 'show') {
          openedTabsRef.current.add(presentation.tabKey)
          setEmbeddedActive(true)
          setEmbeddedTabKey(presentation.tabKey)
        } else if (presentation.mode === 'suspend') {
          setEmbeddedActive(false)
        } else if (presentation.mode === 'close') {
          openedTabsRef.current.delete(presentation.tabKey)
          leaveRegistryRef.current.delete(presentation.tabKey)
          if (activeTabKeyRef.current === presentation.tabKey) {
            setEmbeddedActive(false)
            setEmbeddedTabKey(undefined)
          }
        }
        return bridgeOk()
      } catch {
        if (lastPresentationRef.current === presentation) {
          lastPresentationRef.current = undefined
        }
        if (!mountedRef.current || !attachedRef.current) {
          return bridgeFail('STALE_INSTANCE')
        }
        if (presentation.signal.aborted) {
          return bridgeFail('SUPERSEDED')
        }
        return bridgeFail('INVALID_INPUT')
      } finally {
        presentation.signal.removeEventListener('abort', onUpstreamAbort)
        if (inflightAbortRef.current === localController) {
          inflightAbortRef.current = undefined
        }
      }
    },
    checkLeave: (check: LeaveCheck): LeaveResult => {
      if (!mountedRef.current || !attachedRef.current) {
        return bridgeFail('STALE_INSTANCE')
      }
      if (!validateLeaveCheck(check)) {
        return bridgeFail('INVALID_INPUT')
      }
      if (check.reason === 'close' || check.tabKey !== undefined) {
        const targetTabKey = check.tabKey!
        const registered = leaveRegistryRef.current.get(targetTabKey)
        if (!registered && !openedTabsRef.current.has(targetTabKey)) {
          return bridgeFail('NOT_FOUND')
        }
        return {
          ok: true,
          dirty: registered?.dirty ?? false,
          pendingMutation: registered?.pendingMutation ?? false,
          guardRevision: guardRevisionRef.current,
        }
      }

      let dirty = false
      let pendingMutation = false
      for (const entry of leaveRegistryRef.current.values()) {
        if (entry.dirty) dirty = true
        if (entry.pendingMutation) pendingMutation = true
      }
      return {
        ok: true,
        dirty,
        pendingMutation,
        guardRevision: guardRevisionRef.current,
      }
    },
  }), [])

  useLayoutEffect(() => {
    if (!host) {
      activeHostRef.current = undefined
      portRef.current = undefined
      mountedRef.current = false
      attachedRef.current = false
      return
    }
    if (activeHostRef.current !== host) {
      activeHostRef.current = host
      portRef.current = buildPort()
      catalogRevisionRef.current = 0
      lastNavigationIdRef.current = 0
      lastPresentationRef.current = undefined
      requestIdRef.current = 0
    } else if (!portRef.current) {
      portRef.current = buildPort()
    }

    mountedRef.current = true
    const attachResult = host.attach(portRef.current)
    attachedRef.current = attachResult.ok

    return () => {
      mountedRef.current = false
      attachedRef.current = false
      inflightAbortRef.current?.abort()
      inflightAbortRef.current = undefined
    }
  }, [host, buildPort])

  useEffect(() => {
    if (!host || !mountedRef.current || !attachedRef.current) {
      return
    }
    catalogRevisionRef.current += 1
    host.reportCatalog({
      catalogRevision: catalogRevisionRef.current,
      status,
      pages: status === 'ready' ? pages : [],
    })
  }, [host, status, pages])

  const setLeaveGuard = useCallback((tabKey: string, nextState: LeaveGuardState) => {
    if (!tabKey) return
    const normalized: StoredLeaveState = {
      dirty: Boolean(nextState.dirty),
      pendingMutation: Boolean(nextState.pendingMutation),
    }
    const previous = leaveRegistryRef.current.get(tabKey)
    leaveRegistryRef.current.set(tabKey, normalized)
    const prevDirty = previous?.dirty ?? false
    const prevPending = previous?.pendingMutation ?? false
    if (prevDirty !== normalized.dirty || prevPending !== normalized.pendingMutation) {
      guardRevisionRef.current += 1
    }
  }, [])

  const clearLeaveGuard = useCallback((tabKey: string) => {
    if (!tabKey) return
    const previous = leaveRegistryRef.current.get(tabKey)
    if (!previous) return
    leaveRegistryRef.current.delete(tabKey)
    if (previous.dirty || previous.pendingMutation) {
      guardRevisionRef.current += 1
    }
  }, [])

  const requestNavigation = useCallback(
    (mode: 'push' | 'replace', rawTarget: { readonly path: string; readonly search?: string }): BridgeResult => {
      if (!host || !mountedRef.current || !attachedRef.current) {
        return bridgeFail('STALE_INSTANCE')
      }
      const target = normalizeRouteTarget(rawTarget)
      if (!target) {
        return bridgeFail('INVALID_INPUT')
      }
      requestIdRef.current += 1
      return host.requestNavigation({
        requestId: requestIdRef.current,
        mode,
        target,
      })
    },
    [host],
  )

  const contextValue = useMemo<EmbeddedWorkbenchContextValue>(
    () => ({
      embedded,
      active: embedded ? embeddedActive : true,
      activeTabKey: embedded ? embeddedTabKey : undefined,
      setLeaveGuard,
      clearLeaveGuard,
      requestNavigation,
    }),
    [embedded, embeddedActive, embeddedTabKey, setLeaveGuard, clearLeaveGuard, requestNavigation],
  )

  return (
    <EmbeddedWorkbenchContext.Provider value={contextValue}>
      {children}
    </EmbeddedWorkbenchContext.Provider>
  )
}
