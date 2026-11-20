export const WORKBENCH_PROTOCOL_VERSION = 'workbench-1' as const
export type WorkbenchProtocolVersion = typeof WORKBENCH_PROTOCOL_VERSION

export const WORKBENCH_MAX_PAGES = 256
export const WORKBENCH_MAX_PATH_LENGTH = 2048
export const WORKBENCH_MAX_LABEL_LENGTH = 120

export type WorkbenchPlatformKey =
  | 'tianshu'
  | 'yuheng'
  | 'tianquan-shoubing'
  | 'tianquan-jianshen'
  | 'yaoguang'
  | 'tianji'

export type BridgeErrorCode =
  | 'STALE_INSTANCE'
  | 'VERSION_MISMATCH'
  | 'INVALID_INPUT'
  | 'DENIED'
  | 'NOT_FOUND'
  | 'SUPERSEDED'
  | 'LEAVE_STATE_CHANGED'
  | 'TIMEOUT'

export type BridgeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: BridgeErrorCode }

export type AppCatalogStatus = 'authorizing' | 'ready' | 'denied' | 'failed'

export interface RouteTarget {
  readonly path: string
  readonly search: string
}

export interface AppPageDescriptor {
  readonly pageId: string
  readonly pattern: string
  readonly label: string
  readonly groupKey?: string
  readonly groupLabel?: string
  readonly identityParams: readonly string[]
  readonly queryKeys: readonly string[]
}

export interface AppCatalogUpdate {
  readonly catalogRevision: number
  readonly status: AppCatalogStatus
  readonly pages: readonly AppPageDescriptor[]
}

export type Presentation =
  | {
      readonly mode: 'show'
      readonly navigationId: number
      readonly target: RouteTarget
      readonly tabKey: string
      readonly signal: AbortSignal
    }
  | {
      readonly mode: 'suspend'
      readonly navigationId: number
      readonly signal: AbortSignal
    }
  | {
      readonly mode: 'close'
      readonly navigationId: number
      readonly tabKey: string
      readonly guardRevision: number
      readonly signal: AbortSignal
    }

export type LeaveReason = 'close' | 'logout' | 'tenant-change' | 'reload-app'

export type LeaveCheck =
  | { readonly reason: 'close'; readonly tabKey: string }
  | { readonly reason: 'logout' | 'tenant-change' | 'reload-app'; readonly tabKey?: string }

export type LeaveResult =
  | {
      readonly ok: true
      readonly dirty: boolean
      readonly pendingMutation: boolean
      readonly guardRevision: number
    }
  | { readonly ok: false; readonly code: BridgeErrorCode }

export interface RouteRequest {
  readonly requestId: number
  readonly mode: 'push' | 'replace'
  readonly target: RouteTarget
}

export interface WorkbenchPort {
  readonly version: WorkbenchProtocolVersion
  present(presentation: Presentation): Promise<BridgeResult>
  checkLeave(check: LeaveCheck): LeaveResult
}

export interface WorkbenchHost {
  attach(port: WorkbenchPort): BridgeResult
  reportCatalog(update: AppCatalogUpdate): BridgeResult
  requestNavigation(request: RouteRequest): BridgeResult
}

export const bridgeOk = (): { readonly ok: true } => ({ ok: true })
export const bridgeFail = (code: BridgeErrorCode): { readonly ok: false; readonly code: BridgeErrorCode } => ({
  ok: false,
  code,
})

export const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

export const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const hasControlChars = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return true
  }
  return false
}

const isPlainText = (value: unknown, min = 1, max = WORKBENCH_MAX_LABEL_LENGTH): value is string =>
  typeof value === 'string' && value.trim().length >= min && value.length <= max && !hasControlChars(value)

const hasDoubleEncoding = (value: string): boolean => /%25/i.test(value)

const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

export function validateRelativeRoutePath(path: unknown): string | undefined {
  if (typeof path !== 'string' || path.length === 0 || path.length > WORKBENCH_MAX_PATH_LENGTH) {
    return undefined
  }
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('//')) {
    return undefined
  }
  if (path.includes('\\') || path.includes('?') || path.includes('#') || hasControlChars(path)) {
    return undefined
  }
  if (SCHEME_PREFIX.test(path.slice(1)) || hasDoubleEncoding(path)) {
    return undefined
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return undefined
  }
  if (decoded.includes('\\') || hasControlChars(decoded) || /%[0-9a-f]{2}/i.test(decoded)) {
    return undefined
  }
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return undefined
    }
    try {
      const decodedSegment = decodeURIComponent(segment)
      if (decodedSegment === '.' || decodedSegment === '..' || decodedSegment.includes('/')) {
        return undefined
      }
    } catch {
      return undefined
    }
  }
  return path
}

export function normalizeRouteSearch(search: unknown): string | undefined {
  if (search === undefined || search === '') {
    return ''
  }
  if (typeof search !== 'string' || !search.startsWith('?') || search.length > WORKBENCH_MAX_PATH_LENGTH) {
    return undefined
  }
  if (search.includes('#') || search.includes('\\') || hasControlChars(search) || hasDoubleEncoding(search)) {
    return undefined
  }
  return search === '?' ? '' : search
}

export function normalizeRouteTarget(input: unknown): RouteTarget | undefined {
  if (!input || typeof input !== 'object') {
    return undefined
  }
  const record = input as { readonly path?: unknown; readonly search?: unknown }
  const path = validateRelativeRoutePath(record.path)
  const search = normalizeRouteSearch(record.search)
  if (path === undefined || search === undefined) {
    return undefined
  }
  if (path.length + search.length > WORKBENCH_MAX_PATH_LENGTH) {
    return undefined
  }
  return { path, search }
}

const isValidRoutePattern = (pattern: unknown): pattern is string => {
  const validPath = validateRelativeRoutePath(pattern)
  if (!validPath || validPath.includes('*')) {
    return false
  }
  const segments = validPath.slice(1).split('/').filter(Boolean)
  for (const segment of segments) {
    if (segment.startsWith(':')) {
      if (!/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
        return false
      }
    }
  }
  return true
}

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0 && !hasControlChars(item))

export function validatePageDescriptor(descriptor: unknown): descriptor is AppPageDescriptor {
  if (!descriptor || typeof descriptor !== 'object') {
    return false
  }
  const item = descriptor as Record<string, unknown>
  if (!isPlainText(item.pageId) || !isPlainText(item.label) || !isValidRoutePattern(item.pattern)) {
    return false
  }
  if (item.groupKey !== undefined) {
    if (!isPlainText(item.groupKey) || !isPlainText(item.groupLabel)) {
      return false
    }
  } else if (item.groupLabel !== undefined && !isPlainText(item.groupLabel)) {
    return false
  }
  if (!isStringArray(item.identityParams) || !isStringArray(item.queryKeys)) {
    return false
  }
  return true
}

const VALID_CATALOG_STATUSES: ReadonlySet<string> = new Set<AppCatalogStatus>([
  'authorizing',
  'ready',
  'denied',
  'failed',
])

export function validateAppCatalogUpdate(update: unknown): update is AppCatalogUpdate {
  if (!update || typeof update !== 'object') {
    return false
  }
  const candidate = update as Record<string, unknown>
  if (!isPositiveSafeInteger(candidate.catalogRevision)) {
    return false
  }
  if (typeof candidate.status !== 'string' || !VALID_CATALOG_STATUSES.has(candidate.status)) {
    return false
  }
  if (!Array.isArray(candidate.pages) || candidate.pages.length > WORKBENCH_MAX_PAGES) {
    return false
  }
  if (candidate.status !== 'ready' && candidate.pages.length > 0) {
    return false
  }
  const seenPatterns = new Set<string>()
  for (const page of candidate.pages) {
    if (!validatePageDescriptor(page)) {
      return false
    }
    if (seenPatterns.has(page.pattern)) {
      return false
    }
    seenPatterns.add(page.pattern)
  }
  return true
}

const isAbortSignalLike = (value: unknown): value is AbortSignal =>
  typeof value === 'object' && value !== null && typeof (value as AbortSignal).aborted === 'boolean'

export function validatePresentation(presentation: unknown): presentation is Presentation {
  if (!presentation || typeof presentation !== 'object') {
    return false
  }
  const candidate = presentation as Record<string, unknown>
  if (!isPositiveSafeInteger(candidate.navigationId) || !isAbortSignalLike(candidate.signal)) {
    return false
  }
  if (candidate.mode === 'suspend') {
    return candidate.target === undefined && candidate.tabKey === undefined && candidate.guardRevision === undefined
  }
  if (candidate.mode === 'show') {
    return (
      typeof candidate.tabKey === 'string' &&
      candidate.tabKey.length > 0 &&
      !hasControlChars(candidate.tabKey) &&
      normalizeRouteTarget(candidate.target) !== undefined
    )
  }
  if (candidate.mode === 'close') {
    return (
      typeof candidate.tabKey === 'string' &&
      candidate.tabKey.length > 0 &&
      !hasControlChars(candidate.tabKey) &&
      isNonNegativeSafeInteger(candidate.guardRevision)
    )
  }
  return false
}

const VALID_LEAVE_REASONS: ReadonlySet<string> = new Set<LeaveReason>([
  'close',
  'logout',
  'tenant-change',
  'reload-app',
])

export function validateLeaveCheck(check: unknown): check is LeaveCheck {
  if (!check || typeof check !== 'object') {
    return false
  }
  const candidate = check as Record<string, unknown>
  if (typeof candidate.reason !== 'string' || !VALID_LEAVE_REASONS.has(candidate.reason)) {
    return false
  }
  if (candidate.reason === 'close') {
    return typeof candidate.tabKey === 'string' && candidate.tabKey.length > 0 && !hasControlChars(candidate.tabKey)
  }
  return (
    candidate.tabKey === undefined ||
    (typeof candidate.tabKey === 'string' && candidate.tabKey.length > 0 && !hasControlChars(candidate.tabKey))
  )
}

export function validateRouteRequest(request: unknown): request is RouteRequest {
  if (!request || typeof request !== 'object') {
    return false
  }
  const candidate = request as Record<string, unknown>
  if (!isPositiveSafeInteger(candidate.requestId)) {
    return false
  }
  if (candidate.mode !== 'push' && candidate.mode !== 'replace') {
    return false
  }
  return normalizeRouteTarget(candidate.target) !== undefined
}
