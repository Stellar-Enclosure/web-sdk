import { ApiError } from './errors'
import { appendApiPath, AuthRequestContext, normalizeApiBase } from '../auth/authRequestContext'

export interface ResourceRequestAuthority {
  readonly apiBaseUrl: string
  readonly resource: string
  readonly context: AuthRequestContext
  authorizationHeader(): string
  invalidate(): void
}

interface HttpClientOptions {
  readonly baseUrl: string
  /** 401 ends this authorization. 403 can invalidate the affected permission view. */
  readonly onAuthError?: (status: 401 | 403) => void
  readonly timeout?: number
  readonly fetch?: typeof globalThis.fetch
}

export type HttpClientConfig = HttpClientOptions & (
  { readonly authority: ResourceRequestAuthority; readonly anonymous?: never } |
  { readonly anonymous: true; readonly authority?: never }
)

export interface HttpClient {
  request<T>(path: string, init?: RequestInit, options?: HttpRequestOptions): Promise<T>
  withEventStream<T>(path: string, consume: (response: Response, signal: AbortSignal) => Promise<T>, init?: RequestInit): Promise<T>
}

export interface HttpRequestOptions {
  readonly allowEmptyResponse?: boolean
}

/** A business request is dispatched once with the verified authorization for its API origin. */
export const createHttpClient = (config: HttpClientConfig): HttpClient => {
  const { authority, onAuthError, timeout = 30_000 } = config
  const baseUrl = normalizeApiBase(config.baseUrl)
  if (!baseUrl.startsWith('https://')) throw new TypeError('API base must be an absolute HTTPS URL')
  if ((!authority && config.anonymous !== true) || (authority && config.anonymous !== undefined)) {
    throw new TypeError('Choose a resource authorization or explicitly allow anonymous requests')
  }
  if (authority && normalizeApiBase(authority.apiBaseUrl) !== baseUrl) {
    throw new TypeError('API base does not match its resource authorization')
  }
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120_000) throw new TypeError('HTTP timeout is invalid')
  const context = authority?.context ?? new AuthRequestContext()
  const fetcher = config.fetch ?? globalThis.fetch.bind(globalThis)

  const dispatch = async <T>(
    path: string,
    init: RequestInit,
    accept: 'application/json' | 'text/event-stream',
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const url = appendApiPath(baseUrl, path)
    const headers = new Headers(init.headers)
    if (['Authorization', 'Cookie', 'Proxy-Authorization', 'X-CSRF-TOKEN'].some(name => headers.has(name))) {
      throw new ApiError('Request credentials are managed by the resource client', 0, 'CREDENTIAL_OVERRIDE', { retryable: false })
    }
    const capture = context.capture(init.signal ?? undefined)
    capture.assertCurrent()
    if (authority) headers.set('Authorization', authority.authorizationHeader())
    headers.set('Accept', accept)
    if (shouldSetJsonContentType(init.body) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeout)
    const signal = AbortSignal.any([capture.signal, deadline.signal])
    try {
      const response = await fetcher(url, {
        ...init, credentials: 'omit', headers, signal, redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      })
      capture.assertCurrent()
      signal.throwIfAborted()
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => undefined)
        capture.assertCurrent()
        signal.throwIfAborted()
        if (response.status === 401) {
          if (authority) authority.invalidate()
          else context.invalidate()
          onAuthError?.(401)
        } else if (response.status === 403) {
          onAuthError?.(403)
        }
        throw responseError(response, payload)
      }
      if (accept === 'text/event-stream') {
        const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== accept) throw new ApiError('Response is not an event stream', response.status, 'INVALID_RESPONSE', { retryable: false })
        clearTimeout(timer)
      }
      const value = await consume(response, signal)
      capture.assertCurrent()
      signal.throwIfAborted()
      return value
    } finally {
      clearTimeout(timer)
      deadline.abort()
    }
  }

  const request = <T>(path: string, init: RequestInit = {}, options: HttpRequestOptions = {}): Promise<T> =>
    dispatch(path, init, 'application/json', async response => {
      if (response.status === 204) return undefined as T
      const text = await response.text()
      if (options.allowEmptyResponse && text.trim() === '') return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new ApiError('Response is not valid JSON', response.status, 'INVALID_RESPONSE', { retryable: false })
      }
    })

  return {
    request,
    withEventStream: (path, consume, init = {}) => {
      if (init.method && init.method.toUpperCase() !== 'GET' || init.body != null) {
        throw new TypeError('An event subscription must use GET without a request body')
      }
      return dispatch(path, init, 'text/event-stream', consume)
    },
  }
}

const responseError = (response: Response, payload: unknown): ApiError => {
  const body = isRecord(payload) ? payload : {}
  const nested = isRecord(body.error) ? body.error : body
  const code = typeof nested.code === 'string' ? nested.code : typeof body.status === 'string' ? body.status : 'REQUEST_FAILED'
  const traceId = body.traceId ?? (isRecord(body.meta) ? body.meta.traceId : undefined)
  const decisionId = response.headers.get('X-Permission-Decision-Id')
  return new ApiError(typeof nested.message === 'string' ? nested.message : `Request failed (${response.status})`, response.status, code,
    { requestId: typeof traceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(traceId) ? traceId : undefined,
      decisionId: decisionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decisionId) ? decisionId : undefined })
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const shouldSetJsonContentType = (body: unknown): boolean => {
  if (body === null || body === undefined) return false
  if (typeof body === 'string') {
    try { JSON.parse(body); return true } catch { return false }
  }
  return !(body instanceof FormData || body instanceof URLSearchParams || body instanceof Blob || body instanceof ArrayBuffer)
}
