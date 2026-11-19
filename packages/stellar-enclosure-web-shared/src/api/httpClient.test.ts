import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpClient } from './httpClient'
import { AuthRequestContext } from '../auth/authRequestContext'

const origin = 'https://api.example'
const auth = (context = new AuthRequestContext()) => ({
  apiBaseUrl: origin, resource: origin + '/knowledge', context,
  authorizationHeader: vi.fn().mockReturnValue('Bearer authority-token'),
  invalidate: () => { context.invalidate() },
})
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('createHttpClient', () => {
  it('retains the fixed application API prefix and an explicit anonymous policy', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ saved: true }))
    const client = createHttpClient({ baseUrl: origin + '/api-owner', anonymous: true, fetch: fetcher })
    await expect(client.request('/api/value', { method: 'POST', body: '{"value":1}' })).resolves.toEqual({ saved: true })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(origin + '/api-owner/api/value', expect.objectContaining({ credentials: 'omit', redirect: 'error' }))
    expect(new Headers(fetcher.mock.calls[0]?.[1].headers).has('Authorization')).toBe(false)
  })

  it('rejects foreign origins, caller credentials and a URL outside the selected API', async () => {
    const fetcher = vi.fn()
    const authority = auth()
    expect(() => createHttpClient({ baseUrl: 'https://unregistered.example', fetch: fetcher, authority })).toThrow('API base')
    expect(() => createHttpClient({ baseUrl: origin + '/other-resource', fetch: fetcher, authority })).toThrow('API base')
    const client = createHttpClient({ baseUrl: origin, fetch: fetcher, authority })
    await expect(client.request('/api/value', { headers: { Authorization: 'Bearer caller' } })).rejects.toMatchObject({ code: 'CREDENTIAL_OVERRIDE' })
    await expect(client.request('/api/value', { headers: { Cookie: 'session=caller' } })).rejects.toMatchObject({ code: 'CREDENTIAL_OVERRIDE' })
    await expect(client.request('https://unregistered.example/value')).rejects.toThrow('API path')
    expect(fetcher).not.toHaveBeenCalled()
    expect(authority.authorizationHeader).not.toHaveBeenCalled()
  })

  it('retains a bounded server trace id for domain error adapters', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ code: 'CONFLICT', message: 'changed', traceId: 'trace-123' }, 409))
    const client = createHttpClient({ baseUrl: origin, anonymous: true, fetch: fetcher })
    await expect(client.request('/api/value')).rejects.toMatchObject({ status: 409, code: 'CONFLICT', requestId: 'trace-123' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('accepts an explicitly expected empty 200 response without accepting invalid JSON or errors', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', {status: 200}))
      .mockResolvedValueOnce(new Response('', {status: 200}))
      .mockResolvedValueOnce(new Response('invalid', {status: 200}))
      .mockResolvedValueOnce(new Response('', {status: 403}))
    const client = createHttpClient({baseUrl: origin, anonymous: true, fetch: fetcher})
    await expect(client.request('/api/value/1', {method: 'DELETE'}, {allowEmptyResponse: true})).resolves.toBeUndefined()
    await expect(client.request('/api/value/1', {method: 'DELETE'})).rejects.toMatchObject({code: 'INVALID_RESPONSE'})
    await expect(client.request('/api/value/1', {method: 'DELETE'}, {allowEmptyResponse: true})).rejects.toMatchObject({code: 'INVALID_RESPONSE'})
    await expect(client.request('/api/value/1', {method: 'DELETE'}, {allowEmptyResponse: true})).rejects.toMatchObject({status: 403})
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('retains only a valid opaque decision id from a denied response', async () => {
    const id = '12345678-1234-4234-8234-123456789abc'
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({code: 'AUTHORIZATION_DENIED'}),
      {status: 403, headers: {'X-Permission-Decision-Id': id}})).mockResolvedValueOnce(new Response('{}',
      {status: 403, headers: {'X-Permission-Decision-Id': 'not-a-decision-id'}}))
    const client = createHttpClient({baseUrl: origin, anonymous: true, fetch: fetcher})
    await expect(client.request('/api/value')).rejects.toMatchObject({status: 403, decisionId: id})
    await expect(client.request('/api/value')).rejects.toMatchObject({status: 403, decisionId: undefined})
  })

  it.each([401, 403, 503])('does not replay status %s and separates identity, permission and availability', async status => {
    const fetcher = vi.fn().mockResolvedValue(response({ code: 'REJECTED' }, status))
    const context = new AuthRequestContext(); const onAuthError = vi.fn()
    const client = createHttpClient({ baseUrl: origin, fetch: fetcher, authority: auth(context), onAuthError })
    await expect(client.request('/api/value', { method: 'PUT', body: '{}' })).rejects.toMatchObject({ status })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(context.epoch).toBe(status === 401 ? 1 : 0)
    if (status === 503) expect(onAuthError).not.toHaveBeenCalled()
    else expect(onAuthError).toHaveBeenCalledWith(status)
  })

  it('drops a late JSON body after identity changes even when fetch ignores abort', async () => {
    let finish: (value: unknown) => void = () => undefined
    const body = new Promise(resolve => { finish = resolve })
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => body })
    const context = new AuthRequestContext()
    const client = createHttpClient({ baseUrl: origin, fetch: fetcher, authority: auth(context) })
    const pending = client.request('/api/value').catch(error => error)
    await Promise.resolve()
    context.invalidate(); finish('{"secret":"old-user-result"}')
    expect(await pending).toMatchObject({ name: 'AbortError' })
  })

  it('enforces a deadline even when the caller supplies an un-aborted signal', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('deadline', 'AbortError')), { once: true })
    }))
    const client = createHttpClient({ baseUrl: origin, anonymous: true, fetch: fetcher, timeout: 10 })
    const pending = client.request('/api/value', { signal: new AbortController().signal }).catch(error => error)
    await vi.advanceTimersByTimeAsync(11)
    expect(await pending).toMatchObject({ name: 'AbortError' })
  })
})


describe('direct business Fetch', () => {
  it('sends the active resource Authorization once, with no browser Cookie', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ saved: true }))
    const authorizationHeader = vi.fn().mockReturnValue('Bearer authority-token')
    const context = new AuthRequestContext()
    const authority = { apiBaseUrl: 'https://api.example', resource: 'https://api.example/knowledge',
      context, authorizationHeader, invalidate: () => { context.invalidate() } }
    const config = { baseUrl: 'https://api.example', fetch: fetcher, authority }
    const client = createHttpClient(config)
    await expect(client.request('/api/value', { method: 'POST', body: '{"value":1}' })).resolves.toEqual({ saved: true })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://api.example/api/value', expect.objectContaining({
      credentials: 'omit', redirect: 'error', method: 'POST',
    }))
    expect(new Headers(fetcher.mock.calls[0]?.[1].headers).get('Authorization')).toBe('Bearer authority-token')
    expect(authorizationHeader).toHaveBeenCalledTimes(1)
  })
})


it('passes the cursor and cancels an in-flight event observation on authority change', async () => {
  vi.useFakeTimers()
  const ctx = new AuthRequestContext()
  const fetcher = vi.fn().mockResolvedValue(new Response('data: first\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  const client = createHttpClient({ baseUrl: origin, fetch: fetcher, authority: auth(ctx), timeout: 100 })
  let observe: AbortSignal | undefined
  let finished = () => {}
  const result = client.withEventStream('/api/run/events', async (_response, signal) => {
    observe = signal
    await new Promise<void>(resolve => { finished = resolve })
  }, { headers: { 'Last-Event-ID': '39' } }).catch(error => error)
  await vi.advanceTimersByTimeAsync(150)
  expect(observe?.aborted).toBe(false)
  const headers = new Headers(fetcher.mock.calls[0]?.[1].headers)
  expect(headers.get('Last-Event-ID')).toBe('39')
  expect(headers.get('Authorization')).toBe('Bearer authority-token')
  ctx.invalidate()
  expect(observe?.aborted).toBe(true)
  finished()
  expect(await result).toMatchObject({ name: 'AbortError' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
