import { ApiError } from './errors'
import { appendApiPath, AuthRequestContext } from '../auth/authRequestContext'
import type { GatewayCsrfResult } from '../auth/gatewayAuthClient'

export interface HttpClientConfig {
  readonly baseUrl: string
  readonly credentials: RequestCredentials
  readonly context?: AuthRequestContext
  readonly getCsrf?: (signal?: AbortSignal) => Promise<GatewayCsrfResult>
  /** 401 invalidates identity; 403 invalidates the affected permission view without logging out. */
  readonly onAuthError?: (status: 401 | 403) => void
  readonly timeout?: number
  readonly fetch?: typeof globalThis.fetch
}

export interface HttpClient {
  request<T>(path: string, init?: RequestInit): Promise<T>
}

/** One request means one business dispatch. This client never refreshes or replays writes. */
export const createHttpClient = (config: HttpClientConfig): HttpClient => {
  const { baseUrl, credentials, onAuthError, timeout = 30_000 } = config
  const context = config.context ?? new AuthRequestContext()
  const fetcher = config.fetch ?? globalThis.fetch.bind(globalThis)
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120_000) throw new TypeError('HTTP timeout is invalid')
  appendApiPath(baseUrl, '/')

  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const url = appendApiPath(baseUrl, path)
    const capture = context.capture(init.signal ?? undefined)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const signal = AbortSignal.any([capture.signal, controller.signal])
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (shouldSetJsonContentType(init.body) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    try {
      if (credentials === 'include') {
        if (headers.has('Authorization')) throw new ApiError('Browser credentials cannot include Authorization', 0, 'MIXED_CREDENTIALS', { retryable: false })
        if (!['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())) {
          if (!config.getCsrf) throw new ApiError('A CSRF proof provider is required', 0, 'CSRF_REQUIRED', { retryable: false })
          const csrf = await config.getCsrf(signal)
          capture.assertCurrent()
          if (csrf.headerName !== 'X-CSRF-TOKEN' || !csrf.token || Date.parse(csrf.expiresAt) <= Date.now()
            || !Number.isFinite(Date.parse(csrf.expiresAt))) throw new ApiError('CSRF proof is invalid', 0, 'CSRF_INVALID', { retryable: false })
          headers.set(csrf.headerName, csrf.token)
        }
      }
      signal.throwIfAborted()
      const response = await fetcher(url, { ...init, credentials, headers, signal, redirect: 'error', cache: 'no-store' })
      capture.assertCurrent()
      signal.throwIfAborted()
      if (response.status === 401) {
        context.invalidate()
        onAuthError?.(401)
      } else if (response.status === 403) onAuthError?.(403)
      if (response.status === 204) return undefined as T
      const payload: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const body = isRecord(payload) ? payload : {}
        const nested = isRecord(body.error) ? body.error : body
        const code = typeof nested.code === 'string' ? nested.code : typeof body.status === 'string' ? body.status : 'REQUEST_FAILED'
        const traceId = body.traceId ?? (isRecord(body.meta) ? body.meta.traceId : undefined)
        const decisionId = response.headers.get('X-Permission-Decision-Id')
        throw new ApiError(typeof nested.message === 'string' ? nested.message : `Request failed (${response.status})`, response.status, code,
          { requestId: typeof traceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(traceId) ? traceId : undefined,
            decisionId: decisionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decisionId) ? decisionId : undefined })
      }
      capture.assertCurrent()
      signal.throwIfAborted()
      if (payload === undefined) throw new ApiError('Response is not valid JSON', response.status, 'INVALID_RESPONSE', { retryable: false })
      return payload as T
    } finally { clearTimeout(timer) }
  }

  return { request }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const shouldSetJsonContentType = (body: unknown): boolean => {
  if (body === null || body === undefined) return false
  if (typeof body === 'string') {
    try { JSON.parse(body); return true } catch { return false }
  }
  return !(body instanceof FormData || body instanceof URLSearchParams || body instanceof Blob || body instanceof ArrayBuffer)
}
