import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpClient } from './httpClient'
import { AuthRequestContext } from '../auth/authRequestContext'

const proof = () => Promise.resolve({ headerName: 'X-CSRF-TOKEN' as const, token: 'proof', expiresAt: new Date(Date.now() + 60_000).toISOString() })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('createHttpClient', () => {
  it('sends CSRF and Cookies once without dropping the application API prefix', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ saved: true }))
    const csrf = vi.fn(proof)
    const client = createHttpClient({ baseUrl: '/apps/one', credentials: 'include', getCsrf: csrf, fetch: fetcher })
    await expect(client.request('/api/value', { method: 'POST', body: '{"value":1}' })).resolves.toEqual({ saved: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe('/apps/one/api/value')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', redirect: 'error' })
    expect(new Headers(fetcher.mock.calls[0]?.[1].headers).get('X-CSRF-TOKEN')).toBe('proof')
    expect(csrf).toHaveBeenCalledTimes(1)
  })

  it('fails before dispatch on missing CSRF or mixed credentials', async () => {
    const fetcher = vi.fn()
    const client = createHttpClient({ baseUrl: '/apps/one', credentials: 'include', fetch: fetcher })
    await expect(client.request('/api/value', { method: 'POST' })).rejects.toMatchObject({ code: 'CSRF_REQUIRED' })
    await expect(client.request('/api/value', { headers: { Authorization: 'Bearer forbidden' } })).rejects.toMatchObject({ code: 'MIXED_CREDENTIALS' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('retains a bounded server trace id for domain error adapters', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ code: 'CONFLICT', message: 'changed', traceId: 'trace-123' }, 409))
    const client = createHttpClient({ baseUrl: '/apps/one', credentials: 'include', fetch: fetcher })
    await expect(client.request('/api/value')).rejects.toMatchObject({ status: 409, code: 'CONFLICT', requestId: 'trace-123' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 503])('does not replay status %s and separates identity, permission and availability', async status => {
    const fetcher = vi.fn().mockResolvedValue(response({ code: 'REJECTED' }, status))
    const context = new AuthRequestContext(); const onAuthError = vi.fn()
    const client = createHttpClient({ baseUrl: '/apps/one', credentials: 'include', fetch: fetcher, getCsrf: proof, context, onAuthError })
    await expect(client.request('/api/value', { method: 'PUT', body: '{}' })).rejects.toMatchObject({ status })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(context.epoch).toBe(status === 401 ? 1 : 0)
    if (status === 503) expect(onAuthError).not.toHaveBeenCalled()
    else expect(onAuthError).toHaveBeenCalledWith(status)
  })

  it('drops a late JSON body after identity changes even when fetch ignores abort', async () => {
    let finish: (value: unknown) => void = () => undefined
    const body = new Promise(resolve => { finish = resolve })
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => body })
    const context = new AuthRequestContext()
    const client = createHttpClient({ baseUrl: '/apps/one', credentials: 'include', fetch: fetcher, context })
    const pending = client.request('/api/value').catch(error => error)
    await Promise.resolve()
    context.invalidate(); finish({ secret: 'old-user-result' })
    expect(await pending).toMatchObject({ name: 'AbortError' })
  })

  it('enforces a deadline even when the caller supplies an un-aborted signal', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('deadline', 'AbortError')), { once: true })
    }))
    const client = createHttpClient({ baseUrl: '/apps/one', credentials: 'include', fetch: fetcher, timeout: 10 })
    const pending = client.request('/api/value', { signal: new AbortController().signal }).catch(error => error)
    await vi.advanceTimersByTimeAsync(11)
    expect(await pending).toMatchObject({ name: 'AbortError' })
  })
})
